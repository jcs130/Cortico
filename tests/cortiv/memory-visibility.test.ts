import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CortiV, RECENT_FILE } from '../../bots/cortiv/persona/persona.ts';
import { FOREGROUND_CONTEXT_DEFAULTS } from '../../bots/cortiv/persona/foreground-context.ts';
import { functionCall, functionResult, itemText, message } from '../../src/protocol/open-responses/context.ts';
import { nullLogger } from '../../src/core/util.ts';

const fixtures: Array<{ dir: string; persona: CortiV }> = [];
afterEach(() => { for (const { dir, persona } of fixtures.splice(0)) {
  persona.stopRhythm(); rmSync(dir, { recursive: true, force: true });
} });
function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'memory-visibility-'));
  const persona = new CortiV({ memoryDir: dir,
    foreground: () => ({ ...FOREGROUND_CONTEXT_DEFAULTS, enabled: true,
      maxHistoryTokens: 8000, memoryFiles: 'goals/projects.md\ngoals/preferences.md' }) });
  fixtures.push({ dir, persona });
  persona.memory.writeFileAtomic('goals/projects.md', '# Plans\n- Make a travel journal for myself, using paper I bought.\n');
  persona.memory.writeFileAtomic('goals/preferences.md', '# Preferences\n- I enjoy keeping my own travel journal.\n');
  persona.memory.writeFileAtomic(RECENT_FILE, '# Recent\n- The merchant sold me paper; this was not a commission.\n');
  persona.memory.writeFileAtomic('sessions/archive/receipt.jsonl', '{"source":"mail","text":"Paper purchase confirmed."}\n');
  const tools = persona.declareSessions().find(session => session.id === 'main')!.tools();
  return { persona, tools, ctx: { role: 'main', log: nullLogger() } };
}
it('reads original goals, preferences and recent prose with their source while retaining explicit history compatibility', async () => {
  const { persona, tools, ctx } = rig(), read = tools.find(tool => tool.name === 'read_file')!;
  for (const path of ['goals/projects.md', 'goals/preferences.md', RECENT_FILE, 'sessions/archive/receipt.jsonl']) {
    const original = persona.memory.readFile(path);
    expect(await read.handler({ path }, ctx)).toContain(original);
    expect(await read.handler({ path, history: true }, ctx)).toContain(original);
    expect(await read.handler({ path }, ctx)).not.toContain('[当前记忆视图；');
  }
});
it('keeps configured long-term purposes and recent experience visible after early dialogue is projected away', () => {
  const { persona } = rig();
  const records = [message('system', 'Stable prefix'), message('user', 'OLD_DIALOGUE_ONLY: my journal is for myself.')];
  for (let index = 0; index < 32; index++) records.push(message('user', 'An unrelated update. '.repeat(100)),
    functionCall('read-' + index, 'mail_read', '{}'), functionResult('read-' + index, 'Unrelated receipt. '.repeat(100)),
    message('assistant', 'An unrelated reply.'));
  records.push(message('user', 'The merchant has delivered the paper.'));
  const projected = persona.prepareRequest({ sessionId: 'main', round: 33, messages: records })!;
  const text = projected.map(row => itemText(row.item)).join('\n');
  expect(projected.length).toBeLessThan(records.length);
  expect(text).not.toContain('OLD_DIALOGUE_ONLY');
  expect(text).toContain('Make a travel journal for myself');
  expect(text).toContain('I enjoy keeping my own travel journal');
  expect(text).toContain('The merchant sold me paper');
  expect(text).toContain('旧读数和进展须与较新 World 回执核验');
  expect(itemText(records[1].item)).toContain('OLD_DIALOGUE_ONLY');
});
