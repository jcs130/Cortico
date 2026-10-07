import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../../src/core/util.ts';
import { MINECRAFT_DEFAULTS } from '../../../src/worlds/minecraft/config.ts';
import {
  parseSteps, readSkillHelp, SKILL_DOC, SKILL_HELP_MAX_SKILLS,
  SKILL_NAMES, SKILL_SIGNATURE_DOC, SKILL_STEP_SCHEMA,
} from '../../../src/worlds/minecraft/skills.ts';
import { MinecraftWorld, MINECRAFT_TOOL_DECLS } from '../../../src/worlds/minecraft/world.ts';
import { FakeHost } from '../../helpers/fake-host.ts';

function helpText(args: Record<string, unknown>): string {
  const result = readSkillHelp(args);
  if ('error' in result) throw new Error(result.error);
  return result.text;
}

describe('Minecraft action skill help', () => {
  it('keeps every registered action in the compact directory and parameter schema', () => {
    const directory = helpText({});
    const names = directory.split('\n').flatMap((line) => /^([a-z_]+)\(/.exec(line)?.[1] ?? []);
    expect(names).toEqual(SKILL_NAMES);
    expect((SKILL_STEP_SCHEMA.properties as any).skill.enum).toEqual(SKILL_NAMES);
    expect(directory).toContain('goto(at*,dimension?,exact?,walkOnly?,dryRun?)');
    expect(directory).toContain('chat(text*)');
    expect(directory).toContain('fish(at?)');
    expect(directory).toContain('use(item?,at?,target?');
  });

  it('reads each original complete action document without another action document', () => {
    for (const skill of SKILL_NAMES) {
      const text = helpText({ skill });
      const document = text.slice('技能完整说明:\n'.length, text.indexOf('\n坐标写成'));
      expect(document).not.toBe('');
      expect(SKILL_DOC).toContain(document);
      expect(document).toContain(`"skill":"${skill}"`);
    }
    const fishing = helpText({ skill: 'fish' });
    expect(fishing).toContain('从干燥岸上抛竿');
    expect(fishing).not.toContain('"skill":"brew"');
  });

  it('returns complete documents in requested order for a bounded selection', () => {
    const text = helpText({ skills: ['chat', 'goto', 'use'] });
    expect(text.indexOf('"skill":"chat"')).toBeLessThan(text.indexOf('"skill":"goto"'));
    expect(text.indexOf('"skill":"goto"')).toBeLessThan(text.indexOf('"skill":"use"'));
    expect(text).toContain('不收换行或控制字符');
    expect(text).toContain('给 at 且不写 item = 腾空主手');
    expect(text).toContain('指定楼层或高度,请给完整 [x,y,z]');
  });

  it('rejects unknown, mixed and malformed requests without returning a partial document', () => {
    expect(readSkillHelp({ skill: 'not_a_skill' })).toHaveProperty('error');
    expect(readSkillHelp({ skills: ['goto', 'not_a_skill'] })).toHaveProperty('error');
    expect(readSkillHelp({ skill: 'goto', skills: ['use'] })).toHaveProperty('error');
    expect(readSkillHelp({ skill: 1 })).toHaveProperty('error');
    expect(readSkillHelp({ skills: 'goto' })).toHaveProperty('error');
    expect(readSkillHelp({ skills: Array(SKILL_HELP_MAX_SKILLS + 1).fill('goto') })).toHaveProperty('error');
  });

  it('reduces the resident action manual while retaining the same execution schema', () => {
    const resident = (MINECRAFT_TOOL_DECLS.find((tool) => tool.name === 'mc_do')!
      .parameters.properties as any).steps;
    expect(resident.items).toBe(SKILL_STEP_SCHEMA);
    expect(resident.description).toBe(SKILL_SIGNATURE_DOC);
    expect(resident.description.length).toBeLessThan(SKILL_DOC.length / 3);
    expect(estimateTokens(resident.description)).toBeLessThan(estimateTokens(SKILL_DOC) / 3);
    expect((MINECRAFT_TOOL_DECLS.find((tool) => tool.name === 'mc_scout')!
      .parameters.properties as any).steps.description).toContain('mc_help');
  });

  it('keeps common action parameters valid including optional use and fishing forms', () => {
    const parsed = parseSteps([
      { skill: 'goto', at: [100, -20] },
      { skill: 'use', at: [101, 64, -20] },
      { skill: 'use', item: 'cod', target: 'cat' },
      { skill: 'fish' },
      { skill: 'chat', text: '你好' },
      { skill: 'build', blueprint: 'house', at: [100, 64, -20] },
    ]);
    expect(parsed).not.toHaveProperty('error');
    if ('steps' in parsed) expect(parsed.steps.map((step) => step.skill))
      .toEqual(['goto', 'use', 'use', 'fish', 'chat', 'build']);
  });

  it('answers through the read-only World tool without a connection or executor', async () => {
    const world = new MinecraftWorld({ cfg: structuredClone(MINECRAFT_DEFAULTS) });
    const help = world.tools().find((tool) => tool.name === 'mc_help')!;
    const host = new FakeHost();
    expect(help.tags).toEqual(['read']);
    expect(await help.handler({ skill: 'chat' }, { role: 'main', log: host.log }))
      .toContain('"skill":"chat"');
    expect(await help.handler({ skill: 'not_a_skill' }, { role: 'main', log: host.log }))
      .toMatchObject({ failed: true, text: expect.stringContaining('未知技能') });
    expect(host.events).toHaveLength(0);
  });
});
