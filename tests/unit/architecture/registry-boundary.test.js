import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the point of the part registry: only src/circuit/part-types.js and src/circuit/diagram.js may know how part ids are spelled.
// Everything else asks the registry (partTypeOf, partsOfType, isPartOfType, ...).

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('part registry boundary', () => {
  it('no module outside part-types.js and diagram.js tests ids by prefix or hard-codes part id prefixes', () => {
    const offenders = [];
    for (const file of jsFiles(srcDir)) {
      const rel = path.relative(srcDir, file).split(path.sep).join('/');
      if (rel === 'circuit/part-types.js' || rel === 'circuit/diagram.js') continue;
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/startsWith\(\s*['"](led|res|btn)_['"]\s*\)/.test(line) || /['"](led|res|btn)_['"]/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
