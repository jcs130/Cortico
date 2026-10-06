import { describe, expect, it } from 'vitest';
import { actionEvidence, ACTION_EVIDENCE_MAX_CALLS, ACTION_EVIDENCE_MAX_RECEIPTS } from '../../bots/cortiv/persona/action-evidence.ts';
import { functionCall, functionResult, message } from '../../src/protocol/open-responses/context.ts';

const tools = { act: new Set(['game_execute']), speak: new Set(['perform']), read: new Set(['inspect']) };
const exchange = (id: string, tool: string, args: object, receipt: string) => [
  functionCall(id, tool, JSON.stringify(args), { ts: '2026-01-01T00:00:00Z' }),
  functionResult(id, receipt),
];

describe('action evidence', () => {
  it('keeps spoken plans separate from action requests, with no claim that an older task stopped', () => {
    const records = [message('system', 'environment'),
      ...exchange('p1', 'perform', { script: 'I will go to the river.' }, 'queued'),
      ...exchange('q1', 'inspect', {}, 'position unchanged'),
      ...exchange('p2', 'perform', { script: 'I will look at the river.' }, 'queued')];
    const before = structuredClone(records);
    const note = actionEvidence(records, tools);
    expect(note).toContain('行动 0、发言 2、读取 1');
    expect(note).toContain('较早的任务是否仍在执行');
    expect(records).toEqual(before);
  });

  it('preserves the latest rejected action receipt without declaring acceptance or completion', () => {
    const note = actionEvidence([
      ...exchange('a1', 'game_execute', { destination: 'river' }, 'rejected: destination unavailable'),
      ...exchange('p1', 'perform', { script: 'I will try another route.' }, 'queued'),
    ], tools);
    expect(note).toContain('行动 1、发言 1');
    expect(note).toContain('rejected: destination unavailable');
    expect(note).toContain('请求次数不证明受理、进展或当前忙闲');
    expect(note).toContain('"destination":"river"');
  });

  it('distinguishes a pending receipt and uses declared tags rather than tool-name prefixes', () => {
    const note = actionEvidence([
      ...exchange('p1', 'perform', { script: 'Going.' }, 'queued'),
      ...exchange('unknown', 'game_do', { steps: [] }, 'unknown tool'),
      functionCall('pending', 'game_execute', '{"destination":"home"}'),
    ], tools);
    expect(note).toContain('最近 2 条相关工具请求');
    expect(note).toContain('该请求尚无工具回执');
    expect(note).not.toContain('game_do');
  });

  it('bounds its view and ignores archived prefix calls and receipts', () => {
    const records = [
      functionCall('old', 'game_execute', '{"destination":"old"}', { head: true }),
      functionResult('old', 'old completion', { head: true }),
      ...Array.from({ length: ACTION_EVIDENCE_MAX_CALLS + 2 }, (_, index) =>
        exchange(`p${index}`, 'perform', { script: `line ${index}` }, 'queued')).flat(),
    ];
    const note = actionEvidence(records, tools);
    expect(note).toContain(`最近 ${ACTION_EVIDENCE_MAX_CALLS} 条相关工具请求`);
    expect(note).not.toContain('old completion');
    expect(actionEvidence(exchange('quiet', 'game_execute', {}, 'queued'), tools)).toContain('queued');
  });

  it('retains chronological outcome evidence during silent repeated actions', () => {
    const records = Array.from({ length: ACTION_EVIDENCE_MAX_CALLS + 2 }, (_, index) =>
      exchange(`a${index}`, 'game_execute', { open: index % 2 === 0 }, `observed state ${index}`)).flat();
    const before = structuredClone(records);
    const note = actionEvidence(records, tools);
    expect(note).toContain(`行动 ${ACTION_EVIDENCE_MAX_CALLS}、发言 0`);
    const first = ACTION_EVIDENCE_MAX_CALLS + 2 - ACTION_EVIDENCE_MAX_RECEIPTS;
    expect(note).not.toContain(`observed state ${first - 1}`);
    expect(note.indexOf(`observed state ${first}`)).toBeLessThan(note.indexOf(`observed state ${first + 1}`));
    expect(note).toContain('任务结束不等于目标完成');
    expect(records).toEqual(before);
    expect(actionEvidence(exchange('read-only', 'inspect', {}, 'scene'), tools)).toBe('');
  });
});
