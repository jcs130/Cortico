import { describe, expect, it, vi } from 'vitest';
import type { ToolOutcome } from 'cortico/core/types.ts';
import type { MinecraftWorldProxy } from 'cortico/worlds/minecraft/proxy.ts';
import { MYMC_DEFAULTS } from '../src/config.ts';
import { SkillCatalog } from '../src/skill-catalog.ts';
import { MymcWorld } from '../src/world.ts';

function rig(command?: string, id = 'give') {
  const send = vi.fn(async (args: Record<string, unknown>, _ctx: unknown) => `[mc_cast] 已发送 ${JSON.stringify(args)}`);
  const engine = { tools: () => [{ name: 'mc_cast', tags: ['act'], description: 'Cast a server spell',
    parameters: { type: 'object' }, handler: send }] } as unknown as MinecraftWorldProxy;
  const world = new MymcWorld({ cfg: structuredClone(MYMC_DEFAULTS) }, engine);
  const catalog = new SkillCatalog('example.test:25565');
  if (command) catalog.observe(`[MC 系统] MC_SPELL_ITEM ${JSON.stringify({
    id, name: '测试法术', category: 'creation', mana: 4, cooldownMs: 20000, command,
  })}`, '2026-01-01T00:00:00Z');
  Object.assign(world, { catalog });
  const tool = world.tools().find((entry) => entry.name === 'mymc_cast')!;
  return { send, tool, catalog, ctx: { role: 'main', log: {} as never } };
}

describe('千灯纪施法参数按观测目录核对', () => {
  it('returns the observed alternate command instead of inventing a cast alias', async () => {
    const { send, tool, ctx } = rig('/mycli locate tp <玩家名|nearest>', 'team');
    const receipt = await tool.handler({ spell: 'team', arguments: ['Alex'] }, ctx) as ToolOutcome;
    expect(receipt).toMatchObject({ failed: true, text: expect.stringContaining('/mycli locate tp <玩家名|nearest>') });
    expect(receipt.text).toContain('mymc_do');
    expect(send.mock.calls).toEqual([]);
  });

  it('does not send a spell missing a required value in its observed command', async () => {
    const { send, tool, ctx } = rig('/mycli cast give <物品>');
    const receipt = await tool.handler({ spell: 'give' }, ctx) as ToolOutcome;
    expect(receipt).toMatchObject({ failed: true, text: expect.stringContaining('需要至少 1 个参数') });
    expect(receipt.text).toContain('mymc_skills {"id":"give"}');
    expect(receipt.text).toContain('/mycli spells explain give');
    expect(send.mock.calls).toEqual([]);
  });

  it('passes supplied required parameters to the existing engine tool unchanged', async () => {
    const { send, tool, ctx } = rig('/mycli cast give <物品>');
    const args = { spell: 'give', arguments: ['bread'] };
    const receipt = await tool.handler(args, ctx);
    expect(receipt).toContain('[mymc_cast] 已发送');
    expect(send.mock.calls).toEqual([[args, ctx]]);
  });

  it('checks multiple required values while leaving optional placeholders optional', async () => {
    const { send, tool, ctx } = rig('/mycli cast give <物品> <目标> [数量]');
    const short = await tool.handler({ spell: 'give', arguments: ['bread'] }, ctx) as ToolOutcome;
    expect(short).toMatchObject({ failed: true, text: expect.stringContaining('需要至少 2 个参数') });
    expect(send.mock.calls).toEqual([]);
    await tool.handler({ spell: 'give', arguments: ['bread', 'Alex'] }, ctx);
    expect(send.mock.calls).toEqual([[{ spell: 'give', arguments: ['bread', 'Alex'] }, ctx]]);
  });

  it('does not infer argument requirements for a spell absent from the observed directory', async () => {
    const { send, tool, ctx } = rig();
    const args = { spell: 'custom', arguments: ['first', 'second'] };
    await tool.handler(args, ctx);
    expect(send.mock.calls).toEqual([[args, ctx]]);
  });

  it('retains argument-free compatibility for a known spell without required placeholders', async () => {
    const { send, tool, ctx } = rig('/mycli cast give [物品]');
    await tool.handler({ spell: 'give' }, ctx);
    expect(send.mock.calls).toEqual([[{ spell: 'give' }, ctx]]);
  });

  it('rejects extra coordinates for an observed argument-free spell and still sends its valid form', async () => {
    const { send, tool, ctx } = rig('/mycli cast blink', 'blink');
    const receipt = await tool.handler({ spell: 'blink', arguments: ['-559', '63', '-405'] }, ctx) as ToolOutcome;
    expect(receipt).toMatchObject({ failed: true, text: expect.stringContaining('最多接受 0 个参数') });
    expect(receipt.text).toContain('/mycli spells explain blink');
    expect(send.mock.calls).toEqual([]);
    await tool.handler({ spell: 'blink' }, ctx);
    expect(send.mock.calls).toEqual([[{ spell: 'blink' }, ctx]]);
  });

  it('allows an optional selector but rejects a second value', async () => {
    const { send, tool, ctx } = rig('/mycli cast prospect [all|coal|iron]', 'prospect');
    const args = { spell: 'prospect', arguments: ['iron'] };
    await tool.handler(args, ctx);
    const receipt = await tool.handler({ spell: 'prospect', arguments: ['iron', 'extra'] }, ctx) as ToolOutcome;
    expect(receipt.failed).toBe(true);
    expect(send.mock.calls).toEqual([[args, ctx]]);
  });

  it('uses revised command metadata and does not impose a finite cap on variadic forms', async () => {
    const { send, tool, catalog, ctx } = rig('/mycli cast travel', 'travel');
    const args = { spell: 'travel', arguments: ['-559', '63', '-405'] };
    expect(await tool.handler(args, ctx)).toMatchObject({ failed: true });
    for (const command of ['/mycli cast travel <x> <y> <z>', '/mycli cast travel <目标> ...']) {
      catalog.observe(`[MC 系统] MC_SPELL_ITEM ${JSON.stringify({ id: 'travel', name: '测试法术',
        category: 'travel', mana: 4, cooldownMs: 20000, command })}`, '2026-01-01T00:01:00Z');
      await tool.handler(args, ctx);
    }
    expect(send.mock.calls).toEqual([[args, ctx], [args, ctx]]);
  });
});
