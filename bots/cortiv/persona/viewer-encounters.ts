/** Short-lived social evidence, separate from profiles and preserved across context handoff. */
import type { EventEnvelope } from 'cortico/core/types.ts';
import { estimateTokens } from 'cortico/core/util.ts';

export const VIEWER_ENCOUNTER_LIMITS = { identities: 8, tokens: 600 };

interface Encounter {
  source: string;
  key: string;
  name: string;
  scope: string;
  firstAt: string;
  latestAt: string;
  latestCursor: number;
  latestType: string;
  arrivalSignals: number;
  previousArrivalAt?: string;
  arrivalAt?: string;
  chatAt?: string;
}

export class ViewerEncounters {
  private readonly people = new Map<string, Encounter>();

  observe(event: EventEnvelope): string {
    if (event.origin !== 'external' || event.contextDelivery === 'archive-only' || !event.source || !event.senderKey) return '';
    const arrival = event.type === `${event.source}.enter` || event.type === `${event.source}.enter-guard`;
    const chat = event.type === `${event.source}.chat` || event.type === `${event.source}.danmaku` || event.type === `${event.source}.superchat`;
    const departure = event.type === `${event.source}.leave`;
    const playerObservation = event.meta?.minecraftPlayerObservation;
    if (!arrival && !chat && !departure && !playerObservation) return '';
    const identity = `${event.source}/${event.senderKey}`;
    const previous = this.people.get(identity);
    // Replaying archived deliveries or observing a stale event must not turn it into a new visit.
    if (previous && event.cursor <= previous.latestCursor) return '';
    const scope = event.meta?.socialScope === 'live-room' ? '直播间'
      : event.meta?.socialScope === 'minecraft-server' || playerObservation ? 'Minecraft 服务器'
        : previous?.scope ?? '范围未标注（按事件来源核对）';
    const person: Encounter = { ...previous, source: event.source, key: event.senderKey,
      name: typeof event.meta?.uname === 'string' ? event.meta.uname.slice(0, 80) : previous?.name ?? '',
      scope, firstAt: previous?.firstAt ?? event.ts, latestAt: event.ts,
      latestCursor: event.cursor, latestType: event.type, arrivalSignals: previous?.arrivalSignals ?? 0 };
    if (arrival) {
      person.arrivalSignals++;
      person.previousArrivalAt = previous?.arrivalAt;
      person.arrivalAt = event.ts;
    }
    if (chat) person.chatAt = event.ts;
    this.people.delete(identity);
    this.people.set(identity, person);
    while (this.people.size > VIEWER_ENCOUNTER_LIMITS.identities) this.people.delete(this.people.keys().next().value!);
    return this.line(person);
  }

  clear(): void { this.people.clear(); }

  text(): string {
    if (!this.people.size) return '';
    let text = '[交流身份] 以下是本进程实际收到的账号事件，交接不重置。来源/账号分别核对；昵称相似不证明跨平台为同一人。事件记录不证明此刻在线、附近或已回复。';
    for (const person of [...this.people.values()].reverse()) {
      const line = this.line(person);
      if (estimateTokens(text + '\n' + line) > VIEWER_ENCOUNTER_LIMITS.tokens) continue;
      text += '\n' + line;
    }
    return text;
  }

  private line(person: Encounter): string {
    return `${person.source}/${person.key}${person.name ? `「${person.name}」` : ''}；范围=${person.scope}；`
      + `本进程首次观察=${person.firstAt}；最新事件=${person.latestType} #${person.latestCursor} @${person.latestAt}；`
      + `进场信号=${person.arrivalSignals} 次`
      + (person.previousArrivalAt ? `（前次=${person.previousArrivalAt}）` : '')
      + (person.chatAt ? `；最近发言=${person.chatAt}` : '；尚无本进程发言记录');
  }
}
