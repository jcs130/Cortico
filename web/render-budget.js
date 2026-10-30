// Display resources belong to this renderer, not to the immutable avatar asset.
export const DISPLAY_BUDGET = Object.freeze({ textureEdge: 2048, pixels: 720 * 960, dpr: 1, fps: 30 });
const resizedCanvases = new WeakSet();

export function renderSize(width, height, dpr = 1, budget = DISPLAY_BUDGET) {
  if (![width, height].every(v => Number.isFinite(v) && v > 0)) return null;
  const ratio = Math.min(budget.dpr, Math.max(1, Number(dpr) || 1));
  const scale = Math.min(ratio, Math.sqrt(budget.pixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export function frameCadence(fps = DISPLAY_BUDGET.fps) {
  let next = null;
  return now => {
    if (!Number.isFinite(now) || next !== null && now < next - 0.001) return false;
    const interval = 1000 / fps;
    next = next === null || now - next > interval ? now + interval : next + interval;
    return true;
  };
}

function texturesOf(model) {
  const textures = new Set();
  const collect = value => {
    if (value?.isTexture) textures.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
  };
  model?.traverse(node => {
    for (const material of [node.material].flat().filter(Boolean)) {
      Object.values(material).forEach(collect);
      Object.values(material.uniforms ?? {}).forEach(uniform => collect(uniform?.value));
    }
  });
  return textures;
}

export function boundAvatarTextures(model, { edge = DISPLAY_BUDGET.textureEdge, createCanvas = (w, h) => {
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; return canvas;
} } = {}) {
  if (!Number.isFinite(edge) || edge < 1) throw Error('Invalid texture budget');
  const replacements = new Map(), originals = new Set();
  let beforePixels = 0, afterPixels = 0;
  for (const texture of texturesOf(model)) {
    if (texture.isCompressedTexture || texture.isDataTexture || texture.isCubeTexture) continue;
    const image = texture.image;
    if (!image || !Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width < 1 || image.height < 1) continue;
    if (!replacements.has(image)) {
      const scale = Math.min(1, edge / Math.max(image.width, image.height));
      beforePixels += image.width * image.height;
      if (scale < 1) {
        const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
        const context = canvas.getContext('2d');
        if (!context) throw Error('Texture resize context unavailable');
        context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resizedCanvases.add(canvas); replacements.set(image, canvas); originals.add(image);
      } else replacements.set(image, image);
      const result = replacements.get(image); afterPixels += result.width * result.height;
      // Texture clones may already share the Source updated by this assignment.
      if (result !== image) replacements.set(result, result);
    }
    const result = replacements.get(image);
    if (result !== image) { texture.image = result; texture.needsUpdate = true; }
  }
  // Release decoded 8K ImageBitmaps only after every material has its replacement.
  // Never close a bitmap while a different texture still refers to it.
  for (const image of originals) image.close?.();
  return { edge, images: originals.size, beforePixels, afterPixels,
    estimatedRgbaMipBytesBefore: Math.ceil(beforePixels * 4 * 4 / 3),
    estimatedRgbaMipBytesAfter: Math.ceil(afterPixels * 4 * 4 / 3) };
}

export function releaseTextureImages(model) {
  const images = new Set([...texturesOf(model)].map(t => t.image).filter(Boolean));
  for (const image of images) {
    image.close?.();
    if (resizedCanvases.has(image)) { image.width = 1; image.height = 1; }
  }
}
