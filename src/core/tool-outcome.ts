import type { Logger, Persona, ToolOutcome } from './types.ts';
import { toolFailed } from './markers.ts';

/** Failed handler results carry the same protocol marker as thrown errors. */
export function toolOutcomeText(outcome: Readonly<ToolOutcome>): string {
  return outcome.failed && !outcome.text.startsWith('[tool failed]')
    ? toolFailed(outcome.text) : outcome.text;
}

/** Persona 的同步补充只改变上下文正文，原工具结果和日志保持不变。 */
export function explainToolOutcome(
  hook: Persona['onToolOutcome'],
  ctx: Parameters<NonNullable<Persona['onToolOutcome']>>[0],
  log: Logger,
): ToolOutcome {
  if (!hook) return ctx.outcome;
  try {
    const explanation = hook(ctx);
    return typeof explanation === 'string' && explanation.length > 0
      ? { ...ctx.outcome, text: `${ctx.outcome.text}\n${explanation}` }
      : ctx.outcome;
  } catch (error) {
    log.warn('onToolOutcome钩子异常', { err: String(error) });
    return ctx.outcome;
  }
}
