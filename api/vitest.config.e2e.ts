import { defineConfig } from 'vitest/config';

// e2e roda contra o Postgres REAL (banco de dev com seed). Arquivos em série: compartilham o banco.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
