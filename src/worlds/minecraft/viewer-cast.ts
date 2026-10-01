/** Facts shown by the Minecraft viewer when the bot sends a /mycli cast command. */

const commandListeners = new WeakMap<object, Set<(text: string) => void>>();

export function publishViewerCastCommand(bot: object, text: string): void {
  for (const listener of commandListeners.get(bot) ?? []) listener(text);
}

export function observeViewerCastCommands(bot: object, listener: (text: string) => void): () => void {
  let listeners = commandListeners.get(bot);
  if (!listeners) { listeners = new Set(); commandListeners.set(bot, listeners); }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const SPELL_NAMES: Readonly<Record<string, string>> = {
  home: '归乡', blink: '闪现', selfheal: '圣愈术', heal: '治疗队友',
  food: '饱食', give: '造物术', fireworks: '烟花术', starlight: '星尘术',
  starbolt: '星芒箭', frostnova: '霜环', flamewave: '焰浪',
  golem: '守护傀儡', prospect: '探矿术', sense: '探敌',
  leap: '跃空', flight: '飞行',
  blood_mana: '燃血术', feather: '羽落之靴', night: '夜视',
};

export interface ViewerCastCommand { id: string; name: string }
export type ViewerCastResult = { phase: 'succeeded' | 'failed'; detail: string };

export function viewerCastCommand(text: unknown): ViewerCastCommand | null {
  if (typeof text !== 'string') return null;
  const match = /^\s*\/mycli\s+cast\s+([a-z0-9_:-]{1,64})(?=\s|$)/i.exec(text);
  if (!match) return null;
  const id = match[1].toLowerCase();
  return { id, name: SPELL_NAMES[id] ?? id.replaceAll('_', ' ') };
}

export function viewerCastResult(text: unknown, spellId: string): ViewerCastResult | null {
  if (typeof text !== 'string' || text.length > 1_024) return null;
  if (/(?:not|don't have) enough (?:mana|magic)|insufficient (?:mana|magic)|(?:on |in )?cooldown|you cannot (?:blink|cast|use)|cannot cast|failed to cast|\bno permission\b|魔力不足|灵力不足|冷却中|无法施放|施法失败|未学会|不能在此施法|不可在此施法|没有看得见的怪物|没有可用目标/i.test(text)) {
    return { phase: 'failed', detail: '施法受阻' };
  }
  if (spellId === 'home' && /传送到|teleported to|you have been teleported/i.test(text)) {
    return { phase: 'succeeded', detail: '传送完成' };
  }
  if ((spellId === 'selfheal' || spellId === 'heal') && /sacred healing restores|治疗成功|恢复了生命/i.test(text)) {
    return { phase: 'succeeded', detail: '治疗生效' };
  }
  if (spellId === 'food' && /feel less hungry|饥饿值已恢复|饱食生效/i.test(text)) {
    return { phase: 'succeeded', detail: '饱食生效' };
  }
  const successBySpell: Readonly<Record<string, RegExp>> = {
    golem: /守护傀儡.*(?:帮你|召唤|出现)/u,
    frostnova: /霜环.*(?:命中|冻结|冻住)/u,
    flamewave: /焰浪.*(?:命中|灼烧)/u,
    starbolt: /星芒箭.*命中/u,
    prospect: /探矿术.*(?:发现|找到|探查完成)/u,
    sense: /探敌.*(?:发现|探查|感知)/u,
    leap: /跃空.*(?:生效|腾空|跳跃)/u,
    flight: /飞行.*(?:生效|起飞|持续)/u,
  };
  if (successBySpell[spellId]?.test(text)) return { phase: 'succeeded', detail: '施法生效' };
  if (/咏唱成功|施法成功|成功施放|successfully cast/i.test(text)) {
    return { phase: 'succeeded', detail: '施法生效' };
  }
  return null;
}
