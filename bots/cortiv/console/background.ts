/** Browser controls for CortiV.console() planning and dream data surfaces. */
import type { ConsolePanel, ConsolePanelContext } from 'cortico/web/shared/client-panel.ts';
import { errText, stamp } from '../../cormini/console/shared.ts';

interface PlanningState {
  enabled: boolean; provider: string; running: boolean; nextAt: string | null;
  lastStartedAt: string | null; lastFinishedAt: string | null; lastOutcome: string | null;
  lastFailure: { message?: string; [key: string]: unknown } | null;
}
interface Task { id: number; label: string; queuedAt: string; deadlineAt: string; }
interface DreamState {
  enabled: boolean; provider: string; currentTask: Task | null; queuedTasks: Task[];
  lastOutcome: (Task & { status: string; finishedAt: string; error: string | null }) | null;
}
interface RequestResult { accepted: boolean; reason?: string; }

/** Polls only while mounted; failed reads remain visible and requests are explicit operator actions. */
function mount<State>(ctx: ConsolePanelContext, options: {
  title: string; description: string; requestLabel: string;
  details(state: State): Array<{ k: string; v: string | number }>;
  disabled(state: State): boolean;
  request(): Promise<RequestResult>;
}): void {
  const { ui } = ctx;
  const sheet = ui.sheet({ title: options.title, desc: options.description });
  const status = ui.h('div');
  const msg = ui.msgline('读取状态…');
  let reading = false, requesting = false;
  let state: State | null = null;
  const refresh = ui.button('刷新', { onClick: () => { void load(); } });
  const request = ui.button(options.requestLabel, { variant: 'primary', onClick: () => { void submit(); } });
  request.disabled = true;
  const actions = ui.actions(); actions.append(msg, ui.h('span', 'grow'), refresh, request);
  sheet.body.append(status, actions); ctx.root.replaceChildren(sheet.el);
  const load = async (): Promise<void> => {
    if (reading || ctx.signal.aborted) return;
    reading = true;
    try {
      const latest = await ctx.invoke<State>('state');
      if (ctx.signal.aborted) return;
      state = latest; status.replaceChildren(ui.kv(options.details(latest)));
      request.disabled = requesting || options.disabled(latest);
      if (!requesting) { msg.textContent = ''; msg.classList.remove('bad'); }
    } catch (error) {
      if (!ctx.signal.aborted) { msg.textContent = `状态读取失败：${errText(error)}`; msg.classList.add('bad'); request.disabled = true; }
    } finally { reading = false; }
  };
  const submit = async (): Promise<void> => {
    if (requesting || state === null || options.disabled(state) || ctx.signal.aborted) return;
    requesting = true; request.disabled = true;
    try {
      const result = await options.request();
      if (ctx.signal.aborted) return;
      msg.textContent = result.reason ?? (result.accepted ? '请求已受理；结果以运行状态为准。' : '请求未受理。');
      msg.classList.toggle('bad', !result.accepted);
    } catch (error) {
      if (!ctx.signal.aborted) { msg.textContent = `请求失败：${errText(error)}`; msg.classList.add('bad'); }
    } finally { requesting = false; if (!ctx.signal.aborted) request.disabled = state === null || options.disabled(state); }
  };
  void load(); ctx.interval(() => { void load(); }, 30_000);
}

export const planningPanel: ConsolePanel = {
  mount(ctx) {
    mount<PlanningState>(ctx, {
      title: '长期复盘', description: '后台读取近期活动与记忆，提出候选计划。请求受理后由主意识判断是否采用。',
      requestLabel: '请求一次复盘', request: () => ctx.invoke<RequestResult>('review'),
      disabled: state => !state.enabled || state.running,
      details: state => [
        { k: '状态', v: !state.enabled ? '未启用' : state.running ? '运行中' : '空闲' },
        { k: '模型供应商', v: state.provider || '未配置' },
        { k: '下次复盘', v: stamp(state.nextAt) },
        { k: '最近开始', v: stamp(state.lastStartedAt) },
        { k: '最近结束', v: stamp(state.lastFinishedAt) },
        { k: '最近结果', v: state.lastOutcome ?? '—' },
        { k: '最近错误', v: state.lastFailure?.message ?? (state.lastFailure ? JSON.stringify(state.lastFailure) : '—') },
      ],
    });
  },
};

export const dreamPanel: ConsolePanel = {
  mount(ctx) {
    mount<DreamState>(ctx, {
      title: '后台整理', description: '查看整理队列与终态；可手动请求一次观众交流整理。',
      requestLabel: '请求交流整理', request: () => ctx.invoke<RequestResult>('review', [{}]),
      disabled: state => !state.enabled || state.currentTask !== null,
      details: state => [
        { k: '状态', v: !state.enabled ? '未启用' : state.currentTask ? '运行中' : '空闲' },
        { k: '模型供应商', v: state.provider || '继承当前配置' },
        { k: '当前任务', v: state.currentTask?.label ?? '—' },
        { k: '排队任务', v: state.queuedTasks.length },
        { k: '当前截止', v: stamp(state.currentTask?.deadlineAt) },
        { k: '最近结果', v: state.lastOutcome?.status ?? '—' },
        { k: '结束时间', v: stamp(state.lastOutcome?.finishedAt) },
        { k: '最近错误', v: state.lastOutcome?.error ?? '—' },
      ],
    });
  },
};
