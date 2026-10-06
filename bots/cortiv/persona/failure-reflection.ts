import { createHash } from 'node:crypto';
import type { ToolOutcome } from 'cortico/core/types.ts';

export const FAILURE_REFLECTION_ADVICE =
  '若尚未证实达成，按原回执与现场事实修正原假设；继续时选择能检验不同假设的一步和可核验的预期，'
  + '或明确暂缓及恢复条件。准备步骤做成或动作回执显示完成，需结合原目标核对。新做法验收成功后，再把可复用结论写入长期记忆。这段复盘不用口播。';

const FAILURE_WINDOW_MS = 15 * 60_000;

/** JSON 参数保持数组次序，只规范对象键次序，不合并坐标或不同调用。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** 对同参数的真实失败提供一次复盘说明，不调度行动或唤醒。 */
export class ActionFailureReflection {
  private readonly failures = new Map<string, { firstAt: number; count: number; reflected: boolean }>();

  observe(tool: string, args: Readonly<Record<string, unknown>>, outcome: Readonly<ToolOutcome>, at = Date.now()): string | null {
    for (const [key, value] of this.failures) {
      if (at - value.firstAt >= FAILURE_WINDOW_MS) this.failures.delete(key);
    }
    const key = createHash('sha256').update(JSON.stringify([tool, canonical(args)])).digest('hex');
    if (!outcome.failed) {
      this.failures.delete(key);
      return null;
    }
    const failure = this.failures.get(key) ?? { firstAt: at, count: 0, reflected: false };
    failure.count++;
    this.failures.set(key, failure);
    if (failure.count < 2 || failure.reflected) return null;
    failure.reflected = true;
    return `[反思] ${tool} 的同参数调用在 15 分钟内第 ${failure.count} 次返回失败；实际受理、动作进展与原因以原回执为准。`
      + FAILURE_REFLECTION_ADVICE;
  }
}
