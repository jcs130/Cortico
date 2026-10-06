import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { viewerPageCss, viewerPageHtml } from '../../../src/worlds/minecraft/viewer-page-assets.ts';

const legacy = '<!doctype html><body data-view-mode="__VIEW_MODE__"><div id="legacy"></div></body>';
const frame = '<iframe id="corti-speech-bubble" hidden></iframe>';
const script = '<script src="/speech-bubble.js" defer></script>';
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'viewer-page-assets-'));
  try { await mkdir(path.join(root, 'public')); await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe('generated viewer asset selection', () => {
  it('serves the generated fishing and audio mounts instead of the legacy page', async () => {
    await fixture(async root => {
      const generated = '<!doctype html><body data-view-mode="first"><aside id="viewer-fishing-catch"></aside>' +
        '<button id="corti-music-toggle"></button><script src="/index.js"></script></body>';
      await writeFile(path.join(root, 'public', 'index.html'), generated);
      await writeFile(path.join(root, 'public', 'viewer.css'), '.viewer-fishing-catch{color:gold}');
      const html = await viewerPageHtml(root, 'first', legacy, frame, script);
      expect(html).toContain('id="viewer-fishing-catch"');
      expect(html).toContain('id="corti-music-toggle"');
      expect(html).not.toContain('id="legacy"');
      expect(html).toContain(frame + script + '</body>');
      expect(await viewerPageCss(root, '.legacy{}', '.speech{}'))
        .toBe('.viewer-fishing-catch{color:gold}.speech{}');
      expect(await readFile(path.join(root, 'public', 'index.html'), 'utf8')).toBe(generated);
    });
  });

  it('selects each generated camera page and uses a root page when only it exists', async () => {
    await fixture(async root => {
      await writeFile(path.join(root, 'public', 'index.html'), '<body data-view-mode="first">root</body>');
      await mkdir(path.join(root, 'public', 'third'));
      await writeFile(path.join(root, 'public', 'third', 'index.html'), '<body data-view-mode="third">third</body>');
      expect(await viewerPageHtml(root, 'third', legacy)).toBe('<body data-view-mode="third">third</body>');
      expect(await viewerPageHtml(root, 'dungeon', legacy)).toBe('<body data-view-mode="dungeon">root</body>');
    });
  });

  it('retains legacy packages and injects no duplicate speech elements', async () => {
    await fixture(async root => {
      const html = await viewerPageHtml(root, 'third', legacy, frame, script);
      expect(html).toContain('id="legacy"');
      expect(html).toContain('data-view-mode="third"');
      expect(await viewerPageCss(root, '.legacy{}', '.speech{}')).toBe('.legacy{}');
      await writeFile(path.join(root, 'public', 'index.html'), html);
      expect(await viewerPageHtml(root, 'third', legacy, frame, script)).toBe(html);
    });
  });

  it('adds camera state to a generated body without a mode attribute', async () => {
    await fixture(async root => {
      await writeFile(path.join(root, 'public', 'index.html'), '<body class="viewer">generated</body>');
      expect(await viewerPageHtml(root, 'dungeon', legacy)).toBe('<body data-view-mode="dungeon" class="viewer">generated</body>');
    });
  });
});
