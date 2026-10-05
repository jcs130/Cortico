import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorkspaceMemory } from '../../bots/cormini/persona/memory.ts';
import { ReferenceLibrary, REFERENCE_LIBRARY_DEFAULTS, REFERENCE_CATALOG_MAX_TOKENS,
  type ReferenceLibraryConfig } from '../../bots/cortiv/persona/reference-library.ts';
import { estimateTokens } from '../../src/core/util.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function activity(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: `活动 ${id}`, requires: '获准地点与材料', firstStep: '先观察目标状态', verify: '实际回执与新观察',
    leaveWhen: '条件不成立时留回访线索', capability: '基础操作可用，具体活动待实测', sourceIds: ['source-a'],
    provenance: '参考资料设计，尚未执行，不是亲历记忆', ...extra };
}

function rig(config: Partial<ReferenceLibraryConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cortico-reference-')); roots.push(root);
  const memory = new GitWorkspaceMemory({ memoryDir: root });
  const cfg = { ...REFERENCE_LIBRARY_DEFAULTS, enabled: true, indexFiles: 'references/example/index.json', ...config };
  const put = (file: string, value: unknown) => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), JSON.stringify(value));
  };
  const index = (categories = [
    { file: 'references/example/life.json', ideas: '认识动物、照料园地' },
    { file: 'references/example/build.json', ideas: '用手头材料建一个休息处' },
  ]) => put('references/example/index.json', { kind: 'imported_reference_index', version: 'example version', categories });
  index();
  put('references/example/life.json', { activities: [activity('garden'), activity('animal'), activity('picnic'), activity('walk')] });
  put('references/example/build.json', { activities: [activity('shelter')] });
  put('references/example/sources.json', { 'source-a': { title: 'Reference', url: 'https://example.invalid/reference' } });
  const reads: string[] = [];
  const library = new ReferenceLibrary({ config: () => cfg, normalize: path => memory.normalize(path),
    read: path => { reads.push(path); return memory.readFile(path); }, canonicalPath: path => realpathSync(memory.insideWorkspace(path)) });
  return { root, memory, cfg, put, index, library, reads };
}

describe('Persona reference library', () => {
  it('exposes directions from explicit indexes without preloading activity or source documents', () => {
    const r = rig();
    const topics = r.library.descriptors();
    expect(topics).toHaveLength(2);
    expect(topics[0]).toMatchObject({ file: 'references/example/life.json', indexFile: r.cfg.indexFiles, summary: '认识动物、照料园地' });
    const catalog = r.library.catalog();
    expect(catalog).toContain(topics[0].key);
    expect(catalog).toContain('不是亲历或已学会的证明');
    expect(estimateTokens(catalog)).toBeLessThanOrEqual(REFERENCE_CATALOG_MAX_TOKENS);
    expect(new Set(r.reads)).toEqual(new Set([r.cfg.indexFiles]));
  });

  it('pages small cards and replaces the retained view when an activity or another direction is opened', () => {
    const r = rig();
    const [life, build] = r.library.descriptors();
    const cards = r.library.guides(life.key, 0, 2);
    expect(cards).toContain('garden：活动 garden');
    expect(cards).toContain('animal：活动 animal');
    expect(cards).not.toContain('picnic：活动 picnic');
    expect(cards).toContain('下一页 offset=2');
    expect(r.library.selected()).toEqual({ topicKey: life.key });
    expect(r.library.guides(life.key, 2, 2)).toContain('已到末页');
    const detail = r.library.detail(life.key, 'animal');
    expect(detail).toContain('[完整活动 animal]');
    expect(detail).toContain('"sourceIds"');
    expect(detail).toContain('references/example/sources.json');
    expect(r.library.selected()).toEqual({ topicKey: life.key, activityId: 'animal' });
    let context = r.library.context();
    expect(context).toContain('[完整活动 animal]');
    expect(context).not.toContain('garden：活动 garden');
    expect(context).not.toContain('walk：活动 walk');
    r.library.guides(build.key);
    context = r.library.context();
    expect(context).toContain('shelter：活动 shelter');
    expect(context).not.toContain('[完整活动 animal]');
    expect(estimateTokens(context)).toBeLessThanOrEqual(r.cfg.maxContextTokens);
    expect(r.reads).not.toContain('references/example/sources.json');
  });

  it('uses an explicit concise topic summary while retaining complete activities in their own file', () => {
    const r = rig();
    r.put(r.cfg.indexFiles, { kind: 'imported_reference_index', categories: [
      { file: 'life.json', summary: '动物照料、园艺与日常休闲', ideas: 'a long activity listing'.repeat(30) },
    ] });
    const topic = r.library.descriptors()[0];
    expect(topic.summary).toBe('动物照料、园艺与日常休闲');
    expect(r.library.catalog()).not.toContain('a long activity listing');
    expect(r.library.guides(topic.key, 0, 2)).toContain('garden：活动 garden');
    expect(r.library.detail(topic.key, 'garden')).toContain('[完整活动 garden]');
  });

  it('retains stable topic keys across reordered indexes and reloads updated source content', () => {
    const r = rig();
    const life = r.library.descriptors()[0];
    r.library.detail(life.key, 'garden');
    r.index([{ file: 'build.json', ideas: '新建筑方向' }, { file: 'life.json', ideas: '新生活方向' }]);
    r.put('references/example/life.json', { activities: [activity('garden', { title: 'UPDATED_ACTIVITY', firstStep: '核对新现场' })] });
    expect(r.library.descriptors()[1].key).toBe(life.key);
    expect(r.library.catalog()).toContain('新生活方向');
    expect(r.library.context()).toContain('UPDATED_ACTIVITY');
    r.index([{ file: 'build.json', ideas: '建筑' }]);
    expect(r.library.context()).toContain('当前索引中没有 topic_key');
    expect(r.library.selected()).toBeNull();
    expect(r.library.context()).not.toContain('UPDATED_ACTIVITY');
  });

  it('paginates a large catalog and marks large activities without silently claiming full disclosure', () => {
    const r = rig({ maxContextTokens: 512 });
    r.index(Array.from({ length: 24 }, (_, i) => {
      r.put(`references/example/topic-${i}.json`, { activities: [activity('one')] });
      return { file: `topic-${i}.json`, ideas: `方向 ${i} ${'需要仔细核对条件'.repeat(10)}` };
    }));
    expect(estimateTokens(r.library.catalog())).toBeLessThanOrEqual(REFERENCE_CATALOG_MAX_TOKENS);
    expect(r.library.catalog()).toContain('[节选');
    expect(r.library.topics(10, 2)).toContain('方向 10');
    expect(estimateTokens(r.library.context())).toBeLessThanOrEqual(r.cfg.maxContextTokens);
    r.index([{ file: 'life.json', ideas: '生活' }]);
    r.put('references/example/life.json', { activities: [activity('huge', { firstStep: '长篇准备'.repeat(500) })] });
    const life = r.library.descriptors()[0];
    const detail = r.library.detail(life.key, 'huge');
    expect(detail).toContain('完整活动超过本次预算，未展开');
    expect(detail).toContain('read_file');
    expect(detail).not.toContain('[完整活动 huge]');
    expect(estimateTokens(r.library.context())).toBeLessThanOrEqual(r.cfg.maxContextTokens);
  });

  it('returns honest errors for missing files, malformed activities, duplicate ids and invalid pages', () => {
    const r = rig();
    const life = r.library.descriptors()[0];
    r.put(life.file, { activities: [activity('duplicate'), activity('duplicate')] });
    expect(r.library.guides(life.key)).toContain('重复活动 id');
    expect(r.library.selected()).toBeNull();
    r.put(life.file, { activities: [{ id: 'missing-fields', title: '标题' }] });
    expect(r.library.detail(life.key, 'missing-fields')).toContain('requires');
    r.put(life.file, { activities: [activity('valid')] });
    expect(r.library.detail(life.key, 'unknown')).toContain('没有活动 id');
    expect(r.library.guides(life.key, -1)).toContain('offset 须为');
    expect(r.library.guides(life.key, 2)).toContain('超出活动总数');
    r.index([{ file: 'missing.json', ideas: '缺文件' }]);
    expect(r.library.catalog()).toContain('[资料库]');
    expect(r.library.catalog()).not.toContain('undefined');
    r.put(r.cfg.indexFiles, { kind: 'unknown', categories: [] });
    expect(r.library.catalog()).toContain('imported_reference_index');
    writeFileSync(join(r.root, r.cfg.indexFiles), '{INVALID');
    expect(r.library.catalog()).toContain('无法读取有效 JSON');
  });

  it('rejects lexical traversal and physical links outside the explicitly configured index directory', () => {
    const r = rig();
    r.put('outside/topic.json', { activities: [activity('secret')] });
    for (const file of ['../outside/topic.json', '/outside/topic.json', 'C:/outside/topic.json', 'outside/topic.json']) {
      r.index([{ file, ideas: '越界资料' }]);
      expect(r.library.catalog()).toContain('[资料库]');
      expect(r.library.catalog()).not.toContain('secret');
    }
    symlinkSync(join(r.root, 'outside'), join(r.root, 'references/example/link'), 'junction');
    r.index([{ file: 'references/example/link/topic.json', ideas: '链接资料' }]);
    expect(r.library.catalog()).toContain('实体路径越出索引目录');
    expect(r.reads).not.toContain('references/example/link/topic.json');
    expect(r.reads).not.toContain('outside/topic.json');
  });

  it('clears ephemeral selection when disabled and exposes no reading context', () => {
    const r = rig();
    r.library.guides(r.library.descriptors()[0].key);
    r.cfg.enabled = false;
    expect(r.library.context()).toBe('');
    expect(r.library.catalog()).toBe('');
    expect(r.library.selected()).toBeNull();
    r.cfg.enabled = true;
    expect(r.library.context()).not.toContain('[当前参考方向');
  });
});
