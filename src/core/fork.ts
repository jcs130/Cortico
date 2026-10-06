import type { ForkOptions, Logger, ModelSpec, Persona, ToolCallContext, ToolDef } from './types.ts';
import { explainToolOutcome, toolOutcomeText } from './tool-outcome.ts';
import type { SessionHandle } from './sessions.ts';
import { message, functionResult, responseRecords, type ContextRecord } from '../protocol/open-responses/context.ts';
import { responseRequest, textOf } from '../protocol/open-responses/context-helpers.ts';
import { ResponseAccumulator } from '../protocol/open-responses/stream.ts';
import { GenerationError, type ResponseClient } from './generation.ts';
import type { GenerationScheduler } from './generation-scheduler.ts';
import { validateRequestContext } from './request-context.ts';
import {
  NOT_EXECUTED_BARRIER,
  NOT_EXECUTED_INCOMPLETE,
  NOT_EXECUTED_THREAD_ENDED,
  forkUnknownTool,
  toolFailed,
} from './markers.ts';

export interface ForkLoopOptions {
  id: string;
  llm: ResponseClient;
  spec: ModelSpec;
  messages: ContextRecord[];
  tools: ToolDef[];
  maxRounds: number;
  softRounds?: number;
  log: Logger;
  stopWhen?: () => boolean;
  signal?: AbortSignal;
  generationScheduler?: GenerationScheduler;
  generationResource?: string;
  generationWaitTimeoutMs?: number;
  prepareRequest?: ForkOptions['prepareRequest'];
  wrapUpHint?: string;
  incompleteHint?: string;
  capNote?: string;
  nudge?: { when: (lastContent: string) => boolean; message: string };
  track?: SessionHandle;
  observeMessages?: (messages: ContextRecord[]) => void;
  onToolOutcome?: Persona['onToolOutcome'];
}

/** The caller hands the fork a client already bound to one provider instance; the Item sequence is retained across tool rounds. */
/** fork 工具回执不经主循环，单独限制体积。 */
const FORK_RECEIPT_HARD_CAP_CHARS = 20_000;

export async function runForkLoop(opts: ForkLoopOptions): Promise<string> {
  const { id, llm, spec, tools, maxRounds, log } = opts;
  const messages = [...opts.messages];
  const observed = [...messages];
  opts.observeMessages?.(observed);
  const ctx: ToolCallContext = { role: id, log };
  const schemas = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const wrapUpAt = Math.min(Math.max(1, opts.softRounds ?? maxRounds - 1), Math.max(1, maxRounds - 1));
  const wrapUpHint = opts.wrapUpHint ?? 'Wrap up: give your conclusion next round, no more tool calls.';
  let lastContent = '';
  let endedByTool = false;
  const runRound = async (round: number): Promise<'done' | 'continue'> => {
    opts.signal?.throwIfAborted();
    const settledLength = observed.length;
    let generated;
    while (true) {
      const lease = opts.generationScheduler
        ? await opts.generationScheduler.background(opts.generationResource!, opts.signal!, opts.generationWaitTimeoutMs)
        : undefined;
      let draft = new ResponseAccumulator();
      let outbound = messages;
      if (opts.prepareRequest) {
        try {
          const prepared = opts.prepareRequest({ round, messages: structuredClone(messages) });
          if (prepared != null) { validateRequestContext(prepared); outbound = prepared; }
        } catch (error) {
          log.warn('prepareRequest 失败,本轮使用完整上下文', { error: String(error) });
        }
      }
      try {
        generated = await llm.respond(responseRequest(spec, outbound, schemas), {
          role: id, sessionId: id, context: outbound, nativeSpec: spec, signal: lease?.signal ?? opts.signal,
          onEvent: event => {
            if (lease?.signal.aborted || opts.signal?.aborted) return;
            if (event.type === 'response.created') draft = new ResponseAccumulator();
            draft.accept(event);
            const snapshot = draft.snapshot();
            if (snapshot) {
              observed.splice(settledLength, observed.length - settledLength, ...snapshot.output.map(item => ({ version: 2 as const, item, context: { responseId: snapshot.id } })));
            }
          },
        });
        if (!lease?.yielded()) break;
        opts.track?.recordAttempts(generated.attempts, observed, { outcome: 'discarded' });
      } catch (error) {
        if (error instanceof GenerationError) opts.track?.recordAttempts(error.attempts, observed);
        if (!lease?.yielded() || opts.signal?.aborted) throw error;
      } finally {
        lease?.release();
      }
      opts.signal?.throwIfAborted();
      observed.splice(settledLength);
      log.info('后台模型轮让出前台，保留已完成上下文后重试', { round });
    }
    const output = responseRecords(generated.response, generated.origin);
    messages.push(...output);
    observed.splice(settledLength, observed.length - settledLength, ...output);
    opts.track?.recordAttempts(generated.attempts, observed);
    const text = output.filter(entry => entry.item.type === 'message').map(textOf).join('');
    if (text) lastContent = text;
    const calls = generated.response.output.filter(item => item.type === 'function_call');
    if (!calls.length) {
      opts.signal?.throwIfAborted();
      if (generated.response.status === 'incomplete' && opts.incompleteHint) {
        const reminder = message('user', opts.incompleteHint);
        messages.push(reminder); observed.push(reminder);
        return 'continue';
      }
      return 'done';
    }
    const skipRemaining = (from: number): void => {
      for (const skipped of calls.slice(from)) {
        const receipt = functionResult(skipped.call_id, NOT_EXECUTED_THREAD_ENDED);
        messages.push(receipt); observed.push(receipt);
      }
    };
    const checkAbort = (from: number): void => {
      if (!opts.signal?.aborted) return;
      skipRemaining(from);
      opts.signal.throwIfAborted();
    };
    let barrier = false;
    for (const [index, call] of calls.entries()) {
      checkAbort(index);
      const def = tools.find(tool => tool.name === call.name);
      let out: string;
      let ended = false;
      if (barrier) out = NOT_EXECUTED_BARRIER;
      else if (call.status !== 'completed') { out = NOT_EXECUTED_INCOMPLETE; barrier = true; }
      else if (!def) out = forkUnknownTool(call.name);
      else {
        try {
          const args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
          const result = await def.handler(args, { ...ctx, callId: call.call_id });
          const outcome = typeof result === 'string' ? { text: result } : result;
          ended = def.endsTurn === true || outcome.endsTurn === true;
          out = toolOutcomeText(explainToolOutcome(opts.onToolOutcome, { role: id, tool: call.name, args, outcome }, log));
        } catch (error) { out = toolFailed(error instanceof Error ? error.message : String(error)); }
        if (def.barrierAfter) barrier = true;
      }
      if (round === wrapUpAt) out += `\n[system] ${wrapUpHint}`;
      if (out.length > FORK_RECEIPT_HARD_CAP_CHARS) {
        out = `${out.slice(0, FORK_RECEIPT_HARD_CAP_CHARS)}\n…[fork 回执截断至 ${FORK_RECEIPT_HARD_CAP_CHARS} 字符;完整内容请重调工具]`;
      }
      const receipt = functionResult(call.call_id, out);
      messages.push(receipt); observed.push(receipt);
      checkAbort(index + 1);
      if (ended || opts.stopWhen?.()) {
        endedByTool ||= ended;
        skipRemaining(index + 1);
        return 'done';
      }
    }
    return 'continue';
  };
  let finished = false;
  for (let round = 1; round <= maxRounds; round++) {
    if (await runRound(round) === 'done') { finished = true; break; }
  }
  if (!finished) log.warn('工具循环达到硬上限,取最后内容为结果', { maxRounds });
  if (opts.nudge && !endedByTool && !opts.stopWhen?.() && opts.nudge.when(lastContent)) {
    const reminder = message('user', opts.nudge.message);
    messages.push(reminder); observed.push(reminder);
    await runRound(maxRounds);
  }
  if (!finished && opts.capNote) lastContent = lastContent ? `${lastContent}\n\n${opts.capNote}` : opts.capNote;
  return lastContent;
}
