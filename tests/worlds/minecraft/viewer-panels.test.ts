import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { assertMinimapArrowOrientation } from '../../../scripts/minecraft-viewer-bundle-check.mjs';

// JSDOM exercises panel lifecycle without a WebGL context.
const previewHarness = `class InventoryPlayerPreview {
  constructor(options) { this.options = options; }
  attach(host) { this.host = host; this.active = true; }
  setVisible(visible) { this.active = visible; }
  reset() { this.active = false; }
  dispose() { this.active = false; this.disposed = true; }
} const CortiThree = {};`;
const source = previewHarness + '\n' + readFileSync(new URL('../../../scripts/minecraft-viewer-item-icon.js', import.meta.url), 'utf8')
  + '\n' + readFileSync(new URL('../../../scripts/minecraft-viewer-panels.js', import.meta.url), 'utf8');
const { JSDOM } = createRequire(import.meta.url)('jsdom');

describe('read-only viewer panels', () => {
  it('checks the generated bundle for the north-up map arrow', () => {
    const correct = 'r.rotate(-(Number(Ad.entity.yaw)||0)),r.fillStyle="#162c2d"';
    const reversed = 'r.rotate((Number(Ad.entity.yaw)||0)+Math.PI),r.fillStyle="#162c2d"';
    expect(() => assertMinimapArrowOrientation(correct)).not.toThrow();
    expect(() => assertMinimapArrowOrientation(reversed)).toThrow(/小地图箭头方向/);
  });

  it.skipIf(!process.env.MINECRAFT_VIEWER_BUNDLE_FILE)('checks the complete generated viewer bundle', () => {
    expect(() => assertMinimapArrowOrientation(
      readFileSync(process.env.MINECRAFT_VIEWER_BUNDLE_FILE!, 'utf8'),
    )).not.toThrow();
  });

  it('docks an automatic container during combat and keeps a dismissed window closed', () => {
    const dom = new JSDOM(`<!doctype html><button id="corti-inventory-toggle"></button>
      <section id="corti-menu" hidden><header><strong data-menu-title></strong><span data-menu-source></span>
      <button data-menu-close></button></header><div data-menu-body></div></section>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (value: unknown) => void>();
    Object.assign(dom.window, { socket: { on(name: string, handler: (value: unknown) => void) {
      events.set(name, handler);
    } }, entityCache: new Map() });
    dom.window.eval(source);
    const state = { id: 5, type: 'minecraft:generic_9x3', title: '箱子',
      inventoryStart: 27, hotbarStart: 54, containerCount: 27, slots: Array(63).fill(null) };
    const menu = dom.window.document.getElementById('corti-menu')!;
    events.get('containerState')?.(state);
    expect(menu.hidden).toBe(false);
    expect(menu.getAttribute('data-compact')).toBe('false');
    events.get('entityDamage')?.({ isSelf: true });
    expect(menu.getAttribute('data-compact')).toBe('true');
    (menu.querySelector('[data-menu-close]') as { click(): void }).click();
    events.get('containerState')?.({ ...state, slots: [...state.slots] });
    expect(menu.hidden).toBe(true);
    events.get('containerState')?.({ ...state, id: 6 });
    expect(menu.hidden).toBe(false);
    dom.window.document.getElementById('corti-inventory-toggle')!.click();
    expect(menu.getAttribute('data-compact')).toBe('true');
    dom.window.close();
  });

  it('keeps the player centered while the terrain sample catches up', () => {
    const dom = new JSDOM('<aside id="corti-minimap"><canvas width="200" height="200"></canvas><div data-map-caption></div></aside>',
      { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (value: unknown) => void>();
    const translations: Array<[number, number]> = [];
    const context = { fillRect() {}, beginPath() {}, arc() {}, fill() {}, save() {}, restore() {},
      moveTo() {}, lineTo() {}, closePath() {}, rotate() {}, fillText() {},
      translate(x: number, z: number) { translations.push([x, z]); } };
    const canvas = dom.window.document.querySelector('canvas')!;
    Object.defineProperty(canvas, 'getContext', { value: () => context });
    Object.assign(dom.window, { socket: { on(name: string, handler: (value: unknown) => void) {
      events.set(name, handler);
    } }, entityCache: new Map() });
    dom.window.eval(source);
    events.get('minimap')?.({ centerX: 0, centerZ: 0, radius: 12, sampleY: 64,
      dimension: 'minecraft:overworld', cells: 'G'.repeat(625) });
    events.get('avatarState')?.({ entity: { id: 1, pos: { x: 18.25, z: -4.5 }, yaw: 0 } });
    dom.window.eval('cortiDrawMinimap()');
    expect(translations.at(-1)).toEqual([100, 100]);
    expect(dom.window.document.querySelector('[data-map-caption]')?.textContent).toContain('18, -5');
  });

  it('points the player arrow toward map north, east, south and west', () => {
    const dom = new JSDOM('<aside id="corti-minimap"><canvas width="200" height="200"></canvas><div data-map-caption></div></aside>',
      { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (value: unknown) => void>();
    const tips: Array<[number, number]> = [];
    let originX = 0, originZ = 0, rotation = 0;
    const context = { fillRect() {}, beginPath() {}, arc() {}, fill() {}, save() {},
      restore() { originX = 0; originZ = 0; rotation = 0; },
      translate(x: number, z: number) { originX += x; originZ += z; },
      rotate(angle: number) { rotation += angle; },
      moveTo(x: number, z: number) {
        tips.push([originX + x * Math.cos(rotation) - z * Math.sin(rotation),
          originZ + x * Math.sin(rotation) + z * Math.cos(rotation)]);
      },
      lineTo() {}, closePath() {}, fillText() {} };
    Object.defineProperty(dom.window.document.querySelector('canvas'), 'getContext',
      { value: () => context });
    Object.assign(dom.window, { socket: { on(name: string, handler: (value: unknown) => void) {
      events.set(name, handler);
    } }, entityCache: new Map() });
    dom.window.eval(source);
    events.get('minimap')?.({ centerX: 0, centerZ: 0, radius: 12, sampleY: 64,
      dimension: 'minecraft:overworld', cells: 'G'.repeat(625) });
    for (const [yaw, expected] of [
      [0, [100, 90]], [-Math.PI / 2, [110, 100]],
      [Math.PI, [100, 110]], [Math.PI / 2, [90, 100]],
    ] as Array<[number, [number, number]]>) {
      events.get('avatarState')?.({ entity: { id: 1, pos: { x: 0.5, z: 0.5 }, yaw } });
      dom.window.eval('cortiDrawMinimap()');
      expect(tips.at(-2)?.map(Math.round)).toEqual(expected);
    }
    dom.window.close();
  });

  it('shows merchant prices, stock and the original 1.20.6 trade screen', () => {
    const dom = new JSDOM(`<!doctype html><section id="corti-menu" hidden>
      <header><strong data-menu-title></strong><span data-menu-source></span><button data-menu-close></button></header>
      <div data-menu-body></div></section>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (value: unknown) => void>();
    Object.assign(dom.window, { socket: { on(name: string, handler: (value: unknown) => void) {
      events.set(name, handler);
    } }, entityCache: new Map() });
    dom.window.eval(source);
    const item = (name: string, count: number) => ({ name, displayName: name, count });
    events.get('containerState')?.({ id: 12, type: 'minecraft:merchant', title: '村民交易',
      inventoryStart: 3, hotbarStart: 30, containerCount: 3, slots: Array(39).fill(null),
      trades: { windowId: 12, level: 3, regularVillager: true, offers: [
        { input: item('emerald', 4), secondInput: null, output: item('bread', 2),
          realPrice: 3, uses: 1, maxUses: 8, disabled: false },
        { input: item('emerald', 2), secondInput: item('book', 1),
          output: item('enchanted_book', 1), realPrice: null,
          uses: 6, maxUses: 6, disabled: true },
      ] } });
    const menu = dom.window.document.getElementById('corti-menu')!;
    expect(menu.hidden).toBe(false);
    expect(menu.querySelector('.corti-menu-vanilla')?.getAttribute('style'))
      .toContain('villager.png');
    expect(menu.querySelectorAll('.corti-trade-row')).toHaveLength(2);
    expect(menu.querySelector('.corti-trade-row')?.getAttribute('title'))
      .toContain('emerald ×3');
    expect(menu.querySelector('.corti-trade-row.is-disabled')?.getAttribute('title'))
      .toContain('已售罄');
    expect(menu.querySelectorAll('.corti-menu-slot')).toHaveLength(44);
    expect(menu.textContent).toContain('村民等级 3');
  });

  it('uses the exported 1.20.6 textures for vanilla container types', () => {
    const dom = new JSDOM(`<!doctype html><section id="corti-menu" hidden>
      <header><strong data-menu-title></strong><span data-menu-source></span><button data-menu-close></button></header>
      <div data-menu-body></div></section>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (value: unknown) => void>();
    Object.assign(dom.window, { socket: { on(name: string, handler: (value: unknown) => void) {
      events.set(name, handler);
    } }, entityCache: new Map() });
    dom.window.eval(source);
    const cases: Array<[string, number, string]> = [
      ['minecraft:generic_9x1', 9, 'generic_54.png'],
      ['minecraft:generic_9x3', 27, 'generic_54.png'],
      ['minecraft:generic_9x6', 54, 'generic_54.png'],
      ['minecraft:generic_3x3', 9, 'dispenser.png'],
      ['minecraft:crafter_3x3', 10, 'crafter.png'],
      ['minecraft:shulker_box', 27, 'shulker_box.png'],
      ['minecraft:anvil', 3, 'anvil.png'],
      ['minecraft:beacon', 1, 'beacon.png'],
      ['minecraft:brewing_stand', 5, 'brewing_stand.png'],
      ['minecraft:enchantment', 2, 'enchanting_table.png'],
      ['minecraft:grindstone', 3, 'grindstone.png'],
      ['minecraft:hopper', 5, 'hopper.png'],
      ['minecraft:loom', 4, 'loom.png'],
      ['minecraft:smithing', 3, 'smithing.png'],
      ['minecraft:cartography', 3, 'cartography_table.png'],
      ['minecraft:stonecutter', 2, 'stonecutter.png'],
      ['EntityHorse', 17, 'horse.png'],
    ];
    const menu = dom.window.document.getElementById('corti-menu')!;
    for (const [type, count, texture] of cases) {
      events.get('containerState')?.({ id: 20, type, title: type, containerCount: count,
        slots: Array(count + 36).fill(null), inventoryStart: count, hotbarStart: count + 27 });
      expect(menu.querySelector('.corti-menu-vanilla'), type).not.toBeNull();
      expect(menu.innerHTML, type).toContain(texture);
      expect(menu.querySelectorAll('.corti-menu-slot').length, type).toBe(count + 36);
    }
  });

  it('lets viewers read pages of a lectern book', () => {
    const dom = new JSDOM(`<!doctype html><section id="corti-menu" hidden>
      <header><strong data-menu-title></strong><span data-menu-source></span><button data-menu-close></button></header>
      <div data-menu-body></div></section>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (value: unknown) => void>();
    Object.assign(dom.window, { socket: { on(name: string, handler: (value: unknown) => void) {
      events.set(name, handler);
    } }, entityCache: new Map() });
    dom.window.eval(source);
    const slots = Array(37).fill(null);
    slots[0] = { name: 'written_book', displayName: '世界指引', components: [
      { type: 'written_book_content', data: { pages: [
        { raw: '{"text":"第一页"}' }, { raw: '{"text":"第二页"}' },
      ] } },
    ] };
    events.get('containerState')?.({ id: 22, type: 'minecraft:lectern', title: '书',
      slots, containerCount: 1, inventoryStart: 1, hotbarStart: 28 });
    const menu = dom.window.document.getElementById('corti-menu')!;
    expect(menu.querySelector('.corti-menu-book-page')?.textContent).toBe('第一页');
    (menu.querySelector('.corti-menu-book footer button:last-child') as { click(): void }).click();
    expect(menu.querySelector('.corti-menu-book-page')?.textContent).toBe('第二页');
  });

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
    expect(dom.window.document.querySelector('[data-ability-list]')?.textContent).toContain('伐木术');
    expect(dom.window.document.querySelector('.corti-ability')?.getAttribute('data-state')).toBe('unknown');
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
    expect(dom.window.document.querySelector('[data-mana]')?.textContent).toBe('魔力 6/32');
    events.get('skillsState')?.({ schemaVersion: 1, mana: { current: 6, max: 32 },
      skills: [], abilities: [], source: 'chat', observedAt: Date.now() - 121_000 });
    expect(dom.window.document.querySelector('[data-mana]')?.textContent).toBe('魔力 6/32');
    expect(dom.window.document.querySelector('[data-mana-fill]')?.getAttribute('style')).toContain('18.75%');
    expect(dom.window.document.querySelector('[data-skill-status]')?.textContent).toContain('上次读数 6/32');
    events.get('skillsState')?.({ schemaVersion: 1, mana: { current: 14, max: 32 },
      skills: [], abilities: [], source: 'plugin', observedAt: Date.now() });
    expect(dom.window.document.querySelector('[data-mana]')?.textContent).toBe('魔力 14/32');
  });

  it('renders private skill icons with distinct cooldown, ready, mana and unknown states', () => {
    const dom = new JSDOM(`<!doctype html><section id="corti-skills"><span data-mana></span>
      <div data-skill-list></div><div data-ability-list></div><small data-skill-status></small></section>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (value: unknown) => void>();
    Object.assign(dom.window, { socket: { on(name: string, handler: (value: unknown) => void) {
      events.set(name, handler);
    } }, entityCache: new Map() });
    dom.window.eval(source);
    const abilities = [
      { id: 'mycli:starbolt', name: '星芒箭', icon: 'amethyst_shard', cooldownMs: 3000,
        cooldownRemainingMs: 1750, manaCost: 4 },
      { id: 'mycli:frostnova', name: '霜环', icon: 'blue_ice', cooldownMs: 14000,
        cooldownRemainingMs: 0, manaCost: 7 },
      { id: 'mycli:flamewave', name: '焰浪', cooldownMs: 10000,
        cooldownRemainingMs: null, manaCost: 3 },
    ];
    events.get('skillsState')?.({ schemaVersion: 1, mana: { current: 5, max: 32 },
      skills: [], abilities, source: 'plugin', observedAt: Date.now() });
    const icons = [...dom.window.document.querySelectorAll('.corti-ability')];
    expect(icons[0].querySelector('img')?.getAttribute('src')).toBe('/icons/amethyst_shard.png');
    expect(icons.map((icon) => icon.getAttribute('data-state'))).toEqual(['cooldown', 'mana', 'unknown']);
    expect(icons[0].querySelector('.corti-ability-overlay')?.textContent).toBe('2');
    expect(icons[1].querySelector('.corti-ability-overlay')?.textContent).toBe('⊘');
    events.get('skillsState')?.({ schemaVersion: 1, mana: { current: 12, max: 32 },
      skills: [], abilities: abilities.map((ability) => ({ ...ability, cooldownRemainingMs: 0 })),
      source: 'plugin', observedAt: Date.now() });
    expect([...dom.window.document.querySelectorAll('.corti-ability')]
      .map((icon) => icon.getAttribute('data-state'))).toEqual(['ready', 'ready', 'ready']);
    events.get('skillsState')?.({ schemaVersion: 1, mana: null, skills: [], abilities: [],
      source: 'plugin', observedAt: Date.now() });
    expect(dom.window.document.querySelectorAll('.corti-ability')).toHaveLength(0);
  });

  it('lets the viewer browse the complete roster and choose persistent favorites', () => {
    const dom = new JSDOM(`<!doctype html><aside id="corti-skills"><span data-mana></span>
      <div data-skill-list></div><div data-ability-list></div><small data-skill-status></small></aside>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (value: unknown) => void>();
    Object.assign(dom.window, { socket: { on(name: string, handler: (value: unknown) => void) {
      events.set(name, handler);
    } }, entityCache: new Map() });
    dom.window.eval(source);
    const abilities = Array.from({ length: 27 }, (_, index) => ({
      id: `mycli:spell_${index}`, name: `技能${index}`, cooldownRemainingMs: 0,
    }));
    events.get('skillsState')?.({ schemaVersion: 1, mana: { current: 20, max: 20 },
      skills: [], abilities, source: 'plugin', observedAt: Date.now() });
    const document = dom.window.document;
    expect(document.querySelectorAll('.corti-ability')).toHaveLength(8);
    expect(document.querySelector('[data-corti-ability-count]')?.textContent).toBe('常用 8 / 全部 27');
    const toggle = document.querySelector('[data-corti-ability-toggle]') as
      { click(): void; getAttribute(name: string): string | null };
    toggle.click();
    expect(document.querySelectorAll('.corti-ability')).toHaveLength(27);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    (document.querySelector('[data-ability-id="mycli:spell_26"]') as { click(): void }).click();
    expect(dom.window.localStorage.getItem('minecraft.viewer.pinnedAbilities.v1')).toContain('mycli:spell_26');
    toggle.click();
    expect(document.querySelectorAll('.corti-ability')).toHaveLength(9);
    expect(document.querySelector('[data-ability-id="mycli:spell_26"]')).not.toBeNull();
    dom.window.close();
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
