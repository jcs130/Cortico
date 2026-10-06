import type { ProviderModule } from '../base.ts';
import type { LLMProviderEntry } from '../../core/types.ts';
import { connectionBlocks } from '../console/config.ts';
import { isContextOverflow } from '../transport/errors.ts';
import { ModelCatalog } from '../openai-responses-compat/native.ts';
import { ChatCompatProvider, chatCompatHeaders, type ChatCompatProviderOptions } from './native.ts';
import { protocolConfig } from './config.ts';

export type ChatCompatOptions = Pick<ChatCompatProviderOptions,
  'endpointPath' | 'extraHeaders' | 'extraBody' | 'reasoningMode' | 'replayReasoning'> & { maxContextImages?: number };

export function chatCompatOptions(entry: LLMProviderEntry): ChatCompatOptions {
  return (entry.options ?? {}) as ChatCompatOptions;
}

function normalizeChatCompat(entry: LLMProviderEntry): LLMProviderEntry {
  const options: Record<string, unknown> = { ...entry.options };
  for (const key of ['endpointPath', 'reasoningMode', 'replayReasoning', 'maxContextImages'])
    if (options[key] === '') delete options[key];
  for (const key of ['extraHeaders', 'extraBody']) {
    const value = options[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) delete options[key];
  }
  return { ...entry, options };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export default {
  id: 'openai-chat-compat',
  title: 'OpenAI Chat Completions Compatible',
  description: 'Connect to Chat Completions-compatible model services.',
  localize: language => ({ description: language === 'zh' ? '连接兼容 Chat Completions API 的模型服务。' : 'Connect to Chat Completions-compatible model services.' }),
  normalize: normalizeChatCompat,
  config: protocolConfig,
  console: host => {
    const blocks = connectionBlocks(host.language);
    return { panels: [blocks.endpoint, blocks.model, blocks.pricing, blocks.protocol] };
  },
  reasoningTiers: [],
  effortSuggestions: ['none', 'low', 'medium', 'high', 'xhigh'],
  serviceTiers: [],
  contextOverflow: isContextOverflow,
  accepts: (entry, _spec, mime) => entry.multimodal === true && mime.startsWith('image/'),
  validateEntry: (entry, language) => {
    const options = chatCompatOptions(entry);
    const fail = (en: string, zh: string): never => { throw new Error(language === 'zh' ? zh : en); };
    if (options.endpointPath !== undefined && (typeof options.endpointPath !== 'string' || !options.endpointPath.startsWith('/')))
      fail('Endpoint path must start with /.', '端点路径必须以 / 开头。');
    if (options.reasoningMode !== undefined && !['reasoning_effort', 'extra_body'].includes(options.reasoningMode))
      fail('Thinking field mapping must be reasoning_effort or extra_body.', '思考字段映射必须为 reasoning_effort 或 extra_body。');
    if (options.replayReasoning !== undefined && typeof options.replayReasoning !== 'boolean')
      fail('Replay reasoning must be boolean.', '回传历史推理必须为布尔值。');
    if (options.maxContextImages !== undefined && (!Number.isSafeInteger(options.maxContextImages) || options.maxContextImages < 0))
      fail('Context image limit must be a non-negative safe integer.', '历史图片上限必须为非负安全整数。');
    if (options.extraHeaders !== undefined && (!isObject(options.extraHeaders) || Object.values(options.extraHeaders).some(value => typeof value !== 'string')))
      fail('Extra headers must be an object of strings.', '附加请求头必须为字符串值的对象。');
    if (options.extraBody !== undefined && !isObject(options.extraBody))
      fail('Extra request body must be an object.', '附加请求体必须为对象。');
  },
  create(name, entry, host) {
    const options = chatCompatOptions(entry);
    const apiKey = entry.secret ? host.secret(entry.secret) : undefined;
    const catalog = new ModelCatalog(() => ({ baseUrl: entry.baseUrl,
      headers: chatCompatHeaders(apiKey, options.extraHeaders) }));
    return {
      client: new ChatCompatProvider({ ...options, baseUrl: entry.baseUrl, apiKey, log: host.log,
        media: { enabled: () => entry.multimodal === true, read: host.readBlob, maxContextImages: options.maxContextImages },
        keepThinking: host.keepThinking }),
      listModels: () => catalog.list(),
      contextWindow: model => catalog.contextWindow(model),
      compatibilityKey: () => [options.endpointPath ?? '/chat/completions', options.reasoningMode ?? 'reasoning_effort', options.replayReasoning === true, name],
    };
  },
} satisfies ProviderModule;
