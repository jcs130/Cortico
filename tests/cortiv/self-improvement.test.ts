import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { parseSteps } from '../../src/worlds/minecraft/skills.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';
import { methodHarness, methodEnded } from '../worlds/minecraft/method-harness.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('self-authored movement methods', () => {
  it('revises a stored program after real execution failure, verifies changed movement and retrieves the evidence after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'executable-method-')); dirs.push(dir);
    const persona = new CortiV({ memoryDir: dir });
    persona.attach(makeFakeHarnessApi());
    const tools = persona.declareSessions().find(session => session.id === 'main')!.tools();
    const tool = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.handler(args, { role: 'main' } as never);
    const r = methodHarness();
    try {
      r.set(0, 64, -1, 'stone'); r.set(0, 65, -1, 'stone');
      const path = 'methods/local-route.json';
      const code = `const before = await mc.state();
        const outcome = await mc.do([{skill:'control',keys:['forward'],durationMs:500,yawDeg:0,
          expect:{near:params.target,within:1}}]);
        return {before:before.snapshot.position,after:outcome.state.snapshot.position,done:outcome.done,
          taskId:outcome.taskId,kind:outcome.kind};`;
      await tool('write_file', { path, content: JSON.stringify({ verified: false, code }) });
      const original = execFileSync('git', ['log', '-1', '--format=%H', '--', path], { cwd: dir, encoding: 'utf8' }).trim();
      const draft = JSON.parse(readFileSync(join(dir, path), 'utf8'));
      const first = r.runner.start({ name: 'route v1', code: draft.code, params: { target: [0, 64, -2] } });
      const failed = await methodEnded(r, first.id);
      expect(failed.result).toMatchObject({ done: false, kind: 'blocked' });
      expect(await tool('edit_file', { path, old_string: 'yawDeg:0', new_string: 'yawDeg:180' })).toContain('[edited]');
      const revision = JSON.parse(readFileSync(join(dir, path), 'utf8'));
      const second = r.runner.start({ name: 'route v2', code: revision.code, params: { target: [0, 64, 2] } });
      const succeeded = await methodEnded(r, second.id);
      expect(succeeded.result).toMatchObject({ done: true, kind: 'done', taskId: 2 });
      expect(r.bot.entity.position.z).toBeGreaterThan(1.5);
      const evidence = { observedAt: succeeded.endedAt, condition: 'flat ground; north wall; south clear',
        sourceHash: succeeded.sourceHash, previous: failed.result, verifiedResult: succeeded.result };
      await tool('write_file', { path, content: JSON.stringify({ ...revision, verified: true, evidence }) });
      await tool('write_file', { path: 'methods/index.md', content: '- local-route.json: checked local ground route; see evidence conditions.' });
      expect(await tool('git_show', { path, rev: original })).toContain('yawDeg:0');
      const restored = new CortiV({ memoryDir: dir }); restored.attach(makeFakeHarnessApi());
      const read = restored.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'read_file')!;
      const saved = await read.handler({ path }, { role: 'main' } as never);
      expect(saved).toContain(succeeded.sourceHash);
      expect(saved).toContain('"verified":true');
      expect(saved).toContain('"kind":"blocked"');
      expect(saved).toContain('"kind":"done"');
    } finally { r.close(); }
  });

  it('writes, revises, retrieves and versions an executable method through the real Persona tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'movement-method-')); dirs.push(dir);
    const memoryDir = join(dir, 'memory');
    const persona = new CortiV({ memoryDir });
    persona.attach(makeFakeHarnessApi());
    const tools = persona.declareSessions().find(session => session.id === 'main')!.tools();
    const run = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.handler(args, { role: 'main' } as never);
    const path = 'methods/movement.json';
    const draft = JSON.stringify({ verified: false, steps: [{ skill: 'control', keys: ['fly'], durationMs: 500 }] });
    expect(await run('write_file', { path, content: draft })).toContain('[written]');
    expect(parseSteps(JSON.parse(readFileSync(join(memoryDir, path), 'utf8')).steps)).toHaveProperty('error');
    const original = execFileSync('git', ['log', '-1', '--format=%H', '--', path], { cwd: memoryDir, encoding: 'utf8' }).trim();
    expect(await run('edit_file', { path, old_string: '["fly"]', new_string: '["forward","jump"]' })).toContain('[edited]');
    expect(parseSteps(JSON.parse(readFileSync(join(memoryDir, path), 'utf8')).steps)).toMatchObject({ steps: [{ skill: 'control' }] });
    expect(await run('git_show', { path, rev: original })).toContain('["fly"]');
    expect(await run('git_log', { path })).toContain(original.slice(0, 7));

    const restored = new CortiV({ memoryDir });
    restored.attach(makeFakeHarnessApi());
    const read = restored.declareSessions().find(session => session.id === 'main')!.tools().find(tool => tool.name === 'read_file')!;
    const result = await read.handler({ path }, { role: 'main' } as never);
    expect(result).toContain('["forward","jump"]');
    expect(result).toContain('"verified":false');

    const clientSource = join(dir, 'client.ts');
    writeFileSync(clientSource, 'export const unchanged = true;');
    expect(await run('write_file', { path: '../client.ts', content: 'changed' })).toContain('[write failed]');
    expect(readFileSync(clientSource, 'utf8')).toBe('export const unchanged = true;');
    expect(await run('write_file', { path: 'activity-agenda.json', content: '{}' })).toContain('日程管理器');
  });
});
