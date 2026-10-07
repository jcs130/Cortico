import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [{ find: /^cortico\//, replacement: fileURLToPath(new URL('../../src/', import.meta.url)) }],
  },
  test: {
    include: ['test/**/*.test.ts', 'hosts/**/tests/**/*.test.ts'],
  },
});
