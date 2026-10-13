import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { satisfies } from '../../../scripts/lib/semver-lite.mjs';
import { decodeProject } from '../../../src/project/project-store.js';

// The setup and diagnostic scripts are part of the product's first-run experience, so they are tested like the rest.

const node = process.execPath;
const run = (args, env = {}) => spawnSync(node, args, { encoding: 'utf8', env: { ...process.env, ...env } });

describe('semver-lite (the engines check used by the doctor)', () => {
  it('handles the range forms this project uses', () => {
    expect(satisfies('v24.12.0', '^24.12.0')).toBe(true);
    expect(satisfies('v24.19.0', '^24.12.0')).toBe(true);
    expect(satisfies('v24.11.9', '^24.12.0')).toBe(false);
    expect(satisfies('v25.0.0', '^24.12.0')).toBe(false);
    expect(satisfies('v22.12.0', '^22.12.0 || ^24.0.0')).toBe(true);
    expect(satisfies('v23.0.0', '^22.12.0 || ^24.0.0')).toBe(false);
    expect(satisfies('v20.0.0', '>=18.0.0')).toBe(true);
    expect(satisfies('v24.12.0', 'latest')).toBe(false);      // a range it does not understand never matches
  });
});

describe('scripts/doctor.mjs', () => {
  it('reports every check with a verdict and, when a check fails, a way to fix it', () => {
    const { stdout } = run(['scripts/doctor.mjs', '--json']);
    const report = JSON.parse(stdout);
    expect(report.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['node', 'npm', 'dependencies', 'micropython', 'browser', 'emscripten', 'port-5173', 'port-3001']));
    for (const check of report.checks) {
      expect(typeof check.ok).toBe('boolean');
      if (!check.ok) expect(check.fix, `${check.id} has no advice`).toBeTruthy();
    }
    expect(report.checks.find((c) => c.id === 'node').ok).toBe(true);
    expect(report.checks.find((c) => c.id === 'micropython').ok).toBe(true);
  });

  it('a wrong EMCC_PATH is reported as such, as a warning (C is optional), with advice', () => {
    const bogus = path.join(os.tmpdir(), 'definitely-not-emcc');
    const report = JSON.parse(run(['scripts/doctor.mjs', '--json'], { EMCC_PATH: bogus }).stdout);
    const emcc = report.checks.find((c) => c.id === 'emscripten');
    expect(emcc.ok).toBe(false);
    expect(emcc.required).toBe(false);
    expect(emcc.detail).toContain('EMCC_PATH');
    expect(emcc.fix).toContain('EMCC_PATH');
  });

  it('exits non-zero only when something REQUIRED fails', () => {
    const report = JSON.parse(run(['scripts/doctor.mjs', '--json']).stdout);
    const requiredFailed = report.checks.some((c) => c.required && !c.ok);
    expect(run(['scripts/doctor.mjs']).status).toBe(requiredFailed ? 1 : 0);
  });
});

describe('scripts/share-link.mjs', () => {
  it('prints a link whose project is the file, and refuses a project the app would reject', () => {
    const file = 'examples/projects/python-blink.project.json';
    const out = run(['scripts/share-link.mjs', file, 'http://localhost:5173/']);
    expect(out.status).toBe(0);
    const url = new URL(out.stdout.trim());
    expect(url.origin).toBe('http://localhost:5173');
    expect(decodeProject(url.searchParams.get('p'))).toEqual(JSON.parse(fs.readFileSync(file, 'utf8')));

    const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voltloom-share-')), 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ version: 2, language: 'python', code: 'x', board: 'pico_w', components: [{ id: 'led_1', type: 'nope' }], connections: [] }));
    const rejected = run(['scripts/share-link.mjs', bad]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('would reject');
  });
});

describe('CI workflow and package scripts', () => {
  it('every `npm run X` in the workflow and in the docs names a script that exists', () => {
    const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
    const files = ['.github/workflows/ci.yml', 'README.md', 'CONTRIBUTING.md', ...fs.readdirSync('docs').filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
    const missing = [];
    for (const file of files) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/npm run ([a-z][\w:-]*)/g)) {
        if (!(match[1] in scripts)) missing.push(`${file}: npm run ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the workflow uses the Node version file and runs the example check', () => {
    const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('node-version-file: .node-version');
    expect(ci).toContain('npm run examples:check');
    expect(fs.readFileSync('.node-version', 'utf8').trim()).toBe('24.12.0');
  });
});

describe('scripts/demo.mjs', () => {
  it('prints one entry per example, as JSON, and Python entries have results', () => {
    const out = run(['scripts/demo.mjs', '--json']);
    expect(out.status).toBe(0);
    const report = JSON.parse(out.stdout);
    const manifest = JSON.parse(fs.readFileSync('examples/examples.json', 'utf8')).examples;
    expect(report.map((r) => r.id)).toEqual(manifest.map((e) => e.id));
    for (const entry of report.filter((r) => r.language === 'python')) expect(entry.ended).toBeTruthy();
  }, 240_000);
});
