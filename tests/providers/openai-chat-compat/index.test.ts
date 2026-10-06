import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import module from '../../../src/providers/openai-chat-compat/index.ts';
import { ChatCompatProvider } from '../../../src/providers/openai-chat-compat/native.ts';
import { validateEntry } from '../../../src/providers/configuration.ts';
import { ProviderRegistry, providerModule } from '../../../src/providers/registry.ts';
import { ProviderSettings } from '../../../src/providers/console/settings.ts';
import { ProviderHub } from '../../../src/providers/console/hub.ts';
import { nullLogger } from '../../../src/core/util.ts';
import { makeCfg, makeTmpDir } from '../../core/helpers.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.unstubAllGlobals(); cleanups.splice(0).forEach(cleanup => cleanup()); });
const entry = { kind: module.id, baseUrl: 'https://model.test/v1', spec: { model: 'test-model', thinking: true } };

it('discovers the module and makes its settings editable through the existing provider library', async () => {
  const temp = makeTmpDir(); cleanups.push(temp.cleanup);
  const root = join(temp.dir, 'providers');
  const file = join(temp.dir, 'config.json');
  const cfg = makeCfg({ providers: {}, activeProvider: '' });
  const registry = new ProviderRegistry(() => cfg.providers, { stateRoot: root, readBlob: () => null, keepThinking: () => true, log: nullLogger() });
  const settings = new ProviderSettings(cfg, registry, file, root);
  const hub = new ProviderHub(cfg, registry, settings, file, root);
  expect(providerModule(module.id)).toBe(module);
  const info = hub.moduleList('en').find(item => item.id === module.id)!;
  expect(info.sections.map(section => section.id)).toEqual(['endpoint', 'model', 'pricing', 'protocol']);
  const saved = hub.save(null, { name: 'Chat', entry: { ...entry, options: { reasoningMode: 'extra_body', replayReasoning: true,
    extraBody: { thinking_switch: true } } }, secretValue: 'fixture-secret' }, 'en');
  expect(saved.readiness.state).toBe('ready');
  expect(JSON.stringify(saved)).not.toContain('fixture-secret');
  expect(registry.resolve('Chat').client).toBeInstanceOf(ChatCompatProvider);
  expect(existsSync(join(root, 'Chat', '.env'))).toBe(true);
  const protocol = saved.config.find(group => group.owner === `provider:${module.id}` && group.id.endsWith('.protocol'))!;
  expect(Object.keys(protocol.schema.properties!)).toEqual([
    'providers.Chat.options.endpointPath', 'providers.Chat.options.reasoningMode', 'providers.Chat.options.replayReasoning',
    'providers.Chat.options.maxContextImages', 'providers.Chat.options.extraHeaders', 'providers.Chat.options.extraBody',
  ]);
  expect(Object.values(protocol.schema.properties!).every(field => field['x-hot'] === true)).toBe(true);
});

it('normalizes editor unset values without removing false, zero or connection body settings', () => {
  const normalized = validateEntry(module, { ...entry, options: { endpointPath: '', reasoningMode: '', replayReasoning: false,
    maxContextImages: 0, extraHeaders: {}, extraBody: { thinking_switch: false } } }, 'en');
  expect(normalized.options).toEqual({ replayReasoning: false, maxContextImages: 0, extraBody: { thinking_switch: false } });
  expect(module.accepts({ ...entry, multimodal: true }, entry.spec, 'image/png')).toBe(true);
  expect(module.accepts(entry, entry.spec, 'image/png')).toBe(false);
  expect(module.accepts({ ...entry, multimodal: true }, entry.spec, 'application/pdf')).toBe(false);
});

it.each([
  { endpointPath: 'chat/completions' }, { endpointPath: 4 }, { reasoningMode: 'template' },
  { replayReasoning: 'true' }, { maxContextImages: -1 }, { maxContextImages: 0.5 },
  { extraHeaders: [] }, { extraHeaders: { authorization: 7 } }, { extraBody: [] }, { extraBody: null },
])('rejects malformed transport options: %j', options => {
  expect(() => validateEntry(module, { ...entry, options }, 'en')).toThrow();
});

it('uses the same connection and bearer secret for model discovery and generation', async () => {
  const calls: Array<{ url: string; auth: string | null; tenant: string | null }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    calls.push({ url, auth: headers.get('authorization'), tenant: headers.get('x-tenant') });
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'test-model', context_length: 32000 }] }));
    return new Response(JSON.stringify({ id: 'r', model: 'test-model', choices: [{ message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }] }));
  });
  const instance = module.create('Chat', { ...entry, secret: 'CORTICO_FIXTURE_KEY', options: { extraHeaders: { 'X-Tenant': 'sample' } } }, {
    stateDir: '', secret: () => 'fixture-secret', readBlob: () => null, keepThinking: () => true, log: nullLogger(),
  });
  expect(await instance.listModels()).toEqual([{ id: 'test-model', contextWindow: 32000 }]);
  expect(instance.contextWindow('test-model')).toBe(32000);
  await instance.client.respond({ model: 'test-model', input: 'hi' });
  expect(calls).toEqual([
    { url: 'https://model.test/v1/models', auth: 'Bearer fixture-secret', tenant: 'sample' },
    { url: 'https://model.test/v1/chat/completions', auth: 'Bearer fixture-secret', tenant: 'sample' },
  ]);
});
