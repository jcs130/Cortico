import type { ConfigGroup } from '../../core/config-schema.ts';
import type { LLMProviderEntry } from '../../core/types.ts';
import type { Language } from '../../core/language.ts';

export function protocolConfig(name: string, entry: LLMProviderEntry, language: Language): ConfigGroup[] {
  const zh = language === 'zh';
  const prefix = `providers.${name}.options.`;
  return [{
    id: `llm.${entry.kind}.${name}.protocol`, owner: `provider:${entry.kind}`,
    schema: {
      type: 'object', title: name,
      properties: {
        [`${prefix}endpointPath`]: {
          type: 'string', title: zh ? '端点路径' : 'Endpoint path',
          description: zh ? '追加到 API 地址，默认 /chat/completions。' : 'Appended to the API prefix; default /chat/completions.', 'x-hot': true,
        },
        [`${prefix}reasoningMode`]: {
          type: 'string', enum: ['reasoning_effort', 'extra_body'], title: zh ? '思考字段映射' : 'Thinking field mapping',
          description: zh ? '默认使用 reasoning_effort；extra_body 使用连接配置提供的字段。' : 'Default reasoning_effort; extra_body uses the fields supplied by the connection.', 'x-hot': true,
        },
        [`${prefix}replayReasoning`]: {
          type: 'boolean', title: zh ? '回传历史推理' : 'Replay past reasoning',
          description: zh ? '默认关闭。仅在端点接受 reasoning_content 时开启。' : 'Default off. Enable only when the endpoint accepts reasoning_content.', 'x-hot': true,
        },
        [`${prefix}maxContextImages`]: {
          type: 'integer', minimum: 0, title: zh ? '历史图片上限' : 'Context image limit',
          description: zh ? '保留最新的不同图片；留空不限，0 只保留附件文本。' : 'Keeps the newest unique images; unset is unlimited, zero retains attachment text only.', 'x-hot': true,
        },
        [`${prefix}extraHeaders`]: {
          type: 'object', title: zh ? '附加请求头（JSON object）' : 'Extra headers (JSON object)', 'x-hot': true,
        },
        [`${prefix}extraBody`]: {
          type: 'object', title: zh ? '附加请求体（JSON object）' : 'Extra request body (JSON object)', 'x-hot': true,
        },
      },
    },
  }];
}
