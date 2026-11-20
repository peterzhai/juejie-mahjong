import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@quejie/fan-config': r('./packages/fan-config/src/index.ts'),
      '@quejie/mahjong-core': r('./packages/mahjong-core/src/index.ts'),
      '@quejie/protocol': r('./packages/protocol/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/tests/**/*.test.ts',
      'apps/server/tests/**/*.test.ts',
      'tools/tests/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 30000,
  },
});
