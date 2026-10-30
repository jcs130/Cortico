import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { boundAvatarTextures, releaseTextureImages, renderSize, frameCadence } from '../web/render-budget.js';

function modelWith(...textures) {
  const material = new THREE.ShaderMaterial({ uniforms: Object.fromEntries(textures.map((value, i) => ['t'+i, { value }])) });
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), material)); return scene;
}
function canvasFactory() {
  const canvases = [];
  return { canvases, createCanvas(width, height) {
    const context = { drawImage: vi.fn() };
    const canvas = { width, height, getContext: () => context }; canvases.push(canvas); return canvas;
  } };
}
describe('bounded avatar display resources', () => {
  it('caps Retina/large capture surfaces without distorting the viewport or allocating for zero size', () => {
    expect(renderSize(720, 960, 2)).toEqual({ width:720, height:960 });
    const large = renderSize(2160, 2880, 2);
    expect(large.width * large.height).toBeLessThanOrEqual(720*960);
    expect(large.width / large.height).toBeCloseTo(.75, 2);
    expect(renderSize(0, 800, 2)).toBeNull();
  });
  it('fits a non-square source and preserves sampler, color space and shared texture sources', () => {
    const original = { width:8192, height:4096, close:vi.fn() };
    const texture = new THREE.Texture(original); texture.colorSpace=THREE.SRGBColorSpace;
    texture.wrapS=THREE.RepeatWrapping; const clone=texture.clone();
    const another=new THREE.Texture(original); const model=modelWith(texture, clone, another); const f=canvasFactory();
    original.close.mockImplementation(() => expect([texture,clone,another].every(t=>t.image!==original)).toBe(true));
    const report=boundAvatarTextures(model,f);
    expect(f.canvases).toHaveLength(1); expect(texture.image).toMatchObject({width:2048,height:1024});
    expect(clone.image).toBe(texture.image); expect(another.image).toBe(texture.image);
    expect(original.close).toHaveBeenCalledTimes(1);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping); expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(report.beforePixels/report.afterPixels).toBe(16);
  });
  it('does not upscale small inputs or reinterpret compressed/data textures', () => {
    const small={width:256,height:128,close:vi.fn()}, texture=new THREE.Texture(small);
    const compressed=new THREE.CompressedTexture([],8192,8192), data=new THREE.DataTexture(new Uint8Array(4),1,1);
    const f=canvasFactory(); boundAvatarTextures(modelWith(texture,compressed,data),f);
    expect(f.canvases).toHaveLength(0); expect(texture.image).toBe(small); expect(small.close).not.toHaveBeenCalled();
  });
  it('releases both decoded bitmaps and owned resize canvases on teardown', () => {
    const small={width:64,height:64,close:vi.fn()}, large={width:8192,height:8192,close:vi.fn()};
    const model=modelWith(new THREE.Texture(large),new THREE.Texture(small)), f=canvasFactory();
    boundAvatarTextures(model,f); releaseTextureImages(model);
    expect(large.close).toHaveBeenCalledTimes(1); expect(small.close).toHaveBeenCalledTimes(1);
    expect(f.canvases[0]).toMatchObject({width:1,height:1});
  });
  it('renders thirty frames per second on a 144 Hz display and recovers after an idle gap', () => {
    const due=frameCadence();let frames=0;
    for(let i=0;i<144;i++) if(due(i*1000/144))frames++;
    expect(frames).toBe(30);expect(due(10000)).toBe(true);expect(due(10001)).toBe(false);
  });
});
