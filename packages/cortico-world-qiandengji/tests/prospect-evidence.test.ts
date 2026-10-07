import { describe, expect, it } from 'vitest';
import { ProspectEvidence } from '../src/prospect-evidence.ts';

describe('server prospect evidence', () => {
  const at = '2026-10-02T10:00:00+08:00';
  const now = Date.parse(at) + 1_000;

  it('keeps an explicit server target from being disproved by a hidden client chunk', () => {
    const evidence = new ProspectEvidence();
    evidence.observe('[MC 系统] 探矿术找到铁矿：dimension=minecraft:overworld X=-500 Y=56 Z=-460 ore=minecraft:iron_ore', at);
    const reason = evidence.redundantProbe({ steps: [{ skill: 'probe', shape: 'box',
      where: ['minecraft:iron_ore'], anchors: [[-501, 55, -461], [-499, 57, -459]] }] }, now);
    expect(reason).toContain('(-500,56,-460)');
    expect(reason).toContain('保护预检');
  });

  it('does not block unrelated scans or stale coordinates', () => {
    const evidence = new ProspectEvidence();
    evidence.observe('探矿术找到铁矿：dimension=minecraft:overworld X=-500 Y=56 Z=-460 ore=minecraft:iron_ore', at);
    const scan = { steps: [{ skill: 'probe', shape: 'box', where: ['minecraft:coal_ore'],
      anchors: [[-501, 55, -461], [-499, 57, -459]] }] };
    expect(evidence.redundantProbe(scan, now)).toBeNull();
    scan.steps[0].where = ['minecraft:iron_ore'];
    expect(evidence.redundantProbe(scan, now + 5 * 60_000)).toBeNull();
  });
});
