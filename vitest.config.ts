import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Provides the Postgres the tests/repo/* suites run against: reuses
    // DATABASE_URL when set, otherwise starts and later removes a throwaway
    // container. A no-op when neither is available — those suites then skip.
    globalSetup: ['tests/repo/global-setup.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
