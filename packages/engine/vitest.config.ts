import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The random full-game and exploration tests take a few seconds each, and
    // the suite runs them in parallel with ~700 other tests.
    testTimeout: 30_000,
  },
});
