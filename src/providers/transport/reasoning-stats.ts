import type { InferenceReasoning } from '../../core/generation.ts';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const count = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const choice = (value: unknown, allowed: readonly string[]): string | null => typeof value === 'string' && allowed.includes(value) ? value : null;
const efforts = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default'];
const confirmations = ['serving_template_and_budget_policy', 'serving_template', 'engine', 'engine_effective', 'engine_confirmed'];
const statuses = ['disabled', 'not_requested', 'not_configured', 'unsupported', 'applied', 'configured', 'default', 'unlimited', 'unknown', 'enabled', 'independent', 'inherited'];

/** A received parameter becomes effective only when the serving engine confirms it. */
export function reasoningStats(value: unknown): InferenceReasoning | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = object(value), requested = object(source.requested), effective = object(source.effective);
  const thinking = boolean(effective.thinking), budgetStatus = choice(effective.budget_status, statuses);
  const effort = choice(effective.reasoning_effort, efforts), budget = count(effective.budget_tokens);
  const confirmation = choice(source.confirmation, [...confirmations, 'requested_only', 'unconfirmed']);
  const confirmed = confirmation && confirmations.includes(confirmation) && (thinking !== null || effort !== null || budget !== null)
    ? true : confirmation === 'requested_only' || confirmation === 'unconfirmed' ? false : null;
  return { requested: { thinking: boolean(requested.thinking), effort: choice(requested.reasoning_effort, efforts), budgetTokens: count(requested.budget_tokens) },
    effective: { thinking, effort, nativeEffort: choice(effective.native_reasoning_effort, efforts),
      budgetTokens: thinking === false || budgetStatus === 'disabled' ? null : budget, budgetStatus },
    confirmation, confirmed };
}
