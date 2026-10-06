import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { BREAK_ACL_CHANNEL, BreakPermissions } from '../../../src/worlds/minecraft/break-permissions.ts';
import { skillExcavate } from '../../../src/worlds/minecraft/skills-dig.ts';
import type { SkillCall } from '../../../src/worlds/minecraft/skills.ts';
import { digBlock } from '../../../src/worlds/minecraft/travel.ts';
import type { SkillContext } from '../../../src/worlds/minecraft/skill-context.ts';

const packet = Buffer.from(JSON.stringify({
  v: 1, complete: true, dimension: 'minecraft:overworld', chunkX: -31, chunkZ: -28,
  revision: 1, denyCells: [[-490, 69, -434]], denyBoxes: [],
}));

describe('显式挖掘的权限检查', () => {
  it('挖掘技能在保护格和未同步区块都不发破坏动作', async () => {
    const permissions = new BreakPermissions(null, 'server-a');
    expect(permissions.applyPacket(BREAK_ACL_CHANNEL, packet)).toBe('changed');
    const dig = vi.fn();
    const bot = {
      dig,
      cortiBreakVerdict: (block: { position: { x: number; y: number; z: number }; type: number }) =>
        permissions.verdict('minecraft:overworld', block.position.x, block.position.y, block.position.z, block.type),
    } as unknown as Bot;
    const ctx = {} as SkillContext;
    const protectedBlock = { name: 'stone', type: 1, position: { x: -490, y: 69, z: -434 } } as NonNullable<ReturnType<Bot['blockAt']>>;
    await expect(digBlock(bot, protectedBlock, ctx)).rejects.toThrow('受保护');
    const unsyncedBlock = { name: 'stone', type: 1, position: { x: 0, y: 69, z: 0 } } as NonNullable<ReturnType<Bot['blockAt']>>;
    await expect(digBlock(bot, unsyncedBlock, ctx)).rejects.toThrow('权限尚未');
    expect(dig).not.toHaveBeenCalled();
  });

  it('整片挖掘先检查目标格，遇到已知保护格不动其它方块', async () => {
    const dig = vi.fn();
    const bot = {
      entity: { position: new Vec3(0, 70, 0) },
      blockAt: (position: Vec3) => ({ name: 'stone', type: 1, boundingBox: 'block', position }),
      cortiBreakVerdict: (block: { position: Vec3 }) => block.position.x === 2 ? 'protected' : 'allowed',
      dig,
    } as unknown as Bot;
    const call = { skill: 'excavate', shape: 'line', anchors: [[1, 70, 0], [2, 70, 0]] } as Extract<SkillCall, { skill: 'excavate' }>;
    await expect(skillExcavate(bot, call, {} as SkillContext)).rejects.toThrow('受保护');
    expect(dig).not.toHaveBeenCalled();
  });
});
