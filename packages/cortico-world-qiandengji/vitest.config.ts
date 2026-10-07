import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: [{ find: /^cortico\//, replacement: fileURLToPath(new URL('../../src/', import.meta.url)) }] },
  test: { include: ['tests/**/*.test.ts'], env: { CORTICO_LANGUAGE: 'zh' } },
});
