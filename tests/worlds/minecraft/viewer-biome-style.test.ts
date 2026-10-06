import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const minecraftData = require('minecraft-data')('1.20.6') as {
  biomesArray: Array<{ name: string }>;
};
const source = readFileSync(new URL('../../../scripts/minecraft-viewer-biome-style.js', import.meta.url), 'utf8');
const context = { globalThis: {} as Record<string, unknown>, document: { getElementById: () => null } } as Record<string, unknown>;
runInNewContext(`${source}\nthis.resolve = cortiResolveBiomeStyle; this.setBiome = cortiSetBiome; this.keepSurfaceSky = cortiKeepSurfaceSky;`, context);
const resolve = context.resolve as (name: string, dimension?: string) => Record<string, unknown>;
const setBiome = context.setBiome as (event: { name: string }) => void;
const keepSurfaceSky = context.keepSurfaceSky as (skybox: Record<string, unknown>) => void;

describe('Minecraft 1.20.6 viewer biome style', () => {
  it('covers every registered biome with a complete, restrained palette', () => {
    expect(minecraftData.biomesArray.length).toBeGreaterThan(50);
    for (const biome of minecraftData.biomesArray) {
      const style = resolve(biome.name);
      expect(style.name, biome.name).toBe(biome.name);
      expect(style.group, biome.name).toMatch(/^[a-z]+$/);
      for (const field of ['fog', 'sky', 'sun', 'fill']) {
        expect(style[field], `${biome.name}.${field}`).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(Number(style.saturation), biome.name).toBeGreaterThanOrEqual(1);
      expect(Number(style.saturation), biome.name).toBeLessThan(1.2);
    }
  });

  it('uses the actual dimension for custom-server biome names', () => {
    expect(resolve('custom_biome', 'minecraft:the_nether').group).toBe('nether');
    expect(resolve('custom_biome', 'minecraft:the_end').group).toBe('end');
    expect(resolve('cherry_grove').group).toBe('cherry');
    expect(resolve('deep_frozen_ocean').group).toBe('cold');
    expect(resolve('terralith:shrubland').group).toBe('arid');
    expect(resolve('terralith:alpine_grove').group).toBe('cold');
    expect(resolve('terralith:cave/fungal_caves').group).toBe('mushroom');
  });

  it('accepts namespaced cave paths emitted by Terralith', () => {
    setBiome({ name: 'terralith:cave/fungal_caves' });
    const diagnostics = context.globalThis as { __cortiBiomeStyle: { biome: string; group: string } };
    expect(diagnostics.__cortiBiomeStyle.biome).toBe('terralith:cave/fungal_caves');
    expect(diagnostics.__cortiBiomeStyle.group).toBe('mushroom');
  });

  it('does not toggle whole-scene water fog when the eye crosses the surface', () => {
    const states: boolean[] = [];
    const skybox = { updateWaterState(inWater: boolean) { states.push(inWater); } };
    keepSurfaceSky(skybox);
    skybox.updateWaterState(true);
    skybox.updateWaterState(false);
    keepSurfaceSky(skybox);
    skybox.updateWaterState(true);
    expect(states).toEqual([false, false, false, false]);
  });
});
