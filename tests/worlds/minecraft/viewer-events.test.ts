import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const source = readFileSync(new URL('../../../scripts/minecraft-viewer-events.js', import.meta.url), 'utf8');

describe('Minecraft viewer game feedback', () => {
  it('expires a skill experience boss bar while keeping a real boss bar', () => {
    const dom = new JSDOM(`<!doctype html><div id="corti-event-feed"></div>
      <div id="corti-boss-bars"></div><div id="corti-game-title"><strong data-game-title></strong>
      <span data-game-subtitle></span></div><div id="corti-actionbar"></div>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const timers: Array<() => void> = [];
    dom.window.setTimeout = ((callback: () => void) => { timers.push(callback); return timers.length; }) as typeof dom.window.setTimeout;
    const events = new Map<string, (event: unknown) => void>();
    dom.window.socket = { on: (name: string, callback: (event: unknown) => void) => events.set(name, callback) };
    dom.window.eval(source);
    events.get('bossBars')?.([
      { title: '采矿经验 +3', progress: 0.6, color: 'green' },
      { title: '凋灵', progress: 0.8, color: 'purple' },
    ]);
    const bars = dom.window.document.getElementById('corti-boss-bars')!;
    expect(bars.children).toHaveLength(2);
    expect(timers).toHaveLength(1);
    timers[0]();
    expect(bars.textContent).toBe('凋灵');
    dom.window.close();
  });

  it('limits system-message bursts while keeping chat, titles and self damage', () => {
    const dom = new JSDOM(`<!doctype html><div id="corti-event-feed"></div>
      <div id="corti-boss-bars"></div><div id="corti-game-title" hidden>
      <strong data-game-title></strong><span data-game-subtitle></span></div>
      <div id="corti-actionbar" hidden></div>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (event: unknown) => void>();
    Object.assign(dom.window, { socket: { on(name: string, callback: (event: unknown) => void) {
      events.set(name, callback);
    } } });
    dom.window.eval(source);
    const message = events.get('gameMessage')!;
    for (let index = 0; index < 5; index++) message({ kind: 'system', text: `提示 ${index}` });
    const feed = dom.window.document.getElementById('corti-event-feed')!;
    expect(feed.children).toHaveLength(2);
    expect(feed.textContent).not.toContain('提示 2');
    message({ kind: 'system', text: '提示 0' });
    message({ kind: 'system', text: 'https://example.invalid/debug' });
    expect(feed.children).toHaveLength(2);
    message({ kind: 'whisper', text: '<script>alert(1)</script>' });
    expect(feed.querySelector('script')).toBeNull();
    expect(feed.lastElementChild?.textContent).toContain('<script>alert(1)</script>');
    message({ kind: 'title', text: '试炼开始' });
    const title = dom.window.document.getElementById('corti-game-title')!;
    expect(title.hidden).toBe(false);
    expect(title.querySelector('[data-game-title]')?.textContent).toBe('试炼开始');
    message({ kind: 'subtitle', text: '存活到黎明' });
    expect(title.querySelector('[data-game-subtitle]')?.textContent).toBe('存活到黎明');
    message({ kind: 'actionbar', text: '魔力不足' });
    expect(dom.window.document.getElementById('corti-actionbar')?.textContent).toBe('魔力不足');
    expect(feed.textContent).not.toContain('魔力不足');
    events.get('bossBars')?.([{ title: '伐树经验', progress: 0.51, color: 'green' }]);
    const bars = dom.window.document.getElementById('corti-boss-bars')!;
    expect(bars.textContent).toBe('伐树经验');
    expect(bars.querySelector('.corti-boss-fill')?.getAttribute('style')).toContain('width: 51%');
    events.get('bossBars')?.([]);
    expect(bars.children).toHaveLength(0);
    events.get('entityDamage')?.({ isSelf: false });
    expect(dom.window.document.body.classList.contains('corti-took-damage')).toBe(false);
    events.get('entityDamage')?.({ isSelf: true });
    expect(dom.window.document.body.classList.contains('corti-took-damage')).toBe(true);
    dom.window.close();
  });

  it('clears stale boss bars when the view resets or disconnects', () => {
    const dom = new JSDOM(`<!doctype html><div id="corti-event-feed"></div>
      <div id="corti-boss-bars"></div><div id="corti-game-title"><strong data-game-title></strong>
      <span data-game-subtitle></span></div><div id="corti-actionbar"></div>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const events = new Map<string, (event?: unknown) => void>();
    dom.window.socket = { on: (name: string, callback: (event?: unknown) => void) => {
      const previous = events.get(name);
      events.set(name, previous ? event => { previous(event); callback(event); } : callback);
    } };
    dom.window.eval(source);
    const bars = dom.window.document.getElementById('corti-boss-bars')!;
    const current = [{ title: '试炼守卫', progress: 0.5, color: 'purple' }];
    events.get('bossBars')?.(current);
    events.get('viewerReset')?.();
    expect(bars.children).toHaveLength(0);
    events.get('bossBars')?.(current);
    events.get('disconnect')?.();
    expect(bars.children).toHaveLength(0);
    events.get('avatarState')?.({ burning: true });
    expect(dom.window.document.querySelector('.corti-self-fire')?.hidden).toBe(false);
    events.get('avatarState')?.({ burning: false });
    expect(dom.window.document.querySelector('.corti-self-fire')?.hidden).toBe(true);
    dom.window.close();
  });
});
