import { it } from 'vitest';
import { execSync } from 'node:child_process';

/**
 * Is a C compiler (Emscripten) available to the scenario runner? EMCC_PATH wins; otherwise `emcc` must be on PATH.
 * Tests that need it use `cIt`: they are SKIPPED, not failed, without it (so a green run without Emscripten says nothing about C).
 */
export const hasEmcc = (() => {
  if (process.env.EMCC_PATH) return true;
  try { execSync('emcc --version', { stdio: 'ignore' }); return true; } catch { return false; }
})();

export const cIt = hasEmcc ? it : it.skip;
