import { defineConfig } from 'vite';
import fs from 'node:fs';

// The built app carries the licence and third-party notices (see THIRD_PARTY_NOTICES.md, section 6).
const LEGAL_FILES = [
  ['LICENSE', 'LICENSE.txt'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.txt'],
  ['runtimes/micropython/LICENSE-MICROPYTHON', 'LICENSE-MICROPYTHON.txt']
];
const emitLegalNotices = {
  name: 'voltloom-legal-notices',
  apply: 'build',
  generateBundle() {
    for (const [from, fileName] of LEGAL_FILES) {
      this.emitFile({ type: 'asset', fileName, source: fs.readFileSync(new URL(`./${from}`, import.meta.url), 'utf8') });
    }
  }
};

// The Content-Security-Policy in index.html lists the Vite dev server's WebSocket (hot reload) under connect-src. A production
// page has no such connection, so the built page must not allow it.
const DEV_ONLY_CSP = ' ws://localhost:5173 ws://127.0.0.1:5173';
const productionCsp = {
  name: 'voltloom-production-csp',
  apply: 'build',
  transformIndexHtml(html) {
    if (!html.includes(DEV_ONLY_CSP)) throw new Error('index.html Content-Security-Policy no longer has the dev-only WebSocket entries this plugin removes');
    return html.replace(DEV_ONLY_CSP, '');
  }
};

// REQUIRED FOR SHAREDARRAYBUFFER:
// These headers enable cross-origin isolation, which is needed for SharedArrayBuffer and Atomics.
// Without them the firmware workers cannot share pin levels with the page (C programs refuse to run
// and Python button inputs stop updating inside busy loops). Any server that hosts the built app
// (not just this dev/preview server) must send them too.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless'
};

const compileProxy = {
  '/compile': {
    // The compile service binds to 127.0.0.1 only; "localhost" may resolve to ::1 and be refused.
    target: 'http://127.0.0.1:3001',
    changeOrigin: true
  }
};

export default defineConfig({
  plugins: [emitLegalNotices, productionCsp],
  worker: {
    format: 'es', // Ensures imports inside worker.js work correctly
  },
  server: {
    // No fs.allow override: the dev server may serve only the project folder itself (mp/, src/, public/ are all inside it).
    headers: crossOriginIsolation,
    proxy: compileProxy
  },
  // `npm run preview` serves the production build; it needs the same headers and proxy.
  preview: {
    headers: crossOriginIsolation,
    proxy: compileProxy
  }
});
