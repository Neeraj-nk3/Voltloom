import { describe, it, expect } from 'vitest';
import { nextUniqueId, isSafeComponentId } from '../../../src/shared/ids.js';

describe('nextUniqueId', () => {
  it('never repeats, even for thousands of ids created in the same millisecond', () => {
    const seen = new Set();
    for (let i = 0; i < 5000; i++) seen.add(nextUniqueId('wire'));
    expect(seen.size).toBe(5000);
  });

  it('skips ids that are already in use (e.g. loaded from a project)', () => {
    const taken = new Set();
    const first = nextUniqueId('led');
    taken.add(first);
    // a project saved by an earlier session may hold any number, including one far ahead of the clock
    const far = `led_${Number(first.split('_')[1]) + 5}`;
    taken.add(far);
    const ids = [];
    for (let i = 0; i < 10; i++) { const id = nextUniqueId('led', (c) => taken.has(c)); taken.add(id); ids.push(id); }
    expect(new Set(ids).size).toBe(10);
    expect(ids).not.toContain(first);
    expect(ids).not.toContain(far);
  });

  it('keeps the shape the importer accepts for parts, so a saved project reloads', () => {
    for (const prefix of ['led', 'res', 'btn']) expect(isSafeComponentId(nextUniqueId(prefix))).toBe(true);
  });

  it('numbers increase, so ids stay roughly in creation order', () => {
    const a = Number(nextUniqueId('x').split('_')[1]);
    const b = Number(nextUniqueId('x').split('_')[1]);
    expect(b).toBeGreaterThan(a);
  });
});
