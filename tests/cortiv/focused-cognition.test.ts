import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiV, COGNITION } from '../../bots/cortiv/persona/persona.ts';
import { FOCUSED_COGNITION, FOCUSED_COGNITION_MAX_OUTPUT_TOKENS,
  FOCUSED_COGNITION_TIMEOUT_MS, focusedCognitionMessages, FocusedCognition,
} from '../../bots/cortiv/persona/focused-cognition.ts';
import type { BlobRef, CognitionContext, ForkOptions } from '../../src/core/types.ts';
import { message, itemText } from '../../src/protocol/open-responses/context.ts';
import { responseRequest } from '../../src/protocol/open-responses/context-helpers.ts';
import { responsesInput } from '../../src/providers/transport/responses-input.ts';
import { withBlobLines, blobLine } from '../../src/core/blobs.ts';
import { makeFakeHarnessApi, makeTool } from '../core/helpers.ts';

const fresh: BlobRef = { handle: 'log:fresh.png', mime: 'image/png', name: '现场.png', fallbackText: '本次第一人称；捕获于10:00。' };
const old: BlobRef = { handle: 'log:old.png', mime: 'image/png', fallbackText: '昨天的建筑。' };
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const context = (patch: Partial<CognitionContext> = {}): CognitionContext => ({ worldId: 'minecraft', tools: [], running: 1, blobs: [fresh], ...patch });

function rig(enabled: () => boolean = () => true) {
  const dir = mkdtempSync(join(tmpdir(), 'cortiv-focused-'));
  dirs.push(dir);
  const persona = new CortiV({ memoryDir: dir, cognitionEnabled: enabled });
  const core = makeFakeHarnessApi();
  const snapshot = [message('system', '主会话长ENV，不应进入看图线程。'.repeat(500)),
    message('user', '旧玩家聊天与昨天的私人物品。', { blobs: [old] })];
  const sessionInfo = vi.fn((id: string) => ({ id, running: 0,
    snapshot: id === 'main' ? snapshot : null, estTokens: null, hardTokens: null }));
  core.sessionInfo = sessionInfo;
  const fork = vi.fn(async (_opts: ForkOptions) => '我能看见右侧入口；左侧被屋檐遮住，不能确认里面的路线。');
  core.spawnFork = fork;
  persona.attach(core);
  sessionInfo.mockClear();
  return { persona, core, fork, sessionInfo, snapshot };
}
const texts = (options: ForkOptions) => options.messages.map(({ item }) => itemText(item)).join('\n');

describe('独立定向认知请求', () => {
  it('声明独立一轮session，默认无工具、不接事件、不持久化，也不改变原shared声明', () => {
    const { persona } = rig();
    const decl = persona.declareSessions().find((entry) => entry.id === FOCUSED_COGNITION)!;
    expect(decl.rounds()).toEqual({ soft: 1, hard: 1 });
    expect(decl.tools()).toEqual([]);
    expect(decl.persistent).toBe(false);
    expect(decl.receivesEvents).toBe(false);
    expect(decl).not.toHaveProperty('spec');
    expect(persona.declareSessions().find((entry) => entry.id === COGNITION)!.rounds()).toEqual({ soft: 6, hard: 8 });
  });

  it('只发短system、本次brief和新图引用，spawn一次，不读取main snapshot或Memory工具', async () => {
    const r = rig();
    const result = await r.persona.cognition.request({ brief: '检查门口是否被屋檐挡住；当前在(1,64,2)，截图10:00。',
      hint: { context: 'task', rounds: 1 } }, context());
    expect(result).toHaveProperty('text');
    expect(r.fork).toHaveBeenCalledTimes(1);
    expect(r.sessionInfo.mock.calls.every(([id]) => id === FOCUSED_COGNITION)).toBe(true);
    const call = r.fork.mock.calls[0][0];
    expect(call.id).toBe(FOCUSED_COGNITION);
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0].item).toMatchObject({ type: 'message', role: 'system' });
    expect(call.messages[1].context.blobs).toEqual([fresh]);
    expect(texts(call)).toContain('当前在(1,64,2)');
    expect(texts(call)).toContain('截图10:00');
    expect(texts(call)).toContain('World minecraft');
    expect(texts(call)).not.toContain('主会话长ENV');
    expect(texts(call)).not.toContain('旧玩家聊天');
    expect(JSON.stringify(call.messages)).not.toContain(old.handle);
    expect(JSON.stringify(call.messages)).not.toContain('data:image');
    expect(call.tools).toEqual([]);
    expect(call.maxOutputTokens).toBe(FOCUSED_COGNITION_MAX_OUTPUT_TOKENS);
    expect(FOCUSED_COGNITION_MAX_OUTPUT_TOKENS).toBe(320);
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call).not.toHaveProperty('provider');
    expect(call).not.toHaveProperty('model');
    expect(call).not.toHaveProperty('nudge');
    expect(call).not.toHaveProperty('incompleteHint');
  });

  it('经过真实Responses图片渲染只读取本次图，base64只出现在这次wire而非context', async () => {
    const r = rig();
    await r.persona.cognition.request({ brief: '看本次现场。', hint: { context: 'task' } }, context());
    const call = r.fork.mock.calls[0][0];
    const bytes = Buffer.from('new-frame-pixels');
    const read = vi.fn((handle: string) => handle === fresh.handle ? bytes : null);
    const rendered = responsesInput(responseRequest({ model: 'qwen-fixture', thinking: false }, call.messages),
      { context: call.messages }, { media: { enabled: () => true, read, imageReplayScope: 'fresh', imageReplayPlacement: 'tail' } });
    expect(read.mock.calls).toEqual([[fresh.handle]]);
    expect(JSON.stringify(rendered.input)).toContain('data:image/png;base64,' + bytes.toString('base64'));
    expect(JSON.stringify(rendered.input)).not.toContain(old.handle);
    expect(JSON.stringify(call.messages)).not.toContain(bytes.toString('base64'));
  });

  it('附件refs拷贝且不读取req原始字节，调用方材料不被修改', () => {
    const ctx = context();
    const before = structuredClone(ctx.blobs);
    const records = focusedCognitionMessages({ brief: '一次观察。', blobs: [{ bytes: new Uint8Array([1, 2, 3]),
      mime: 'image/png', fallbackText: '原字节已由Core保存。' }] }, ctx);
    expect(records[1].context.blobs).toEqual(before);
    expect(records[1].context.blobs).not.toBe(ctx.blobs);
    records[1].context.blobs![0].fallbackText = '外部改变。';
    expect(ctx.blobs).toEqual(before);
    expect(JSON.stringify(records)).not.toContain('"bytes"');
  });

  it('工具面严格遵守本次已校验的ctx.tools，不添加Memory或其它World工具', async () => {
    const r = rig();
    const supplied = makeTool('minecraft_inspect', '仅本次核验');
    await r.persona.cognition.request({ brief: '核验本次材料。', tools: ['minecraft_inspect'], hint: { context: 'task' } }, context({ tools: [supplied] }));
    expect(r.fork.mock.calls[0][0].tools).toEqual([supplied]);
    expect(r.fork.mock.calls[0][0].tools!.map((tool) => tool.name)).not.toContain('read_file');
  });

  it('独立单在途且不排队，忽略shared通道的ctx.running数量，完成后可再受理', async () => {
    const r = rig();
    let finish!: (text: string) => void;
    r.fork.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const first = r.persona.cognition.request({ brief: '第一件。', hint: { context: 'task' } }, context({ running: 2 }));
    const busy = await r.persona.cognition.request({ brief: '第二件。', hint: { context: 'task' } }, context());
    expect(busy).toHaveProperty('error');
    expect(r.fork).toHaveBeenCalledTimes(1);
    finish('第一件的真实结论。');
    expect(await first).toEqual({ text: withBlobLines('第一件的真实结论。', [fresh]) });
    expect(await r.persona.cognition.request({ brief: '第三件。', hint: { context: 'task' } }, context())).toHaveProperty('text');
    expect(r.fork).toHaveBeenCalledTimes(2);
  });

  it('Core记账已有focused实例时直接返回busy，无新增fork', async () => {
    const r = rig();
    r.sessionInfo.mockImplementation((id) => ({ id, running: id === FOCUSED_COGNITION ? 1 : 0, snapshot: null, estTokens: null, hardTokens: null }));
    expect(await r.persona.cognition.request({ brief: '插队。', hint: { context: 'task' } }, context())).toHaveProperty('error');
    expect(r.fork).not.toHaveBeenCalled();
  });

  it('45秒截止时取消真正的模型请求，返回error，底层尚未收束时不启动重叠请求', async () => {
    vi.useFakeTimers();
    const r = rig();
    let finish!: (text: string) => void;
    r.fork.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const pending = r.persona.cognition.request({ brief: '超时任务。', hint: { context: 'task' } }, context());
    const call = r.fork.mock.calls[0][0];
    await vi.advanceTimersByTimeAsync(FOCUSED_COGNITION_TIMEOUT_MS - 1);
    expect(call.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.signal!.aborted).toBe(true);
    expect(call.stopWhen!()).toBe(true);
    expect(await pending).toEqual({ error: '定向认知超时(45秒)，本次没有可用结论' });
    expect(await r.persona.cognition.request({ brief: '不能重叠。', hint: { context: 'task' } }, context())).toHaveProperty('error');
    expect(r.fork).toHaveBeenCalledTimes(1);
    finish('迟来的旧结论不能变为主循环结果。');
    await Promise.resolve();
    expect(await r.persona.cognition.request({ brief: '取消已完成，现在可重试。', hint: { context: 'task' } }, context())).toHaveProperty('text');
    expect(r.fork).toHaveBeenCalledTimes(2);
  });

  it('合成失败返回明示error并释放槽位，下一次有效请求不受影响', async () => {
    const r = rig();
    r.fork.mockRejectedValueOnce(new Error('provider没有图片支持'));
    expect(await r.persona.cognition.request({ brief: '看现场。', hint: { context: 'task' } }, context())).toEqual({ error: '定向认知没有完成:provider没有图片支持' });
    expect(await r.persona.cognition.request({ brief: '重试。', hint: { context: 'task' } }, context())).toHaveProperty('text');
    expect(r.fork).toHaveBeenCalledTimes(2);
  });

  it('空结论和nothing当作失败，不假称已经分析', async () => {
    const r = rig();
    for (const empty of ['  ', '(nothing)']) {
      r.fork.mockResolvedValueOnce(empty);
      expect(await r.persona.cognition.request({ brief: '看现场。', hint: { context: 'task' } }, context())).toHaveProperty('error');
    }
  });

  it('enabled现读关闭时不发请求，缺少Core时也正常返回error', async () => {
    let enabled = true;
    const r = rig(() => enabled);
    enabled = false;
    expect(await r.persona.cognition.request({ brief: '看现场。', hint: { context: 'task' } }, context())).toHaveProperty('error');
    expect(r.fork).not.toHaveBeenCalled();
    expect(await new FocusedCognition().request({ brief: '还没装配。' }, context(), null)).toHaveProperty('error');
  });

  it('不带task hint的原shared构思仍继承main上下文并提供Memory工具', async () => {
    const r = rig();
    await r.persona.cognition.request({ brief: '请设计小屋。' }, context({ blobs: undefined }));
    const call = r.fork.mock.calls[0][0];
    expect(call.id).toBe(COGNITION);
    expect(texts(call)).toContain('主会话长ENV');
    expect(call.tools!.map((tool) => tool.name)).toContain('read_file');
    expect(call).not.toHaveProperty('maxOutputTokens');
  });

  it('不带task hint的通用新附件也挂在本次任务消息上，不能静默丢掉Core归一化后的refs', async () => {
    const r = rig();
    const ctx = context();
    const before = structuredClone(ctx.blobs);
    await r.persona.cognition.request({ brief: '根据本次附件设计改进方案。' }, ctx);
    const task = r.fork.mock.calls[0][0].messages.at(-1)!;
    expect(task.context.blobs).toEqual([fresh]);
    expect(task.context.blobs).not.toBe(ctx.blobs);
    expect(itemText(task.item)).toContain(fresh.handle);
    expect(itemText(task.item)).toContain(fresh.fallbackText);
    expect(ctx.blobs).toEqual(before);
  });

  it('成功主回执仅用text保留本图证据句柄，摘要先截断再追加完整引用，不带bytes/dataURL', async () => {
    const r = rig();
    r.fork.mockResolvedValueOnce('观察结果。'.repeat(500));
    const result = await r.persona.cognition.request({ brief: '看本次现场。', hint: { context: 'task' } }, context());
    if (!('text' in result)) throw new Error('expected success');
    expect(Object.keys(result)).toEqual(['text']);
    expect(result.text).toContain('[结论过长，后续部分未展开]');
    expect(result.text.endsWith(blobLine(fresh))).toBe(true);
    expect(result.text.split(fresh.handle)).toHaveLength(2);
    expect(result.text).toContain(fresh.fallbackText);
    expect(JSON.stringify(result)).not.toContain('"blobs"');
    expect(JSON.stringify(result)).not.toContain('"bytes"');
    expect(JSON.stringify(result)).not.toContain('data:image');
    expect(r.fork.mock.calls[0][0].messages[1].context.blobs).toEqual([fresh]);
    expect(r.fork.mock.calls[0][0].messages).toHaveLength(2);
  });

  it('没有本次附件时成功正文原样返回，不制造来源引用', async () => {
    const r = rig();
    r.fork.mockResolvedValueOnce('本次资料明确，入口在右侧。');
    expect(await r.persona.cognition.request({ brief: '根据本次文字判断。', hint: { context: 'task' } },
      context({ blobs: undefined }))).toEqual({ text: '本次资料明确，入口在右侧。' });
  });

  it('短报告指令限定关注点与1–3句，简单问题不凑字，不重复元数据，详细设计另走共享构思', () => {
    const records = focusedCognitionMessages({ brief: '位置(1,64,2)，截图10:00，检查入口是否可走。' }, context());
    const instruction = itemText(records[0].item);
    expect(instruction).toContain('1–3句');
    expect(instruction).toContain('80–120个中文字');
    expect(instruction).toContain('简单问题直接一句回答，不凑长度');
    expect(instruction).toContain('不重复任务说明已有的时间、位置、尺寸、可见边界');
    expect(instruction).toContain('缺少图像证据时明说');
    expect(instruction).toContain('详细建造设计交给共享构思或原图分析');
    expect(itemText(records[1].item)).toContain('位置(1,64,2)，截图10:00，检查入口是否可走。');
  });
});
