import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const entry = createRequire(import.meta.url).resolve('cortico-world-dungeon');
const upstream = dirname(dirname(entry));
const manifest = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8'));
if (manifest.version !== '0.1.4' || manifest.cortico?.api !== 5) throw new Error('Private adapter requires the explicitly pinned upstream API 5 package');
mkdirSync(join(root, 'dist'), { recursive: true });
const hashes = {};
for (const file of ['console.js', 'console.css']) {
  const input = join(upstream, 'dist', file); copyFileSync(input, join(root, 'dist', file));
  hashes[file] = createHash('sha256').update(readFileSync(input)).digest('hex');
}
writeFileSync(join(root, 'dist', 'upstream-assets.json'), JSON.stringify({ upstream: manifest.name, version: manifest.version, hashes }, null, 2) + '\n');
console.log('Pinned upstream registration assets preserved.');
