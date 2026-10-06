import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { observeViewerInventoryPreview } from '../../../src/worlds/minecraft/modern-viewer.ts';

const previewHarness = `class InventoryPlayerPreview {
  constructor(options) { this.options = options; globalThis.__inventoryModel = this; }
  attach(host) { this.host = host; this.active = true; }
  setVisible(visible) { this.active = visible; }
  reset() { this.active = false; }
  dispose() { this.active = false; this.disposed = true; }
} const CortiThree = {};`;
const source = previewHarness + '\n' + readFileSync(new URL('../../../scripts/minecraft-viewer-item-icon.js', import.meta.url), 'utf8')
  + '\n' + readFileSync(new URL('../../../scripts/minecraft-viewer-panels.js', import.meta.url), 'utf8');
const { JSDOM } = createRequire(import.meta.url)('jsdom');

function browser() {
  const dom = new JSDOM(`<!doctype html><button id="corti-inventory-toggle"></button>
    <section id="corti-menu" hidden><header><strong data-menu-title></strong><span data-menu-source></span>
    <button data-menu-close></button></header><div data-menu-body></div></section>`,
  { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
  const events = new Map<string, (value?: unknown) => void>();
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  Object.assign(dom.window, {
    socket: { on(name: string, callback: (value?: unknown) => void) { events.set(name, callback); } },
    entityCache: new Map(),
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimer;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval() { return 0; },
  });
  Object.defineProperty(dom.window.performance, 'now', { value: () => now });
  dom.window.eval(source);
  const inventory = Array(46).fill(null);
  inventory[36] = { name: 'diamond_sword', displayName: 'Diamond Sword', count: 1 };
  events.get('avatarState')?.({ inventory });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) {
      timers.delete(id);
      timer.callback();
    }
  };
  const emit = (name: string, value?: unknown) => events.get(name)?.(value);
  const preview = () => emit('inventoryPreview', { open: true, ttlMs: 2_400, source: 'idle' });
  const menu = dom.window.document.getElementById('corti-menu')!;
  const toggle = () => dom.window.document.getElementById('corti-inventory-toggle')!.click();
  const key = (code: string) => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code }));
  return { dom, menu, emit, preview, advance, toggle, key, timers };
}

const chest = { id: 6, type: 'minecraft:generic_9x3', title: '箱子',
  inventoryStart: 27, hotbarStart: 54, containerCount: 27, slots: Array(63).fill(null) };

describe('read-only idle inventory preview', () => {
  it('uses real avatar inventory and closes after its bounded duration', () => {
    const h = browser();
    h.preview();
    expect(h.menu.hidden).toBe(false);
    expect(h.menu.querySelector('[data-menu-source]')?.textContent).toBe('待机预览 · 只读');
    expect(h.menu.querySelector('img[src="/icons/diamond_sword.png"]')).not.toBeNull();
    h.advance(2_399);
    expect(h.menu.hidden).toBe(false);
    h.advance(1);
    expect(h.menu.hidden).toBe(true);
    expect(h.timers.size).toBe(0);
    h.emit('inventoryPreview', { open: true, ttlMs: 60_000 });
    h.advance(2_400);
    expect(h.menu.hidden).toBe(true);
    h.dom.window.close();
  });

  it.each(['button', 'keyboard'])('lets %s take ownership without a stale timeout closing it', (control) => {
    const h = browser();
    h.preview();
    if (control === 'button') h.toggle();
    else h.key('KeyE');
    expect(h.menu.getAttribute('data-inventory-source')).toBe('manual');
    expect(h.menu.querySelector('[data-menu-source]')?.textContent).toBe('玩家物品 · 只读');
    h.advance(5_000);
    h.emit('inventoryPreview', { open: false });
    h.preview();
    expect(h.menu.hidden).toBe(false);
    h.emit('entityDamage', { isSelf: true });
    expect(h.menu.hidden).toBe(false);
    h.dom.window.close();
  });

  it.each(['Escape', 'close'])('allows %s to dismiss the preview immediately', (control) => {
    const h = browser();
    h.preview();
    if (control === 'Escape') h.key('Escape');
    else (h.menu.querySelector('[data-menu-close]') as { click(): void }).click();
    expect(h.menu.hidden).toBe(true);
    expect(h.timers.size).toBe(0);
    h.dom.window.close();
  });

  it('lets a real game window replace the preview without reopening it on close', () => {
    const h = browser();
    h.preview();
    h.emit('containerState', chest);
    expect(h.menu.querySelector('[data-menu-title]')?.textContent).toBe('箱子');
    expect(h.menu.getAttribute('data-inventory-source')).toBe('container');
    h.preview();
    h.advance(3_000);
    expect(h.menu.hidden).toBe(false);
    h.emit('containerState', null);
    expect(h.menu.hidden).toBe(true);
    h.dom.window.close();
  });

  it.each([
    ['entityDamage', { isSelf: true }], ['tacticalAttack', { id: 9 }],
    ['combatFeedback', { damage: 2 }], ['rangedUse', { phase: 'draw' }],
    ['disconnect', undefined], ['viewerReset', undefined],
  ])('cancels idle preview on %s', (event, value) => {
    const h = browser();
    h.preview();
    h.emit(event, value);
    expect(h.menu.hidden).toBe(true);
    h.advance(5_000);
    expect(h.menu.hidden).toBe(true);
    h.dom.window.close();
  });

  it('suppresses a preview during recent combat and allows it when combat expires', () => {
    const h = browser();
    h.emit('entityDamage', { isSelf: false });
    h.preview();
    expect(h.menu.hidden).toBe(false);
    h.emit('rangedUse', { phase: 'release' });
    h.preview();
    expect(h.menu.hidden).toBe(true);
    h.advance(5_000);
    h.preview();
    expect(h.menu.hidden).toBe(false);
    h.dom.window.close();
  });

  it('keeps the equipped player preview attached during idle/manual ownership and releases it on close', () => {
    const h = browser();
    const avatar = { playerObject: {}, originalEntity: { id: 15 } };
    Object.assign(h.dom.window, { world: { entities: { entities: { '15': avatar } } } });
    h.emit('avatarState', { entity: { id: 15 }, inventory: Array(46).fill(null) });
    h.preview();
    const model = h.dom.window.__inventoryModel;
    const host = h.menu.querySelector('[data-inventory-player-preview]');
    expect(host?.getAttribute('aria-label')).toBe('玩家皮肤与当前装备预览');
    expect(model.host).toBe(host);
    expect(model.options.resolveSource()).toBe(avatar);
    expect(model.active).toBe(true);
    h.toggle();
    expect(h.dom.window.__inventoryModel).toBe(model);
    h.advance(3_000);
    expect(model.active).toBe(true);
    h.key('Escape');
    expect(model.active).toBe(false);
    h.dom.window.close();
  });

  it('releases the player preview when a container replaces the inventory', () => {
    const h = browser();
    h.preview();
    const model = h.dom.window.__inventoryModel;
    h.emit('containerState', chest);
    expect(model.active).toBe(false);
    expect(h.menu.querySelector('[data-inventory-player-preview]')).toBeNull();
    h.dom.window.close();
  });

  it('retains page lifecycle and reset cleanup for a manually opened player preview', () => {
    const h = browser();
    h.toggle();
    const model = h.dom.window.__inventoryModel;
    h.emit('viewerReset');
    expect(model.active).toBe(false);
    expect(h.menu.hidden).toBe(false);
    h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow'));
    expect(model.active).toBe(true);
    h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pagehide', { persisted: true }));
    expect(model.disposed).not.toBe(true);
    expect(model.active).toBe(false);
    h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pageshow'));
    expect(model.active).toBe(true);
    h.dom.window.dispatchEvent(new h.dom.window.PageTransitionEvent('pagehide'));
    expect(model.disposed).toBe(true);
    h.dom.window.close();
  });
});

describe('viewer idle inventory host cues', () => {
  it('publishes only local preview cues and releases on real windows, disconnect and disposal', () => {
    const bot = Object.assign(new EventEmitter(), { currentWindow: null as unknown });
    const events: unknown[] = [];
    const stop = observeViewerInventoryPreview(bot, event => events.push(event));
    bot.emit('viewer_inventory_preview', { open: 'true' });
    expect(events).toEqual([]);
    bot.emit('viewer_inventory_preview', { open: true });
    expect(bot.currentWindow).toBeNull();
    expect(events.at(-1)).toEqual({ open: true, ttlMs: 2_400, source: 'idle' });
    bot.currentWindow = chest;
    bot.emit('windowOpen', chest);
    expect(events.at(-1)).toMatchObject({ open: false });
    const count = events.length;
    bot.emit('viewer_inventory_preview', { open: true });
    expect(events).toHaveLength(count);
    bot.currentWindow = null;
    bot.emit('viewer_inventory_preview', { open: true });
    bot.emit('end');
    expect(events.at(-1)).toMatchObject({ open: false });
    bot.emit('viewer_inventory_preview', { open: true });
    stop();
    expect(events.at(-1)).toMatchObject({ open: false });
    expect(bot.eventNames()).toEqual([]);
  });
});
