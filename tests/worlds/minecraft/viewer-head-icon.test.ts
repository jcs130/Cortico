import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const helper = readFileSync(new URL('../../../scripts/minecraft-viewer-item-icon.js', import.meta.url), 'utf8');
const hud = readFileSync(new URL('../../../scripts/minecraft-viewer-hud.js', import.meta.url), 'utf8');
const { JSDOM } = createRequire(import.meta.url)('jsdom');

describe('player head in the survival hotbar', () => {
  it('updates the skin face and name when the slot keeps the same item type and count', () => {
    const dom = new JSDOM(`<!doctype html><div id="corti-survival">
      <div data-corti-hearts></div><div data-corti-food></div><div data-corti-armor></div>
      <div data-corti-air></div><div data-corti-level></div><div data-corti-xp></div>
      <div data-corti-selection></div><div data-corti-slots></div></div>`,
    { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    dom.window.eval(`${helper}\n${hud}`);
    const render = (name: string, hash: string) => {
      const state = { hotbar: [{ item: { name: 'player_head', displayName: name,
        customName: name, headTextureHash: hash, count: 1 } }] };
      dom.window.eval(`renderCortiSurvivalHud(${JSON.stringify(state)})`);
    };
    render('大背包', 'a'.repeat(64));
    const slot = dom.window.document.querySelector('.corti-slot')!;
    expect(slot.getAttribute('title')).toBe('大背包 × 1');
    expect(slot.querySelector('.corti-head-face')?.getAttribute('style')).toContain('a'.repeat(64));
    render('备用背包', 'b'.repeat(64));
    expect(slot.getAttribute('title')).toBe('备用背包 × 1');
    expect(slot.querySelector('.corti-head-face')?.getAttribute('style')).toContain('b'.repeat(64));
  });
});
