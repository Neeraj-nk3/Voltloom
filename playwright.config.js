import { defineConfig } from '@playwright/test';

// Browser tests drive the real app and, when Emscripten is installed, the real compile server.
//
//   npm run test:e2e          against the Vite dev server (http://localhost:5173)
//   npm run test:e2e:preview  against the PRODUCTION build served by `vite preview` (http://localhost:4173); run `npm run build` first
//
// Set VOLTLOOM_CHROMIUM (the old name PICOLAB_CHROMIUM still works) to a Chromium/Chrome executable if Playwright's own browser is not installed.
const chromiumPath = process.env.VOLTLOOM_CHROMIUM || process.env.PICOLAB_CHROMIUM;
const preview = process.env.VOLTLOOM_PREVIEW === '1';
const appUrl = preview ? 'http://localhost:4173' : 'http://localhost:5173';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: appUrl,
    headless: true,
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
  webServer: [
    preview
      ? { command: 'npx vite preview --port 4173 --strictPort', url: appUrl, reuseExistingServer: true, timeout: 60_000 }
      : { command: 'npx vite --port 5173 --strictPort', url: appUrl, reuseExistingServer: true, timeout: 60_000 },
    {
      command: 'node compiler/server.js',
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: true,
      timeout: 30_000,
      // the compile service only answers the origin of the app it is serving
      env: { ...process.env, ALLOWED_ORIGINS: `${appUrl},${appUrl.replace('localhost', '127.0.0.1')}` },
    },
  ],
});
