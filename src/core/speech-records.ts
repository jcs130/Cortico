/** Complete JSON objects from cumulative public text. Braces inside strings are data. */
export function speechRecords(text: string): string[] {
  if (text.length > 8192) throw Error('Speech output exceeds record budget');
  const records: string[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"' && depth) quoted = true;
    else if (c === '{') { if (!depth) start = i; depth++; }
    else if (c === '}' && depth && --depth === 0) {
      records.push(text.slice(start, i + 1));
      if (records.length > 2) throw Error('At most two speech records per draft');
    }
  }
  return records;
}
