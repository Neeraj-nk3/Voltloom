import { defineConfig } from 'vitest/config';

// Unit tests run in plain Node (no DOM). Browser behaviour is covered by Playwright (see playwright.config.js).
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/scenario/**/*.test.js'],
    environment: 'node',
    // Test files run one at a time: the compile-pipeline test counts temp folders, and the scenario tests compile too.
    fileParallelism: false,
  },
});
