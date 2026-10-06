import { describe, expect, it } from 'vitest';
import { InspectionGuard } from '../../../src/worlds/minecraft/inspection-guard.ts';
import type { SkillCall } from '../../../src/worlds/minecraft/skills.ts';
import { Executor } from '../../../src/worlds/minecraft/executor.ts';
import { Vec3 } from 'vec3';

const peek = (z: number) => [
  { skill: 'goto', at: [-473, 67, z] },
  { skill: 'use', at: [-473, 67, z] },
] as SkillCall[];

describe('container inspection progress guard', () => {
  it('throttles repeated chest peeks while allowing a different chest and explicit storage actions', () => {
    const guard = new InspectionGuard();
    const at = 100_000;
    const first = peek(-495);
    guard.record(first, 'overworld', [
      { step: 1, outcome: 'ok', line: '到了箱子旁' },
      { step: 2, outcome: 'ok', line: '空手右键了箱子。包里一样没动。箱里:三叉戟×1' },
    ], at);
    expect(guard.block(first, 'overworld', at + 2_000)?.retryAfterMs).toBe(88_000);
    expect(guard.block(peek(-491), 'overworld', at + 2_000)).toBeNull();
    expect(guard.block([{ skill: 'stow', item: 'iron_sword', count: 1,
      at: [-473, 67, -495] }] as SkillCall[], 'overworld', at + 2_000)).toBeNull();
    expect(guard.block(first, 'overworld', at + 90_000)).toBeNull();
  });

  it('does not treat a failed click or a non-container interaction as a completed inspection', () => {
    const guard = new InspectionGuard();
    const steps = peek(-495);
    guard.record(steps, 'overworld', [{ step: 2, outcome: 'fail', line: '箱子打不开' }], 10_000);
    expect(guard.block(steps, 'overworld', 11_000)).toBeNull();
    guard.record(steps, 'overworld', [{ step: 2, outcome: 'ok', line: '按下了石按钮' }], 12_000);
    expect(guard.block(steps, 'overworld', 13_000)).toBeNull();
  });

  it('refuses a repeated inspection at the Executor admission boundary', () => {
    const bot = { entity: { position: new Vec3(-473, 67, -494) },
      game: { dimension: 'minecraft:overworld' } };
    const exec = new Executor({ getBot: () => bot as never, report: () => undefined,
      log: {} as never, nextId: () => 1 });
    const steps = peek(-495);
    (exec as unknown as { inspections: InspectionGuard }).inspections.record(steps, 'minecraft:overworld', [
      { step: 2, outcome: 'ok', line: '右键箱子。箱里:三叉戟×1' },
    ], Date.now());
    const result = exec.submitDetailed(steps);
    expect(result.accepted).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.receipt).toContain('stow/take');
    expect(exec.status().running).toBeNull();
  });
});
