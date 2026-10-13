import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { build, createServer } from 'vite';

// Configuration that is easy to get wrong silently: what the production page allows, and what the dev server may read.

const cspOf = (html) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

describe('Content-Security-Policy', () => {
  it('the source page allows the Vite hot-reload WebSocket, the production page does not', async () => {
    expect(cspOf(fs.readFileSync('index.html', 'utf8'))).toContain('ws://localhost:5173');
    const result = await build({ logLevel: 'silent', build: { write: false, outDir: 'dist-config-check', emptyOutDir: false } });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
    const html = String(outputs.find((o) => o.fileName === 'index.html').source);
    const policy = cspOf(html);
    expect(policy).toBeTruthy();
    expect(policy).not.toMatch(/ws:/);
    expect(policy).toContain("connect-src 'self' https://cdnjs.cloudflare.com");    // the rest of the policy is untouched
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toMatch(/tailwindcss/);                                      // styles are bundled: no third-party stylesheet or script host besides Monaco's CDN and the font CDN
  }, 60_000);
});

describe('development server file access', () => {
  // `?raw` makes the server read the file itself, which is subject to the fs.allow check (a bare /@fs/ request just falls back to the page).
  async function fetchRaw(serverConfig, file) {
    const port = await freePort();
    const server = await createServer({ logLevel: 'silent', server: { port, strictPort: true, host: '127.0.0.1', ...serverConfig } });
    try {
      await server.listen();
      const response = await fetch(`http://127.0.0.1:${port}/@fs/${path.resolve(file).split(path.sep).join('/')}?raw`);
      return { status: response.status, body: await response.text() };
    } finally {
      await server.close();
    }
  }

  it('serves files inside the project, and refuses a file in the parent folder', async (context) => {
    const inParent = path.resolve('..', 'voltloom-fs-access-check.txt');
    try { fs.writeFileSync(inParent, 'parent folder file'); } catch { context.skip(); return; }       // parent folder not writable: cannot run this check
    try {
      const inside = await fetchRaw({}, 'package.json');
      expect(inside.status).toBe(200);
      expect(inside.body).toContain('"name": "voltloom"');

      const refused = await fetchRaw({}, inParent);
      expect(refused.status).toBe(403);
      expect(refused.body).not.toContain('parent folder file');

      // control: the old setting (allow the parent folder) really would have served it, so this test can tell the two apart
      const wide = await fetchRaw({ fs: { allow: ['..'] } }, inParent);
      expect(wide.status).toBe(200);
      expect(wide.body).toContain('parent folder file');
    } finally {
      fs.rmSync(inParent, { force: true });
    }
  }, 90_000);

  it('the runtime files the app loads through the dev server are inside the project', async () => {
    const wasm = await fetchRaw({}, 'runtimes/micropython/micropython.wasm');
    expect(wasm.status).toBe(200);
    const board = await fetchRaw({}, 'src/ui/assets/pico-board.svg');
    expect(board.status).toBe(200);
  }, 60_000);
});
