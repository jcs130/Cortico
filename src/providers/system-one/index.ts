import { BaseProvider, type ProviderModule } from '../base.ts';
import { connectionBlocks } from '../console/config.ts';
import { ModelCatalog } from '../openai-responses-compat/native.ts';
import { requestDecision } from './native.ts';

class DecisionOnlyClient extends BaseProvider {
  async respond(): Promise<never> { throw new Error('This connection supports typed decisions only.'); }
}

export default {
  id: 'system-one', title: 'System One · 快决策', generation: false,
  description: 'Typed choice API with probability distributions; local or hosted.',
  localize: language => ({ description: language === 'zh' ? '本地或云端快决策服务，使用 state/questions 与 answers/probabilities 协议。' : 'Local or hosted typed choice service.' }),
  defaultBaseUrl: 'http://127.0.0.1:8090/v1',
  presets: [
    { id: 'system-one-local', title: '本地 System One', baseUrl: 'http://127.0.0.1:8090/v1', docs: 'https://docs.typesafe.ai/introduction/quickstart' },
    { id: 'system-one-cloud', title: 'TypeSafe / Jev API', baseUrl: 'https://api.typesafe.ai/v1', model: 'jev-latest', docs: 'https://docs.typesafe.ai/introduction/quickstart' },
  ],
  reasoningTiers: [{ id: 'none', label: '分类决策', thinking: false }], serviceTiers: [],
  config: name => [{ id: `system-one-${name}`, owner: `provider:${name}`, schema: { type: 'object', title: 'System One', properties: {
    [`providers.${name}.options.endpointPath`]: { type: 'string', title: '决策接口路径', description: '默认 /systemone；与上方 API 地址拼接。', 'x-hot': true },
  } } }],
  console: host => { const b = connectionBlocks(host.language); return { panels: [b.endpoint, b.model, b.protocol] }; },
  validateEntry: entry => { const path = entry.options?.endpointPath;
    if (path !== undefined && path !== '' && (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('://')))
      throw new Error('Decision endpointPath must be a relative path starting with /.'); },
  create(_name, entry, host) {
    const apiKey = entry.secret ? host.secret(entry.secret) : undefined;
    const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const catalog = new ModelCatalog(() => ({ baseUrl: entry.baseUrl, headers }));
    return {
      client: new DecisionOnlyClient(),
      decide: (input, options) => {
        const current = host.currentEntry?.() ?? entry;
        if (!current.spec?.model || (entry.secret && !apiKey)) throw new Error('Decision model or credential is missing.');
        return requestDecision({ baseUrl: entry.baseUrl, model: current.spec.model, apiKey,
          endpointPath: (entry.options?.endpointPath as string) || undefined }, input, options);
      },
      listModels: () => catalog.list(),
    };
  },
} satisfies ProviderModule;
