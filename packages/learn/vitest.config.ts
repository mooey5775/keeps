import { defineConfig } from 'vitest/config';

// The property tests play hundreds of random rounds.
export default defineConfig({
  test: { testTimeout: 120_000 },
});
