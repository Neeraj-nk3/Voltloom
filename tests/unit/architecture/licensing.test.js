import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'vite';

// The licence, package metadata and third-party notices must agree with each other, with the files they describe,
// and with what the production build actually ships.

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// The standard MIT licence text (https://opensource.org/license/mit) with the year and holder as the only variable parts.
const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

describe('MIT licence and metadata', () => {
  it('LICENSE is exactly the standard MIT text, with Neeraj Kumar as the holder', () => {
    const text = read('LICENSE');
    const match = /^MIT License\n\nCopyright \(c\) (\d{4}) Neeraj Kumar\n\n([\s\S]*)$/.exec(text);
    expect(match, 'header: "MIT License", then "Copyright (c) <year> Neeraj Kumar"').not.toBeNull();
    expect(Number(match[1])).toBeGreaterThanOrEqual(2026);
    expect(match[2]).toBe(MIT_BODY);
  });

  it('the root and compiler package.json files declare MIT and the Voltloom names, and the lockfile agrees', () => {
    const root = JSON.parse(read('package.json'));
    const compiler = JSON.parse(read('compiler/package.json'));
    expect(root.name).toBe('voltloom');
    expect(root.license).toBe('MIT');
    expect(root.private).toBe(true);                 // not published
    expect(root.repository).toBeUndefined();         // no remote is configured for the project
    expect(compiler.name).toBe('voltloom-compiler');
    expect(compiler.license).toBe('MIT');
    const lock = JSON.parse(read('package-lock.json'));
    expect(lock.name).toBe(root.name);
    expect(lock.version).toBe(root.version);
    expect(lock.packages[''].license).toBe('MIT');
    expect(lock.packages[''].engines).toEqual(root.engines);
    expect(root.workspaces).toEqual(['compiler']);
    expect(lock.packages.compiler.name).toBe(compiler.name);                   // one lockfile covers the compiler workspace
    expect(fs.existsSync('compiler/package-lock.json')).toBe(false);
  });

  it('the local-only CLAUDE_DIRECTION folder is git-ignored', () => {
    expect(read('.gitignore').split('\n')).toContain('CLAUDE_DIRECTION/');
  });
});

describe('third-party notices match the files they describe', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');

  it('each MicroPython runtime file has its own hash recorded next to its own name', () => {
    for (const file of ['micropython.wasm', 'micropython.mjs']) {
      expect(notices, `${file} hash`).toContain(`\`${file}\` \`${sha256(`runtimes/micropython/${file}`)}\``);
    }
    expect(fs.readFileSync('runtimes/micropython/micropython.wasm').includes(Buffer.from('MicroPython v1.27.0'))).toBe(true);
    expect(notices).toContain('MicroPython 1.27.0');
  });

  it('the MicroPython licence ships next to the runtime and is the upstream MIT text', () => {
    const licence = read('runtimes/micropython/LICENSE-MICROPYTHON');
    expect(licence.startsWith('The MIT License (MIT)\n\nCopyright (c) 2013-2025 Damien P. George\n\n')).toBe(true);
    expect(licence).toContain(MIT_BODY.split('\n\n')[0]);
    expect(licence).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it('no firmware image (.uf2) is kept in the project outside node_modules/dist', () => {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'test-results', '.git', 'CLAUDE_DIRECTION'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full); else if (/\.uf2$/i.test(entry.name)) found.push(full);
      }
    };
    walk('.');
    expect(found).toEqual([]);
  });
});

describe('the production build ships the notices', () => {
  it('emits LICENSE.txt, THIRD_PARTY_NOTICES.txt and LICENSE-MICROPYTHON.txt with the right content, and no .uf2', async () => {
    const result = await build({ logLevel: 'silent', build: { write: false, outDir: 'dist-licensing-check', emptyOutDir: false } });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
    const asset = (name) => outputs.find((o) => o.fileName === name);
    expect(String(asset('LICENSE.txt')?.source)).toBe(fs.readFileSync('LICENSE', 'utf8'));
    expect(String(asset('THIRD_PARTY_NOTICES.txt')?.source)).toBe(fs.readFileSync('THIRD_PARTY_NOTICES.md', 'utf8'));
    expect(String(asset('LICENSE-MICROPYTHON.txt')?.source)).toBe(fs.readFileSync('runtimes/micropython/LICENSE-MICROPYTHON', 'utf8'));
    expect(outputs.filter((o) => /\.uf2$/i.test(o.fileName))).toEqual([]);
    expect(fs.existsSync('dist-licensing-check')).toBe(false);          // write:false really wrote nothing
  }, 60_000);
});

describe('security policy', () => {
  it('SECURITY.md tells people to report privately and does not invent a repository or an e-mail address', () => {
    const text = read('SECURITY.md');
    expect(text).toMatch(/do not describe a vulnerability in a public issue/i);
    expect(text).not.toMatch(/https?:\/\/github\.com\//);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});
