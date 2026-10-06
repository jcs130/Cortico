import type { ModelSpec, ToolSchema, Logger } from '../../core/types.ts';
import type { Request } from '../../protocol/open-responses/index.ts';
import type { GenerateOptions } from '../../core/generation.ts';
import { nullLogger } from '../../core/util.ts';
import { OpenAIHttpClient } from '../transport/chat.ts';
import type { NativeChatMessage } from '../transport/native-types.ts';
import { dropPastThinking, mapTools, renderMessagesWithMedia, type CompatMediaOptions } from '../transport/history.ts';

export type ReasoningMode = 'reasoning_effort' | 'extra_body';

export interface ChatCompatProviderOptions {
  baseUrl: string;
  apiKey?: string;
  endpointPath?: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  /** Default reasoning_effort; extra_body delegates the wire fields to the connection. */
  reasoningMode?: ReasoningMode;
  /** Default false; only endpoints accepting reasoning_content can replay it. */
  replayReasoning?: boolean;
  media?: CompatMediaOptions;
  keepThinking?: () => boolean;
  log?: Logger;
}

export function chatCompatHeaders(apiKey?: string, extraHeaders?: Record<string, string>): Record<string, string> {
  const headers = new Headers({ 'Content-Type': 'application/json', ...extraHeaders });
  if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
  return Object.fromEntries(headers.entries());
}

export function buildChatCompatRequestBody(
  spec: ModelSpec,
  messages: NativeChatMessage[],
  tools?: ToolSchema[],
  options: Pick<ChatCompatProviderOptions, 'media' | 'reasoningMode' | 'replayReasoning'> & { keepThinking?: boolean } = {},
): Record<string, unknown> {
  const history = options.keepThinking === false ? dropPastThinking(messages) : messages;
  const body: Record<string, unknown> = {
    model: spec.model,
    messages: renderMessagesWithMedia(history, options.media, { keepReasoning: options.replayReasoning === true }),
  };
  if (options.reasoningMode !== 'extra_body') {
    if (!spec.thinking) body.reasoning_effort = 'none';
    else if (spec.reasoningEffort) body.reasoning_effort = spec.reasoningEffort;
  }
  if (spec.temperature !== undefined) body.temperature = spec.temperature;
  if (spec.maxTokens !== undefined) body.max_tokens = spec.maxTokens;
  const mapped = mapTools(tools);
  if (mapped) body.tools = mapped;
  return body;
}

export class ChatCompatProvider extends OpenAIHttpClient {
  constructor(private readonly options: ChatCompatProviderOptions) {
    super(options.baseUrl, options.log ?? nullLogger());
    this.chatPath = options.endpointPath ?? '/chat/completions';
  }

  protected buildBody(spec: ModelSpec, messages: NativeChatMessage[], tools?: ToolSchema[]): Record<string, unknown> {
    return buildChatCompatRequestBody(spec, messages, tools, {
      ...this.options, keepThinking: this.options.keepThinking?.(),
    });
  }

  protected buildResponseBody(request: Request, options: GenerateOptions): Record<string, unknown> {
    const body = { ...super.buildResponseBody(request, options), ...this.options.extraBody };
    if (request.service_tier != null && this.options.extraBody?.service_tier === undefined)
      body.service_tier = request.service_tier;
    body.stream = Boolean(options.onEvent);
    return body;
  }

  protected headers(): Record<string, string> {
    return chatCompatHeaders(this.options.apiKey, this.options.extraHeaders);
  }
}
