/** Mechanical, bounded excerpts; the Persona still judges what the historical notes mean. */
export const VIEWER_PROFILE_LIMITS = { summaryChars: 320, recent: 2, entryChars: 480 };

export function viewerProfileContext(content: string | null): string {
  if (!content) return '';
  const lines = content.split(/\r?\n/);
  const first = lines.findIndex(line => line.trim().length > 0);
  if (first < 0) return '';
  const clip = (text: string, size: number) => text.length > size ? text.slice(0, size) + ' [节选，按档案行号回查]' : text;
  const entries: Array<{ line: number; date: string; text: string }> = [];
  let current: { line: number; date: string; text: string } | undefined;
  for (let index = first + 1; index < lines.length; index++) {
    const line = lines[index].trim();
    // Dates must lead the note/heading, not occur in a quotation or an evidence URL.
    const date = line.match(/^(?:#{1,6}\s+|[-*]\s+)?(\d{4}-\d{2}-\d{2})(?=\D|$)/)?.[1];
    if (date) {
      current = { line: index + 1, date, text: line };
      entries.push(current);
    } else if (/^#{1,6}\s|^[-*]\s/.test(line)) {
      current = undefined;
    } else if (current && line && current.text.length < VIEWER_PROFILE_LIMITS.entryChars) {
      current.text += '\n' + line;
    }
  }
  const selected = entries.sort((a, b) => b.date.localeCompare(a.date) || b.line - a.line)
    .slice(0, VIEWER_PROFILE_LIMITS.recent);
  return `档案首行 L${first + 1}：${clip(lines[first].trim(), VIEWER_PROFILE_LIMITS.summaryChars)}`
    + (selected.length ? '\n近期有日期的档案原文（原作者的历史记述，未重新核验；不证明当前装备、位置或已履约；引语的“我”仍属原发言人）：\n'
      + selected.map(entry => `L${entry.line}：${clip(entry.text, VIEWER_PROFILE_LIMITS.entryChars)}`).join('\n') : '');
}
