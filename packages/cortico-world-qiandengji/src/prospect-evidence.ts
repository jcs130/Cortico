/** Server prospecting coordinates outrank a scan of the client's received chunk data. */
interface ProspectTarget {
  dimension: string;
  ore: string;
  x: number;
  y: number;
  z: number;
  at: number;
}

const VALID_MS = 5 * 60_000;

export class ProspectEvidence {
  private target: ProspectTarget | null = null;

  observe(text: string, timestamp: string): void {
    const match = /探矿术找到[^：:]*[：:]\s*dimension=(\S+)\s+X=(-?\d+)\s+Y=(-?\d+)\s+Z=(-?\d+)\s+ore=(?:minecraft:)?([a-z0-9_]+)/.exec(text);
    if (!match) return;
    const at = Date.parse(timestamp);
    if (!Number.isFinite(at)) return;
    this.target = {
      dimension: match[1], x: Number(match[2]), y: Number(match[3]), z: Number(match[4]),
      ore: match[5], at,
    };
  }

  redundantProbe(args: Record<string, unknown>, now = Date.now()): string | null {
    const target = this.target;
    if (!target || now < target.at || now - target.at > VALID_MS || !Array.isArray(args.steps)) return null;
    for (const raw of args.steps) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const step = raw as Record<string, unknown>;
      if (step.skill !== 'probe' || step.shape !== 'box' || !Array.isArray(step.where)
        || !step.where.some((id) => id === target.ore || id === `minecraft:${target.ore}`)) continue;
      if (!Array.isArray(step.anchors) || step.anchors.length !== 2) continue;
      const [a, b] = step.anchors;
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 3 || b.length !== 3
        || ![...a, ...b].every((n) => Number.isInteger(n))) continue;
      if ([target.x, target.y, target.z].every((n, axis) =>
        n >= Math.min(a[axis] as number, b[axis] as number)
        && n <= Math.max(a[axis] as number, b[axis] as number))) {
        return `服务端探矿术刚给出 ${target.ore} 的绝对坐标 ${target.dimension} (${target.x},${target.y},${target.z})。`
          + 'probe 只读取客户端已收到的区块数据；隐藏矿石可能未按真实材质发来，空结果不能推翻服务端定位。'
          + '不要重复扫描这个坐标；先规划安全可达的路线，动方块前仍须做保护预检。';
      }
    }
    return null;
  }
}
