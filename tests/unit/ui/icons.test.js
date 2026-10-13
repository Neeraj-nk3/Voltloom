import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Icons are drawn once, in the <symbol> sprite at the top of index.html, and referenced by name from the HTML and from
// script (icons.js). A name that is not in the sprite renders as an empty gap, silently; this catches it.

const html = fs.readFileSync('index.html', 'utf8');
const sprite = new Set([...html.matchAll(/<symbol id="i-([\w-]+)"/g)].map((m) => m[1]));

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sources = walk('src').filter((f) => f.endsWith('.js'));

/** Icon names a script file asks for: the quoted lowercase words on the rest of a line that calls an icon helper. */
function requestedBy(text) {
  const names = [];
  for (const line of text.split('\n')) {
    if (!/\bicon\(|\bsetIcon\(|\biconName\b|\brenderSectionHeader\(/.test(line)) continue;
    if (/^\s*(export )?function |^\s*\*|^\s*\/\//.test(line)) continue;          // definitions and comments
    // other quoted words that share a line with an icon call (a selector, an insertion position)
    for (const m of line.matchAll(/'([a-z]+(?:-[a-z]+)*)'/g)) if (!['svg', 'beforeend', 'afterbegin', 'error'].includes(m[1])) names.push(m[1]);
  }
  return names;
}

describe('icon sprite', () => {
  it('has the icons', () => {
    expect(sprite.size).toBeGreaterThan(20);
  });

  it('every icon the page markup references exists', () => {
    const used = [...html.matchAll(/href="#i-([\w-]+)"/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((name) => !sprite.has(name))).toEqual([]);
  });

  it('every icon the scripts ask for exists', () => {
    const missing = [];
    let asked = 0;
    for (const file of sources) {
      for (const name of requestedBy(fs.readFileSync(file, 'utf8'))) {
        asked++;
        if (!sprite.has(name)) missing.push(`${file}: ${name}`);
      }
    }
    expect(asked).toBeGreaterThan(8);
    expect(missing).toEqual([]);
  });

  it('every sprite symbol is used somewhere (no dead shapes)', () => {
    const everything = html.replace(/<symbol[\s\S]*?<\/symbol>/g, '') + sources.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const unused = [...sprite].filter((name) => !new RegExp(`#i-${name}\\b|'${name}'`).test(everything));
    expect(unused).toEqual([]);
  });
});
