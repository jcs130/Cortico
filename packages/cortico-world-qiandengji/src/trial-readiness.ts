/** Known trial start actions must pass a fresh melee loadout check. */
export function startsTrialFight(args: Record<string, unknown>): boolean {
  if (!Array.isArray(args.steps)) return false;
  return args.steps.some((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const step = raw as Record<string, unknown>;
    if (step.skill === 'chat' && typeof step.text === 'string') {
      return /^\/mycli\s+arena\s+(?:next|start)\s*$/i.test(step.text.trim());
    }
    if (step.skill !== 'use' || !Array.isArray(step.at) || step.at.length !== 3) return false;
    const at = step.at;
    return at.every((n) => typeof n === 'number' && Number.isInteger(n))
      && Math.abs((at[0] as number) + 596) <= 1
      && Math.abs((at[1] as number) - 92) <= 1
      && Math.abs((at[2] as number) + 313) <= 1;
  });
}

/** Entrance actions start a new run; `arena next` continues an existing one. */
export function startsTrialRun(args: Record<string, unknown>): boolean {
  if (!Array.isArray(args.steps)) return false;
  return args.steps.some((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const step = raw as Record<string, unknown>;
    if (step.skill === 'chat' && typeof step.text === 'string') {
      return /^\/mycli\s+arena\s+start\s*$/i.test(step.text.trim());
    }
    return startsTrialFight({ steps: [step] }) && step.skill === 'use';
  });
}

export function trialMeleeReadiness(bag: string): 'ready' | 'missing' | 'unknown' {
  const list = bag.match(/^工具物品名:([^\r\n]*)/m)?.[1];
  if (!list) return 'unknown';
  const ids = list.replace(/[。.]$/, '').split('、').map((name) => name.trim());
  return ids.some((name) => /(?:^|:)[a-z0-9_]+_(?:sword|axe)$/.test(name)) ? 'ready' : 'missing';
}
