import type { LLMProviderEntry } from '../core/types.ts';

/** Starting values only; model, credentials and all protocol fields remain editable. */
export interface ProviderPreset {
  id: string;
  title: string;
  baseUrl: string;
  model?: string;
  options?: LLMProviderEntry['options'];
  docs: string;
}

export const CHAT_PRESETS: readonly ProviderPreset[] = [
  { id: 'deepseek', title: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
    options: { reasoningMode: 'reasoning_effort', replayReasoning: true }, docs: 'https://api-docs.deepseek.com/' },
  { id: 'dashscope', title: '阿里云百炼 / 通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    options: { reasoningMode: 'extra_body', replayReasoning: true }, docs: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope' },
  { id: 'moonshot', title: '月之暗面 / Kimi', baseUrl: 'https://api.moonshot.cn/v1',
    options: { reasoningMode: 'extra_body', replayReasoning: true }, docs: 'https://platform.kimi.com/docs/api/chat' },
  { id: 'bigmodel', title: '智谱 / GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    options: { reasoningMode: 'extra_body', replayReasoning: true }, docs: 'https://docs.bigmodel.cn/api-reference' },
  { id: 'ark', title: '火山方舟 / 豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    options: { reasoningMode: 'extra_body', replayReasoning: true }, docs: 'https://www.volcengine.com/docs/82379/1298459' },
  { id: 'siliconflow', title: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1',
    options: { reasoningMode: 'extra_body', replayReasoning: true }, docs: 'https://docs.siliconflow.cn/docs/userguide/quickstart' },
  { id: 'minimax', title: 'MiniMax', baseUrl: 'https://api.minimax.cn/v1',
    options: { reasoningMode: 'extra_body', replayReasoning: true }, docs: 'https://platform.minimax.cn/docs/api-reference/text-openai-api' },
  { id: 'openai-chat', title: 'OpenAI · Chat Completions', baseUrl: 'https://api.openai.com/v1', docs: 'https://platform.openai.com/docs/api-reference/chat' },
  { id: 'openrouter', title: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', docs: 'https://openrouter.ai/docs/quickstart' },
];

export const RESPONSES_PRESETS: readonly ProviderPreset[] = [
  { id: 'openai-responses', title: 'OpenAI · Responses', baseUrl: 'https://api.openai.com/v1', docs: 'https://platform.openai.com/docs/api-reference/responses' },
];

/** A different endpoint must never inherit a previous endpoint's key or protocol overrides. */
export function presetEntry(kind: string, preset: ProviderPreset, thinking = true): LLMProviderEntry {
  return { kind, baseUrl: preset.baseUrl, spec: { model: preset.model ?? '', thinking },
    ...(preset.options ? { options: structuredClone(preset.options) } : {}) };
}
