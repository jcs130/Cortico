import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('Minecraft viewer poison feedback', () => {
  it('tracks the real effect lifecycle, including removal and expiry', () => {
    const source = readFileSync(path.resolve('scripts/minecraft-viewer-presentation.js'), 'utf8');
    const hudPoisonStates: boolean[] = [];
    const root = { children: [] as Array<{ style: Record<string, string>; children: Array<{ textContent: string }> }>,
      replaceChildren() { this.children = []; },
      append(row: typeof this.children[number]) { this.children.push(row); } };
    const handlers = new Map<string, (event: unknown) => void>();
    let now = 100_000;
    const MockDate = class extends Date { static now() { return now; } };
    const element = () => ({ dataset: {} as Record<string, string>, textContent: '',
      children: [] as Array<{ textContent: string }>, append(...rows: Array<{ textContent: string }>) {
        this.children.push(...rows);
      }, setAttribute() {}, style: {} as Record<string, string>, remove() {} });
    const document = { getElementById() { return root; }, createElement: element, querySelectorAll: () => [],
    body: { style: { removeProperty() {}, setProperty() {} }, dataset: {} } };
    runInNewContext(source, { document, Date: MockDate, cortiSetHudPoisoned(poisoned: boolean) {
      hudPoisonStates.push(poisoned);
    }, localStorage: { getItem: () => null,
      setItem() {} }, socket: { on(name: string, handler: (event: unknown) => void) {
        handlers.set(name, handler);
      } }, setInterval() {}, setTimeout() {} });
    const send = handlers.get('presentationEvent')!;
    send({ kind: 'effect', id: 19, name: 'minecraft:poison', title: '中毒',
      active: true, self: true, durationTicks: 80 });
    expect(hudPoisonStates.at(-1)).toBe(true);
    expect(root.children[0]?.style.borderColor).toBe('#a7df65');
    expect(root.children[0]?.children[1]?.textContent).toBe('中毒');
    send({ kind: 'effect', id: 19, name: 'poison', active: false });
    expect(hudPoisonStates.at(-1)).toBe(false);
    send({ kind: 'effect', id: 19, name: 'poison', active: true, durationTicks: 20 });
    expect(hudPoisonStates.at(-1)).toBe(true);
    now += 1_100;
    send({ kind: 'effect', id: 20, name: 'slowness', active: true, durationTicks: 20 });
    expect(hudPoisonStates.at(-1)).toBe(false);
  });
});
