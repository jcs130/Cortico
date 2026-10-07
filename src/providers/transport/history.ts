import type { NativeChatMessage } from './native-types.ts';
import type { ToolSchema } from '../../core/types.ts';
export function dropPastThinking(messages: NativeChatMessage[]): NativeChatMessage[] {
  return messages.map((m) =>
    m.role === 'assistant' && m.reasoning_content && !m.head
      ? { ...m, reasoning_content: '' }
      : m,
  );
}

/** 线上不带 blobs 字段:句柄是 core 内部形态,分片渲染(若有)另行处理。 */
export function dropBlobsField(m: NativeChatMessage): NativeChatMessage {
  if (m.blobs === undefined) return m;
  const { blobs: _drop, ...rest } = m;
  return rest as NativeChatMessage;
}

export function dropHeadMark(m: NativeChatMessage): NativeChatMessage {
  return { role: m.role, content: m.content,
    ...(m.reasoning_content !== undefined ? { reasoning_content: m.reasoning_content } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}), ...(m.parts ? { parts: m.parts } : {}) };
}

export interface CompatMediaOptions {
  enabled: () => boolean;
  read: (ref: string) => Buffer | null;
  /** Unset = unlimited; configured budgets select newest unique handles at their last occurrence. */
  maxContextImages?: number;
  /** Inline preserves source placement; tail keeps rolling image selection after text history. */
  imageReplayPlacement?: 'inline' | 'tail';
  /** History replays old pictures; fresh sends only images following the latest model output. */
  imageReplayScope?: 'history' | 'fresh';
}

/**
 * Select saved images before reading bytes. Unset preserves all occurrences; a configured budget
 * retains at most N distinct handles, only at their last occurrence, in chronological order.
 * Missing retained bytes do not cause older pictures to be read as replacements.
 */
export function selectContextImageGroups<T extends { handle: string }>(
  groups: readonly (readonly T[])[], maxContextImages?: number,
): T[][] {
  if (maxContextImages === undefined) return groups.map(group => [...group]);
  if (!Number.isSafeInteger(maxContextImages) || maxContextImages < 0)
    throw new RangeError('maxContextImages must be a non-negative safe integer');
  const selected = groups.map(() => new Set<number>());
  const handles = new Set<string>();
  for (let group = groups.length - 1; group >= 0 && handles.size < maxContextImages; group--) {
    for (let index = groups[group].length - 1; index >= 0 && handles.size < maxContextImages; index--) {
      const handle = groups[group][index].handle;
      if (handles.has(handle)) continue;
      handles.add(handle);
      selected[group].add(index);
    }
  }
  return groups.map((refs, group) => refs.filter((_ref, index) => selected[group].has(index)));
}

/** Only saved image attachments are expanded into image content parts. */
export function imageBlobs<T extends { mime: string }>(refs: readonly T[] | undefined): T[] {
  return (refs ?? []).filter(ref => ref.mime.startsWith('image/'));
}

/** OpenAI function 格式的 tools 段(各 chat 方言共用)。 */
export function mapTools(tools?: ToolSchema[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * 渲染 Chat 请求消息，移除内部 blobs 字段。仅在 keepReasoning 时保留非空 reasoning_content。
 * 启用媒体时将可读取的图片附件转换为 data URL 内容块；其余附件跳过，原文本引用仍保留。
 */
export function renderMessagesWithMedia(
  messages: NativeChatMessage[],
  media?: CompatMediaOptions,
  opts?: { keepReasoning?: boolean },
): Array<Record<string, unknown>> {
  const renderMedia = media?.enabled() === true ? media : undefined;
  const images = selectContextImageGroups(messages.map(m => imageBlobs(m.blobs)), renderMedia?.maxContextImages);
  return messages.map((m, index) => {
    const refs = images[index];
    const { reasoning_content: _r, parts: _parts, ...rest } = dropHeadMark(m);
    const base = { ...rest, content: m.parts ?? m.content } as Record<string, unknown>;
    if (opts?.keepReasoning && m.reasoning_content) base.reasoning_content = m.reasoning_content;
    if (!renderMedia || !refs.length) return base;
    const parts: Array<Record<string, unknown>> = m.parts ? [...m.parts] : [{ type: 'text', text: m.content }];
    let attached = false;
    for (const r of refs) {
      const bytes = renderMedia.read(r.handle);
      if (!bytes) continue;
      attached = true;
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${r.mime};base64,${bytes.toString('base64')}` },
      });
    }
    return attached ? { ...base, content: parts } : base;
  });
}
