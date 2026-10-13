import type { DecisionHost, DecisionRequest } from '../../../src/protocol/typed-decision.ts';
import type { ConfigProperty } from '../../../src/core/config-schema.ts';

export interface DecisionConnection {
  /** Auto preserves configured legacy endpoints; an empty endpoint inherits the host. */
  connection?: 'auto' | 'host' | 'endpoint';
  decisionProvider?: string;
  endpoint: string;
  timeoutMs: number;
}
export const usesDecisionHost = (cfg: DecisionConnection) => cfg.connection === 'host'
  || (cfg.connection !== 'endpoint' && !cfg.endpoint.trim());
export const decisionAvailable = (cfg: DecisionConnection, host?: DecisionHost) => usesDecisionHost(cfg) ? !!host : !!cfg.endpoint.trim();
export class AdviceTransportError extends Error {
  constructor(readonly reason: 'http' | 'invalid-response', readonly status?: number) { super(reason); }
}

export async function requestAdvice(cfg: DecisionConnection, input: DecisionRequest, signal: AbortSignal,
  fetchImpl: typeof fetch, host?: DecisionHost): Promise<unknown> {
  if (usesDecisionHost(cfg)) {
    if (!host) throw new Error('Host decision API is unavailable.');
    return host.request(input, { provider: cfg.decisionProvider || undefined, signal, timeoutMs: cfg.timeoutMs });
  }
  const response = await fetchImpl(cfg.endpoint, { method: 'POST', signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok) throw new AdviceTransportError('http', response.status);
  try { return await response.json(); } catch { throw new AdviceTransportError('invalid-response'); }
}

export function decisionConnectionProperties(prefix: string): Record<string, ConfigProperty> {
  return {
    [`${prefix}.connection`]: { type: 'string', enum: ['auto', 'host', 'endpoint'], title: '快决策连接来源', 'x-hot': true,
      description: 'host 复用宿主模型连接；endpoint 使用下方旧服务地址；auto 保留已有地址，没有地址时继承宿主。' },
    [`${prefix}.decisionProvider`]: { type: 'string', title: '专用快决策连接（可选）', 'x-hot': true, 'x-options': 'decision-providers',
      description: 'host 模式引用已保存的 System One 连接；留空沿用宿主默认快决策连接。密钥与模型在连接中配置。' },
  };
}
