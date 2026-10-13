/** Saved connection references in deployment configuration. Nested decisionProvider fields belong to optional host clients. */
export function providerReferencePaths(config: Record<string, unknown>, name: string): string[][] {
  const paths: string[][] = [];
  function visit(value: unknown, path: string[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (!path.length && key === 'providers') continue;
      const next = [...path, key];
      if ((key === 'decisionProvider' || (!path.length && key === 'activeProvider')) && child === name) paths.push(next);
      else visit(child, next);
    }
  }
  visit(config, []);
  return paths;
}

export function renameProviderReferences(config: Record<string, unknown>, oldName: string, name: string): void {
  for (const path of providerReferencePaths(config, oldName)) {
    let parent = config;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    parent[path.at(-1)!] = name;
  }
}
