/** Read-only sequential flight geometry and time budgeting from one observed origin. */
import type { Bot } from 'mineflayer';
import { resolveAnchors } from './geometry.ts';
import { flightState, previewFlight, type FlightPreview } from './flight.ts';
import { SkillBlocked } from './skill-context.ts';
import { parseScoutSteps, type MarkLookup, type SkillCall } from './skills.ts';

type FlightStep = Extract<SkillCall, { skill: 'flight' }>;
export const FLIGHT_PLAN_MAX_POINTS = 16;

export function parseFlightPlan(args: Record<string, unknown>, marks?: MarkLookup):
  { steps: FlightStep[]; budgetMs?: number } | { error: string } {
  if (!Array.isArray(args.points) || !args.points.length || args.points.length > FLIGHT_PLAN_MAX_POINTS) {
    return { error: `points 需要 1 至 ${FLIGHT_PLAN_MAX_POINTS} 个依次到达的飞行目标` };
  }
  if (args.budgetMs !== undefined && (!Number.isSafeInteger(args.budgetMs) || Number(args.budgetMs) <= 0)) {
    return { error: 'budgetMs 需要正整数毫秒；它是调用者提供的可用时长，不是服务端授予权限' };
  }
  for (const point of args.points) {
    if (!point || typeof point !== 'object' || Array.isArray(point)
      || Object.keys(point).some(key => key !== 'at' && key !== 'land')
      || ('land' in point && typeof point.land !== 'boolean')) return { error: '每个 point 只包含 at 和可选的布尔值 land' };
  }
  const parsed = parseScoutSteps(args.points.map(point => ({ ...point, skill: 'flight' })), marks);
  if ('error' in parsed) return parsed;
  return { steps: parsed.steps as FlightStep[], ...(args.budgetMs === undefined ? {} : { budgetMs: Number(args.budgetMs) }) };
}

export interface FlightPlanPreview {
  sampledAt: string;
  from: FlightPreview['from'];
  segments: FlightPreview[];
  complete: boolean;
  checkedDurationMs: number;
  estimatedDurationMs: number | null;
  budgetMs: number | null;
  budgetSource: 'caller' | 'server-expiry' | 'caller-and-server-expiry' | null;
  fitsBudget: boolean | null;
  endsOnSupport: boolean | null;
  blockedStep?: number;
  reason?: string;
}

/** Projected endpoints are planning assumptions; the Bot and its permission remain untouched. */
export function previewFlightPlan(bot: Bot, steps: readonly FlightStep[], callerBudgetMs?: number): FlightPlanPreview {
  if (!bot.entity?.position) throw new SkillBlocked('还没进入世界，不能试算飞行');
  const observed = bot.entity.position;
  let origin = { x: observed.x, y: observed.y, z: observed.z };
  const state = flightState(bot);
  const remaining = state.allowed && state.expiresAtMs !== undefined
    ? Math.max(0, state.expiresAtMs - Date.now()) : null;
  const budgetMs = remaining === null ? callerBudgetMs ?? null
    : callerBudgetMs === undefined ? remaining : Math.min(remaining, callerBudgetMs);
  const budgetSource = remaining === null ? callerBudgetMs === undefined ? null : 'caller'
    : callerBudgetMs === undefined ? 'server-expiry' : 'caller-and-server-expiry';
  const result: FlightPlanPreview = {
    sampledAt: new Date().toISOString(), from: [origin.x, origin.y, origin.z], segments: [],
    complete: false, checkedDurationMs: 0, estimatedDurationMs: null,
    budgetMs, budgetSource, fitsBudget: null, endsOnSupport: null,
  };
  for (const [index, step] of steps.entries()) {
    try {
      const resolved = resolveAnchors([step.at], {
        x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z),
      });
      if (!Array.isArray(resolved)) throw new SkillBlocked(resolved.error);
      const at = resolved[0];
      const preview = previewFlight(bot, { x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, { land: step.land !== false }, origin);
      result.segments.push(preview);
      result.checkedDurationMs += preview.estimatedDurationMs;
      origin = { x: preview.at[0], y: preview.at[1], z: preview.at[2] };
    } catch (error) {
      if (!(error instanceof SkillBlocked)) throw error;
      return { ...result, blockedStep: index + 1, reason: error.message };
    }
  }
  return { ...result, complete: true, estimatedDurationMs: result.checkedDurationMs,
    fitsBudget: budgetMs === null ? null : result.checkedDurationMs <= budgetMs,
    endsOnSupport: result.segments.at(-1)?.land ?? false };
}
