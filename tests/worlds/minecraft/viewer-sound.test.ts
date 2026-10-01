import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const source = readFileSync(new URL('../../../scripts/minecraft-viewer-sound.js', import.meta.url), 'utf8');

describe('Minecraft viewer audio', () => {
  it('unlocks audio on the enable button after browser autoplay blocks it', async () => {
    const dom = new JSDOM('<button id="corti-sound-toggle"></button>',
      { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    let userGesture = false;
    class AudioContext {
      state = 'suspended';
      async resume() { if (userGesture) this.state = 'running'; }
    }
    dom.window.AudioContext = AudioContext;
    dom.window.fetch = async () => ({ ok: true, json: async () => ({ minecraftVersion: '1.20.6' }) });
    dom.window.socket = { on() {} };
    dom.window.eval(`let latestPosition = null; ${source}`);
    const button = dom.window.document.querySelector('button')!;
    await vi.waitFor(() => expect(button.textContent).toBe('音效 点击开启'));
    button.addEventListener('pointerdown', () => { userGesture = true; });
    button.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe('音效 开启'));
  });

  it('plays only mapped nearby sounds and stops when muted', async () => {
    const dom = new JSDOM('<button id="corti-sound-toggle"></button>',
      { runScripts: 'outside-only', url: 'http://127.0.0.1:7793/' });
    const handlers = new Map<string, (event: unknown) => void>();
    const played = vi.fn();
    const fetch = vi.fn(async (url: string) => url.endsWith('manifest.json')
      ? { ok: true, json: async () => ({ minecraftVersion: '1.20.6', events: {
        'block.stone.break': [{ file: 'dig/stone1.ogg', volume: 1, pitch: 1 }],
      } }) }
      : { ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
    class AudioContext {
      state = 'suspended';
      destination = {};
      async resume() { this.state = 'running'; }
      async decodeAudioData() { return {}; }
      createGain() { return { gain: { value: 0 }, connect() { return this; }, disconnect() {} }; }
      createBufferSource() { return { buffer: null, playbackRate: { value: 1 },
        connect() { return this; }, disconnect() {}, start: played, onended: null }; }
    }
    dom.window.AudioContext = AudioContext;
    dom.window.fetch = fetch;
    dom.window.socket = { on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) };
    dom.window.eval(`let latestPosition = { pos: { x: 0, y: 64, z: 0 } }; ${source}`);
    await vi.waitFor(() => expect(dom.window.document.querySelector('button')?.textContent).toBe('音效 开启'));
    const receive = handlers.get('worldSound')!;
    receive({ name: 'unknown', position: { x: 0, y: 64, z: 0 }, volume: 1, pitch: 1 });
    receive({ name: 'block.stone.break', position: { x: 100, y: 64, z: 0 }, volume: 1, pitch: 1 });
    receive({ name: 'block.stone.break', position: { x: 2, y: 64, z: 0 }, volume: 1, pitch: 1 });
    await vi.waitFor(() => expect(played).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith('/sounds/dig/stone1.ogg');
    dom.window.document.querySelector('button')!.click();
    receive({ name: 'block.stone.break', position: { x: 2, y: 64, z: 0 }, volume: 1, pitch: 1 });
    await Promise.resolve();
    expect(played).toHaveBeenCalledTimes(1);
  });
});
