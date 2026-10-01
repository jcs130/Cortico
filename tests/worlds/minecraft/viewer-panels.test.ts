import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../scripts/minecraft-viewer-item-icon.js', import.meta.url), 'utf8')
  + '\n' + readFileSync(new URL('../../../scripts/minecraft-viewer-panels.js', import.meta.url), 'utf8');
const { JSDOM } = createRequire(import.meta.url)('jsdom');

describe('read-only viewer panels', () => {
  it('opens a full inventory and follows a furnace window with live progress', () => {
    const dom = new JSDOM(`<!doctype html><button id="corti-inventory-toggle"></button>
      <section id="corti-menu" hidden><header><strong data-menu-title></strong><span data-menu-source></span>
      <button data-menu-close></button></header><div data-menu-body></div></section>
      <aside id="corti-skills"><span data-mana></span><div data-skill-list></div><div data-ability-list></div><small data-skill-status></small></aside>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (value: unknown) => void>();
    Object.assign(dom.window, { socket: { on(name: string, handler: (value: unknown) => void) {
      events.set(name, handler);
    } }, entityCache: new Map() });
    dom.window.eval(source);

    const item = (name: string, count: number) => ({ name, displayName: name, count });
    const inventory = Array(46).fill(null);
    inventory[36] = item('oak_log', 12);
    events.get('avatarState')?.({ inventory, entity: { id: 1, pos: { x: 0, z: 0 } } });
    dom.window.document.getElementById('corti-inventory-toggle')!.click();
    const menu = dom.window.document.getElementById('corti-menu')!;
    expect(menu.hidden).toBe(false);
    expect(menu.querySelector('[data-menu-title]')?.textContent).toBe('背包');
    expect(menu.querySelector('img[src="/icons/oak_log.png"]')).not.toBeNull();
    expect(menu.querySelectorAll('.corti-menu-slot')).toHaveLength(46);

    const slots = Array(39).fill(null);
    slots[0] = item('iron_ore', 3);
    slots[1] = item('coal', 2);
    slots[2] = item('iron_ingot', 1);
    events.get('containerState')?.({ id: 4, type: 'minecraft:furnace', title: 'Furnace',
      slots, inventoryStart: 3, hotbarStart: 30, furnace: { burn: .5, cook: .25 } });
    expect(menu.querySelector('[data-menu-title]')?.textContent).toBe('Furnace');
    expect(menu.querySelector('img[src="/icons/iron_ore.png"]')).not.toBeNull();
    expect(menu.querySelector('img[src="/icons/coal.png"]')).not.toBeNull();
    expect(menu.querySelector('img[src="/icons/iron_ingot.png"]')).not.toBeNull();
    expect(menu.querySelectorAll('.corti-menu-progress')).toHaveLength(2);
    events.get('containerState')?.(null);
    expect(menu.querySelector('[data-menu-title]')?.textContent).toBe('背包');
    menu.querySelector('button[data-menu-close]')?.dispatchEvent(new dom.window.MouseEvent('click'));
    expect(menu.hidden).toBe(true);
  });

  it('shows only server-provided mana and skill levels', () => {
    const dom = new JSDOM(`<!doctype html><button id="corti-inventory-toggle"></button>
      <section id="corti-menu" hidden><header><strong data-menu-title></strong><span data-menu-source></span>
      <button data-menu-close></button></header><div data-menu-body></div></section>
      <aside id="corti-skills"><span data-mana></span><div data-skill-list></div><div data-ability-list></div><small data-skill-status></small></aside>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (value: unknown) => void>();
    Object.assign(dom.window, { socket: { on(name: string, handler: (value: unknown) => void) {
      events.set(name, handler);
    } }, entityCache: new Map() });
    dom.window.eval(source);
    expect(dom.window.document.querySelector('[data-skill-status]')?.textContent)
      .toContain('暂无服务端技能数据');
    events.get('skillsState')?.({ schemaVersion: 1, mana: { current: 37, max: 80 },
      skills: [{ id: 'farming', name: '耕作', level: 12, xp: 78, requiredXp: 120 }],
      abilities: [{ id: 'tree_feller', name: '伐木术', level: 2, cooldownMs: 4200 }] });
    expect(dom.window.document.querySelector('[data-mana]')?.textContent).toBe('魔力 37/80');
    expect(dom.window.document.querySelector('[data-skill-list]')?.textContent).toContain('耕作 Lv.12');
    expect(dom.window.document.querySelector('[data-ability-list]')?.textContent).toContain('伐木术Lv.2 · 5s');
  });

  it('marks an old mana reading as stale until the server sends a new one', () => {
    const dom = new JSDOM(`<!doctype html><button id="corti-inventory-toggle"></button>
      <section id="corti-menu" hidden><header><strong data-menu-title></strong><span data-menu-source></span>
      <button data-menu-close></button></header><div data-menu-body></div></section>
      <aside id="corti-skills"><span data-mana></span><div class="corti-mana-bar"><span data-mana-fill></span></div>
      <div data-skill-list></div><div data-ability-list></div><small data-skill-status></small></aside>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (value: unknown) => void>();
    Object.assign(dom.window, { socket: { on(name: string, handler: (value: unknown) => void) {
      events.set(name, handler);
    } }, entityCache: new Map() });
    dom.window.eval(source);
    events.get('skillsState')?.({ schemaVersion: 1, mana: { current: 6, max: 32 },
      skills: [], abilities: [], source: 'chat', observedAt: Date.now() - 11_000 });
    expect(dom.window.document.querySelector('[data-mana]')?.textContent).toBe('魔力待同步');
    expect(dom.window.document.querySelector('[data-mana-fill]')?.getAttribute('style')).toContain('0%');
    expect(dom.window.document.querySelector('[data-skill-status]')?.textContent).toContain('上次读数 6/32');
    events.get('skillsState')?.({ schemaVersion: 1, mana: { current: 14, max: 32 },
      skills: [], abilities: [], source: 'plugin', observedAt: Date.now() });
    expect(dom.window.document.querySelector('[data-mana]')?.textContent).toBe('魔力 14/32');
  });

  it('shows the custom head name and overlays the profile skin face', () => {
    const dom = new JSDOM(`<!doctype html><button id="corti-inventory-toggle"></button>
      <section id="corti-menu" hidden><header><strong data-menu-title></strong><span data-menu-source></span>
      <button data-menu-close></button></header><div data-menu-body></div></section>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (value: unknown) => void>();
    Object.assign(dom.window, { socket: { on(name: string, handler: (value: unknown) => void) {
      events.set(name, handler);
    } }, entityCache: new Map() });
    dom.window.eval(source);
    const inventory = Array(46).fill(null);
    inventory[36] = { name: 'player_head', displayName: '大背包', count: 1,
      headTextureHash: 'a'.repeat(64) };
    events.get('avatarState')?.({ inventory });
    dom.window.document.getElementById('corti-inventory-toggle')!.click();
    const slot = dom.window.document.querySelector('.corti-menu-slot[title="大背包 × 1"]');
    expect(slot).not.toBeNull();
    const face = slot?.querySelector('.corti-head-face') as { style: { backgroundImage: string } } | null;
    expect(face?.style.backgroundImage).toContain('/head-texture/');
    expect(slot?.querySelector('img[src="/icons/player_head.png"]')).not.toBeNull();
  });
});
