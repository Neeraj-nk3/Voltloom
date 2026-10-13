import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Documentation must not point at files that are gone, and current code and docs must not name the folders and project
// names that no longer exist. History (docs/history) and the decision records are exempt: they describe the past.

const SKIP_DIRS = new Set(['node_modules', 'dist', 'test-results', '.git', 'CLAUDE_DIRECTION']);
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('dist-')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out); else out.push(full.split(path.sep).join('/').replace(/^\.\//, ''));
  }
  return out;
};
const all = walk('.').map((f) => f.replace(/^\.\//, ''));
const isHistory = (f) => f.startsWith('docs/history/') || f.startsWith('docs/decisions/');

describe('markdown links', () => {
  const docs = all.filter((f) => f.endsWith('.md') && !isHistory(f));

  it('there are guides to check', () => {
    expect(docs).toEqual(expect.arrayContaining(['README.md', 'docs/architecture.md', 'docs/examples.md', 'CONTRIBUTING.md', 'SECURITY.md']));
  });

  for (const doc of docs) {
    it(`${doc}: every relative link resolves`, () => {
      const text = fs.readFileSync(doc, 'utf8');
      const broken = [];
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = match[1];
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const file = decodeURIComponent(target.split('#')[0]);
        if (!file) continue;
        if (!fs.existsSync(path.join(path.dirname(doc), file))) broken.push(target);
      }
      expect(broken).toEqual([]);
    });
  }
});

describe('no references to folders and names that no longer exist', () => {
  // [pattern, why it is stale]
  const STALE = [
    [/compiler-server\//, 'the compiler service lives in compiler/'],
    [/(?<![\w/-])e2e\//, 'browser tests live in tests/e2e/'],
    [/src\/(sim|backend|simulation|canvas|components|parts|utils|wires)\b/, 'src/ was reorganised (see docs/architecture.md)'],
    [/(?<![\w/-])mp\/micropython/, 'the runtime lives in runtimes/micropython/'],
    [/CircuitFlow|web-pico-ide/, 'former project names'],
    [/PROJECT_[A-Z0-9_]+\.md/, 'reports moved to docs/history/'],
  ];
  // Files that legitimately name the past: the guard tests themselves (they list removed paths), legacy-compat code, notices.
  const EXEMPT = new Set([
    'tests/unit/architecture/docs-and-paths.test.js',
    'tests/unit/architecture/removed-features.test.js',
    'tests/unit/architecture/licensing.test.js',
    'src/project/autosave.js',
    'tests/unit/project/autosave.test.js',
    'tests/e2e/autosave.spec.js',
    'docs/project-format.md',
    'package-lock.json',
  ]);
  const checked = all.filter((f) => /\.(m?js|html|md|json|c|h|yml)$/.test(f) && !isHistory(f) && !EXEMPT.has(f) && !f.startsWith('tests/fixtures/') && !f.includes('/fixtures/'));

  it('has files to check', () => {
    expect(checked.length).toBeGreaterThan(100);
  });

  it('none of the current code, tests, configuration or guides contains a stale reference', () => {
    const offenders = [];
    for (const file of checked) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const [pattern, why] of STALE) if (pattern.test(line)) offenders.push(`${file}:${i + 1}: ${why}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
