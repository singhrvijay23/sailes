import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests share one database; run files one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://sailes:sailes@localhost:5432/sailes_test',
      INLINE_JOBS: 'true',
      RUN_WORKERS: 'false',
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
    },
  },
});
