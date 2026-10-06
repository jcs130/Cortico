import { describe, expect, it, vi } from 'vitest';
import type { ToolOutcome } from '../../../src/core/types.ts';
import { MinecraftWorld } from '../../../src/worlds/minecraft/world.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import { observeViewerCastCommands } from '../../../src/worlds/minecraft/viewer-cast.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

function rig() {
  const world = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS), agentFriendEnabled: true });
  const host = new FakeHost();
  const bot = { chat: vi.fn() };
  Object.assign(world, { host, bridge: { bot } });
  const tool = world.tools().find((entry) => entry.name === 'mc_cast')!;
  const castEvents: string[] = [];
  observeViewerCastCommands(bot, (command) => castEvents.push(command));
  return { world, bot, tool, castEvents, ctx: { role: 'main', log: host.log } };
}

describe('mc_cast command arguments', () => {
  it('keeps argument-free spell calls compatible and only confirms sending', async () => {
    const { tool, bot, ctx } = rig();
    const receipt = await tool.handler({ spell: 'food' }, ctx);
    expect(bot.chat.mock.calls).toEqual([['/mycli cast food']]);
    expect(receipt).toContain('已发送 /mycli cast food');
    expect(receipt).toContain('是否生效以服务端回执和现场状态为准');
  });

  it('sends parameterized spells in server order without entering the body queue', async () => {
    const { tool, bot, ctx, castEvents } = rig();
    const receipt = await tool.handler({ spell: 'give', arguments: ['bread', '4'] }, ctx);
    expect(receipt).toContain('已发送 /mycli cast give bread 4');
    expect(bot.chat.mock.calls).toEqual([['/mycli cast give bread 4']]);
    expect(castEvents).toEqual(['/mycli cast give bread 4']);
  });

  it('accepts localized argument tokens and an explicitly empty argument list', async () => {
    const localized = rig();
    await localized.tool.handler({ spell: 'give', arguments: ['面包'] }, localized.ctx);
    expect(localized.bot.chat.mock.calls).toEqual([['/mycli cast give 面包']]);
    const empty = rig();
    await empty.tool.handler({ spell: 'food', arguments: [] }, empty.ctx);
    expect(empty.bot.chat.mock.calls).toEqual([['/mycli cast food']]);
  });

  it.each([
    null, 'bread', {}, [1], [''], ['bread 4'], ['bread\t4'], ['bread\n/msg Alex hi'],
    ['\u0000'], ['\u0085'], ['\u00a7a'], ['\u2028'], ['<物品>'], ['bread>'], ['<bread'],
  ].map((value) => ({ value })))('rejects invalid argument value $value without sending or publishing a cast', async ({ value: argumentsValue }) => {
    const { tool, bot, ctx, castEvents } = rig();
    const receipt = await tool.handler({ spell: 'give', arguments: argumentsValue }, ctx) as ToolOutcome;
    expect(receipt).toMatchObject({ failed: true, text: expect.stringContaining('失败') });
    expect(bot.chat.mock.calls).toEqual([]);
    expect(castEvents).toEqual([]);
  });

  it('rejects an invalid spell identifier as a failed tool result', async () => {
    const { tool, bot, ctx } = rig();
    const receipt = await tool.handler({ spell: 'give bread' }, ctx) as ToolOutcome;
    expect(receipt).toMatchObject({ failed: true, text: expect.stringContaining('spell') });
    expect(bot.chat.mock.calls).toEqual([]);
  });

  it('checks the whole command against the same Minecraft chat length boundary', async () => {
    const prefix = '/mycli cast give ';
    const allowed = rig();
    await allowed.tool.handler({ spell: 'give', arguments: ['a'.repeat(256 - prefix.length)] }, allowed.ctx);
    expect(allowed.bot.chat.mock.calls[0][0]).toHaveLength(256);
    const tooLong = rig();
    const receipt = await tooLong.tool.handler({ spell: 'give', arguments: ['a'.repeat(257 - prefix.length)] }, tooLong.ctx) as ToolOutcome;
    expect(receipt.failed).toBe(true);
    expect(receipt.text).toContain('单条最多');
    expect(tooLong.bot.chat.mock.calls).toEqual([]);
  });

  it('does not cap argument count while a command fits the protocol boundary', async () => {
    const { tool, bot, ctx } = rig();
    const argumentsValue = Array.from({ length: 40 }, () => 'x');
    await tool.handler({ spell: 'custom', arguments: argumentsValue }, ctx);
    expect(bot.chat.mock.calls).toEqual([[`/mycli cast custom ${argumentsValue.join(' ')}`]]);
  });

  it('reports a send exception as failure without publishing a successful command', async () => {
    const { tool, bot, ctx, castEvents } = rig();
    bot.chat.mockImplementation(() => { throw new Error('disconnected'); });
    const receipt = await tool.handler({ spell: 'food' }, ctx) as ToolOutcome;
    expect(receipt).toMatchObject({ failed: true, text: expect.stringContaining('disconnected') });
    expect(castEvents).toEqual([]);
  });

  it('keeps server spell tools unavailable in an ordinary Minecraft World', () => {
    const world = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS) });
    expect(world.tools().some((entry) => entry.name === 'mc_cast')).toBe(false);
  });
});
