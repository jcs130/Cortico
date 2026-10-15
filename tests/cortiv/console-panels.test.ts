import { expect, it, vi } from 'vitest';
const CLIENT = '../../bots/cortiv/console/client.ts';
const UI = '../../src/web/client/ui/index.ts';
const JSDOM_MODULE = 'jsdom';
async function mounted(id: 'planning' | 'dream', initial: unknown) {
  const { JSDOM } = await import(JSDOM_MODULE);
  const { default: bundle } = await import(CLIENT);
  const { createConsoleUi } = await import(UI);
  const dom = new JSDOM('<main></main>');
  const controller = new dom.window.AbortController();
  const root = dom.window.document.querySelector('main')!;
  const memo = { get: (_key: string, fallback: unknown) => fallback, set: () => {} };
  const invoke = vi.fn(async (method: string) => method === 'state' ? initial : { accepted: true });
  const interval = vi.fn();
  const ctx = { root, signal: controller.signal, ui: createConsoleUi({ memo, overlayHost: dom.window.document.body, signal: controller.signal }), invoke, interval };
  await bundle.panels[id].mount(ctx);
  await vi.waitFor(() => expect(root.textContent).not.toContain('读取状态…'));
  return { root, invoke, interval, controller };
}

it('shows actual planning status without starting a model, and distinguishes manual admission from completion', async () => {
  const r = await mounted('planning', { enabled: true, running: false, provider: 'fixture', nextAt: null, lastStartedAt: null, lastFinishedAt: null, lastOutcome: 'failed', lastFailure: { message: 'fixture failure' } });
  expect(r.root.textContent).toContain('fixture failure'); expect(r.invoke.mock.calls.map(c => c[0])).toEqual(['state']);
  const button = [...r.root.querySelectorAll('button')].find(b => b.textContent === '请求一次复盘')!;
  button.click(); await vi.waitFor(() => expect(r.root.textContent).toContain('请求已受理；结果以运行状态为准。'));
  expect(r.invoke.mock.calls.map(c => c[0])).toEqual(['state', 'review']);
  r.controller.abort(); await r.interval.mock.calls[0][0](); expect(r.invoke).toHaveBeenCalledTimes(2);
});

it('keeps dream queue failures visible and prevents actions on a disposed panel', async () => {
  const r = await mounted('dream', { enabled: true, provider: '', currentTask: null, queuedTasks: [{ id: 1 }], lastOutcome: { status: 'timedout', error: 'budget elapsed', finishedAt: null } });
  expect(r.root.textContent).toContain('budget elapsed'); expect(r.root.textContent).toContain('timedout');
  r.controller.abort(); const button = [...r.root.querySelectorAll('button')].find(b => b.textContent === '请求交流整理')!;button.click();
  expect(r.invoke.mock.calls.map(c => c[0])).toEqual(['state']);
});
