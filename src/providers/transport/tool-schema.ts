/** Convert tuple notation at schema positions, preserving data examples and argument constraints. */
export function prefixTupleItems(schema: Record<string, unknown>): Record<string, unknown> {
  const root = structuredClone(schema);
  const maps = ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas'];
  const arrays = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
  const singles = ['items', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    if (Array.isArray(node.items)) {
      if (node.prefixItems !== undefined) throw new Error('Tuple schema declares both items array and prefixItems');
      node.prefixItems = node.items;
      delete node.items;
      if (node.additionalItems !== undefined) node.items = node.additionalItems;
      delete node.additionalItems;
    }
    for (const key of maps) {
      const children = node[key];
      if (children && typeof children === 'object' && !Array.isArray(children)) Object.values(children).forEach(visit);
    }
    const dependencies = node.dependencies;
    if (dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) Object.values(dependencies).forEach(visit);
    for (const key of arrays) if (Array.isArray(node[key])) (node[key] as unknown[]).forEach(visit);
    for (const key of singles) visit(node[key]);
  };
  visit(root);
  return root;
}
