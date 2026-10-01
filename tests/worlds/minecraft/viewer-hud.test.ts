import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const source = readFileSync(new URL('../../../scripts/minecraft-viewer-item-icon.js', import.meta.url), 'utf8')
  + '\n' + readFileSync(new URL('../../../scripts/minecraft-viewer-hud.js', import.meta.url), 'utf8');

describe('Minecraft viewer survival HUD', () => {
  it('updates the sword durability bar when damage changes without changing slots', () => {
    const dom = new JSDOM(`<!doctype html><div id="corti-survival">
      <div data-corti-hearts></div><div data-corti-food></div><div data-corti-armor></div>
      <div data-corti-air></div><span data-corti-level></span><div data-corti-xp></div>
      <div data-corti-selection></div><div data-corti-slots></div></div>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    dom.window.eval(`${source}\nwindow.renderHud = renderCortiSurvivalHud;`);
    const render = (dom.window as typeof dom.window & { renderHud: (state: unknown) => void }).renderHud;
    const item = { name: 'diamond_sword', displayName: '钻石剑', count: 1,
      durability: { left: 1200, max: 1561 } };
    const state = { health: 20, maxHealth: 20, food: 20, hotbar: [{ item }] };
    render(state);
    const slot = dom.window.document.querySelector('[data-corti-slots] .corti-slot')!;
    expect(slot.getAttribute('title')).toContain('耐久 1200/1561');
    expect(slot.querySelector('.corti-durability > span')).not.toBeNull();
    item.durability.left = 100;
    render(state);
    expect(slot.getAttribute('title')).toContain('耐久 100/1561');
  });

  it('adds a moving icon glint only while the selected weapon is enchanted', () => {
    const dom = new JSDOM(`<!doctype html><div id="corti-survival">
      <div data-corti-hearts></div><div data-corti-food></div><div data-corti-armor></div>
      <div data-corti-air></div><span data-corti-level></span><div data-corti-xp></div>
      <div data-corti-selection></div><div data-corti-slots></div></div>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    dom.window.eval(`${source}\nwindow.renderHud = renderCortiSurvivalHud;`);
    const render = (dom.window as typeof dom.window & { renderHud: (state: unknown) => void }).renderHud;
    const item = { name: 'iron_sword', displayName: '铁剑', count: 1, enchanted: true };
    const state = { health: 20, maxHealth: 20, food: 20, hotbar: [{ item }] };
    render(state);
    const slot = dom.window.document.querySelector('[data-corti-slots] .corti-slot')!;
    expect(slot.querySelector('.corti-enchant-glint')).not.toBeNull();
    expect(slot.getAttribute('title')).toContain('附魔');
    item.enchanted = false;
    render(state);
    expect(slot.querySelector('.corti-enchant-glint')).toBeNull();
    expect(slot.getAttribute('title')).not.toContain('附魔');
  });

  it('uses the 1.20.6 poison heart sprites until the effect ends', () => {
    const dom = new JSDOM(`<!doctype html><div id="corti-survival">
      <div data-corti-hearts></div><div data-corti-food></div><div data-corti-armor></div>
      <div data-corti-air></div><span data-corti-level></span><div data-corti-xp></div>
      <div data-corti-selection></div><div data-corti-slots></div></div>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    dom.window.eval(`${source}\nwindow.renderHud = renderCortiSurvivalHud; window.setPoisoned = cortiSetHudPoisoned;`);
    const viewer = dom.window as typeof dom.window & {
      pendingAvatarState: unknown;
      renderHud: (state: unknown) => void;
      setPoisoned: (poisoned: boolean) => void;
    };
    const state = { health: 19, maxHealth: 20, food: 20, hotbar: [] };
    viewer.pendingAvatarState = state;
    viewer.renderHud(state);
    const hearts = [...dom.window.document.querySelectorAll('[data-corti-hearts] .corti-icon')];
    expect(hearts[0]?.getAttribute('style')).toContain('heart/full.png');
    expect(hearts[9]?.getAttribute('style')).toContain('heart/half.png');

    viewer.setPoisoned(true);
    expect(hearts[0]?.getAttribute('style')).toContain('heart/poisoned_full.png');
    expect(hearts[9]?.getAttribute('style')).toContain('heart/poisoned_half.png');
    expect(hearts[0]?.parentElement?.getAttribute('title')).toContain('中毒');

    viewer.setPoisoned(false);
    expect(hearts[0]?.getAttribute('style')).toContain('heart/full.png');
    expect(hearts[9]?.getAttribute('style')).toContain('heart/half.png');
  });
});
