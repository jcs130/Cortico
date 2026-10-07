import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await mkdir('dist', { recursive: true });
await build({
  alias: { cortico: fileURLToPath(new URL('../../../src', import.meta.url)) },
  entryPoints: ['src/console-client.ts'],
  outfile: 'dist/console.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
});
