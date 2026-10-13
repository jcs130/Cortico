import type { Editing } from './types.ts';

export const NEW_DRAFT_ID = '/new';

/** API Key edits survive navigation in this editor; only non-secret drafts reach browser storage. */
export function providerDrafts(storage: Storage, scope: string) {
  const key = `cortico:provider-drafts:v2:${scope}`;
  let values: Record<string, Editing> = Object.create(null);
  try { values = JSON.parse(storage.getItem(key) ?? '{}'); } catch { /* A corrupt draft does not block saved connections. */ }
  if (!values || typeof values !== 'object' || Array.isArray(values)) values = Object.create(null);
  else values = Object.assign(Object.create(null), values);
  for (const value of Object.values(values)) if (value && typeof value === 'object') value.secretValue = '';
  const persist = () => storage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { ...value, secretValue: '' }]))));
  return {
    get(name: string): Editing | null {
      const value = values[name];
      return value && typeof value.name === 'string' && value.entry && typeof value.entry.kind === 'string' && value.raw
        ? structuredClone(value) : null;
    },
    set(value: Editing, name = value.original ?? NEW_DRAFT_ID): void { values[name] = structuredClone(value); persist(); },
    remove(name: string): void { delete values[name]; persist(); },
    has(name: string): boolean { return !!values[name]; },
  };
}
