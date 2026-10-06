import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiV, RECENT_FILE } from '../../bots/cortiv/persona/persona.ts';
import { DREAM_DEFAULTS } from '../../bots/cortiv/persona/dream-context.ts';
import type { DreamTaskState } from '../../bots/cortiv/persona/dream-task-queue.ts';
import { GenerationError } from '../../src/core/generation.ts';
import { message } from '../../src/protocol/open-responses/context.ts';
import { nullLogger } from '../../src/core/util.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';
import type { FixtureForkOptions } from '../core/fixture-protocol.ts';

const dirs: string[] = [];
const personas: CortiV[] = [];
afterEach(() => {
  for (const persona of personas.splice(0)) persona.stopRhythm();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'dream-runtime-')); dirs.push(dir); return dir; }
const state = async (persona: CortiV): Promise<DreamTaskState> => persona.console().invoke!('dream', 'state', []) as Promise<DreamTaskState>;
const handoff = (persona: CortiV, text: string): Promise<unknown> => persona.onHandoff([message('user', text)], { hardTokens: null });

describe('Dream runtime and real Memory tools', () => {
  it('retains a successful append and does not replay the fork after a generation failure', async () => {
    vi.useFakeTimers();
    const dir = temp();
    const calls: FixtureForkOptions[] = [];
    const persona = new CortiV({ memoryDir: dir }); personas.push(persona);
    persona.attach(makeFakeHarnessApi({ spawnFork: async options => {
      calls.push(options);
      await options.tools!.find(tool => tool.name === 'append_file')!.handler(
        { path: 'session.md', content: '实际成果\n' }, { role: 'dream', log: nullLogger() });
      throw new GenerationError('断流', [], null, { instance: 'test', module: 'test', model: 'test', compatibilityDomain: 'test' });
    } }));
    await handoff(persona, '整理这段经历');
    // Real Memory writes include filesystem and Git work; fake timers do not complete that I/O.
    await vi.waitFor(async () => expect((await state(persona)).lastOutcome?.status).toBe('failed'), { timeout: 10_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(readFileSync(join(dir, 'session.md'), 'utf8')).toBe('实际成果\n');
    expect((await state(persona)).lastOutcome?.error).toContain('断流');
  });

  it('cancels late writes and results on stop; a restarted rhythm accepts a new task', async () => {
    vi.useFakeTimers();
    const calls: FixtureForkOptions[] = [];
    const injected: string[] = [];
    let release!: (text: string) => void;
    const persona = new CortiV({ memoryDir: temp() }); personas.push(persona);
    persona.attach(makeFakeHarnessApi({ injectInternal: (text, kind) => { if (kind === 'dream') injected.push(text); },
      spawnFork: async options => { calls.push(options); return calls.length === 1
        ? new Promise<string>(resolve => { release = resolve; }) : '第二次的整理结论'; } }));
    await handoff(persona, '旧材料'); await vi.advanceTimersByTimeAsync(0);
    persona.stopRhythm(); await vi.advanceTimersByTimeAsync(0);
    expect(calls[0].signal?.aborted).toBe(true);
    await expect(calls[0].tools!.find(tool => tool.name === 'write_file')!.handler(
      { path: 'late.md', content: '迟到' }, { role: 'dream', log: nullLogger() })).rejects.toThrow();
    release('旧材料的迟到结论'); await vi.advanceTimersByTimeAsync(0);
    expect(injected).toEqual([]);
    expect((await state(persona)).lastOutcome?.status).toBe('cancelled');
    persona.startRhythm();
    await handoff(persona, '新材料'); await vi.advanceTimersByTimeAsync(0);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('第二次的整理结论');
    expect((await state(persona)).lastOutcome?.status).toBe('completed');
  });

  it('total timeout suppresses a late conclusion without clearing the current Memory', async () => {
    vi.useFakeTimers();
    const injected: string[] = [];
    let release!: (text: string) => void;
    const persona = new CortiV({ memoryDir: temp(), dream: () => ({ ...DREAM_DEFAULTS, timeoutMs: 50 }) }); personas.push(persona);
    persona.attach(makeFakeHarnessApi({ injectInternal: (text, kind) => { if (kind === 'dream') injected.push(text); },
      spawnFork: async () => new Promise<string>(resolve => { release = resolve; }) }));
    await handoff(persona, '现场材料'); await vi.advanceTimersByTimeAsync(50);
    expect((await state(persona)).lastOutcome?.status).toBe('timedout');
    release('超时结论'); await vi.advanceTimersByTimeAsync(0);
    expect(injected).toEqual([]);
  });

  it('blocks late request preparation from extending a stopped task reading archive', async () => {
    vi.useFakeTimers();
    const dir = temp();
    let captured!: FixtureForkOptions;
    const persona = new CortiV({ memoryDir: dir,
      dream: () => ({ ...DREAM_DEFAULTS, maxContextTokens: 4000, maxReadTokensPerRound: 300 }) }); personas.push(persona);
    persona.attach(makeFakeHarnessApi({ spawnFork: async options => {
      captured = options;
      options.prepareRequest!({ round: 0, messages: [message('user', '第一次的材料')] });
      return new Promise<string>(() => {});
    } }));
    await handoff(persona, '旧材料'); await vi.advanceTimersByTimeAsync(0);
    const archiveDir = join(dir, 'sessions', 'archive');
    const readingFile = readdirSync(archiveDir).find(file => file.startsWith('reading-'))!;
    const before = readFileSync(join(archiveDir, readingFile), 'utf8');
    persona.stopRhythm(); await vi.advanceTimersByTimeAsync(0);
    expect(() => captured.prepareRequest!({ round: 1, messages: [message('user', '迟到材料')] })).toThrow();
    expect(readFileSync(join(archiveDir, readingFile), 'utf8')).toBe(before);
    expect((await state(persona)).lastOutcome?.status).toBe('cancelled');
  });

  it('does not label a foreground update as a Dream-written recent note', async () => {
    const dir = temp();
    const injected: string[] = [];
    const persona = new CortiV({ memoryDir: dir }); personas.push(persona);
    persona.attach(makeFakeHarnessApi({ injectInternal: (text, kind) => { if (kind === 'dream') injected.push(text); },
      spawnFork: async () => {
        await persona.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'write_file')!.handler(
          { path: RECENT_FILE, content: '前台最新事实' }, { role: 'main', log: nullLogger() });
        return '(nothing)';
      } }));
    await handoff(persona, '旧经历');
    await vi.waitFor(async () => expect((await state(persona)).lastOutcome?.status).toBe('completed'), { timeout: 10_000 });
    expect(injected).toEqual([]);
    expect(readFileSync(join(dir, RECENT_FILE), 'utf8')).toBe('前台最新事实');
  });
});
