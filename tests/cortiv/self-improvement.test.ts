import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CortiV } from '../../bots/cortiv/persona/persona.ts';
import { parseSteps } from '../../src/worlds/minecraft/skills.ts';
import { makeFakeHarnessApi } from '../core/helpers.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe('self-authored movement methods', () => {
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
