import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { migrateProject, CURRENT_VERSION, OLDEST_SUPPORTED_VERSION } from '../../../src/project/project-migrations.js';
import { validateProject, PROJECT_VERSION } from '../../../src/project/project-schema.js';
import { decodeProject, encodeProject, createProject, serializeWires, getLastImportNotes } from '../../../src/project/project-store.js';

// tests/fixtures/project_v1_full.json and .link.txt were produced by the version-1 code (createProject / encodeProject
// before the schema changed): a real v1 project with an LED, a resistor, a button, five wires and one share link.
const v1 = JSON.parse(fs.readFileSync('tests/fixtures/project_v1_full.json', 'utf8'));
const v1Link = fs.readFileSync('tests/fixtures/project_v1_full.link.txt', 'utf8');

describe('schema versions', () => {
  it('the current version is 2 and 1 is still supported', () => {
    expect(CURRENT_VERSION).toBe(2);
    expect(PROJECT_VERSION).toBe(2);
    expect(OLDEST_SUPPORTED_VERSION).toBe(1);
  });
});

describe('migrating a real version-1 project', () => {
  it('the fixture really is version 1, with wires that have no ids', () => {
    expect(v1.version).toBe(1);
    expect(v1.connections.every((w) => w.id === undefined)).toBe(true);
    expect(v1.meta).toBeUndefined();
  });

  it('upgrades it to version 2 with wire ids wire_1..wire_n in file order, and nothing else lost', () => {
    const result = validateProject(v1);
    expect(result.ok).toBe(true);
    const p = result.project;
    expect(p.version).toBe(2);
    expect(p.connections.map((w) => w.id)).toEqual(['wire_1', 'wire_2', 'wire_3', 'wire_4', 'wire_5']);
    expect(p.meta).toEqual({ app: 'voltloom' });
    expect(result.notes).toContain('project upgraded from version 1 to 2');
    // everything that was in v1 is still there
    expect(p.code).toBe(v1.code);
    expect(p.language).toBe(v1.language);
    expect(p.components.map((c) => [c.id, c.type, c.x, c.y, c.rotation])).toEqual(v1.components.map((c) => [c.id, c.type, c.x, c.y, c.rotation]));
    expect(p.components.find((c) => c.type === 'led')).toMatchObject({ color: '#3b82f6', flipped: true });
    expect(p.components.find((c) => c.type === 'resistor')).toMatchObject({ value: 4.7, unit: 1000 });
    expect(p.connections.map((w) => [w.start.nodeType, w.start.pin, w.end.pin, w.color])).toEqual(
      v1.connections.map((w) => [w.start.nodeType, w.start.pin, w.end.pin, w.color ?? '#15803d']));
  });

  it('does not touch the original object (migration works on a copy)', () => {
    const snapshot = JSON.stringify(v1);
    validateProject(v1);
    expect(JSON.stringify(v1)).toBe(snapshot);
  });

  it('is repeatable: migrating twice gives the identical project', () => {
    expect(validateProject(v1).project).toEqual(validateProject(v1).project);
  });

  it('is idempotent: an upgraded project validates unchanged, with no upgrade note', () => {
    const once = validateProject(v1).project;
    const again = validateProject(once);
    expect(again.ok).toBe(true);
    expect(again.project).toEqual(once);
    expect(again.notes).toEqual([]);
  });

  it('a version-1 SHARE LINK from before the change still opens, and reports the upgrade', () => {
    const project = decodeProject(v1Link);
    expect(project).not.toBeNull();
    expect(project.version).toBe(2);
    expect(project.components).toHaveLength(3);
    expect(project.connections).toHaveLength(5);
    expect(getLastImportNotes()).toContain('project upgraded from version 1 to 2');
  });
});

describe('version 2 round trip', () => {
  const comps = [{ id: 'led_1700000000001', color: '#ef4444', flipped: false, x: 1, y: 2, rotation: 0, div: {} }];
  const wires = [
    { id: 'wire_1700000000500', start: { nodeType: 'gpio', pin: 20, x: 1, y: 2 }, end: { nodeType: 'component_pin', componentId: 'led_1700000000001', pin: 'A' }, color: '#15803d', pathElement: {} },
    { id: 'wire_1700000000501', start: { nodeType: 'gpio', pin: 3, x: 3, y: 4 }, end: { nodeType: 'component_pin', componentId: 'led_1700000000001', pin: 'C' }, pathElement: {} },
  ];

  it('createProject writes version 2 with the wire ids and the app marker; savedAt only when asked', () => {
    const p = createProject('print(1)', 'python', comps, wires);
    expect(p.version).toBe(2);
    expect(p.connections.map((w) => w.id)).toEqual(['wire_1700000000500', 'wire_1700000000501']);
    expect(p.meta).toEqual({ app: 'voltloom' });
    const stamped = createProject('print(1)', 'python', comps, wires, 'pico_w', { savedAt: '2026-10-11T10:00:00.000Z' });
    expect(stamped.meta).toEqual({ app: 'voltloom', savedAt: '2026-10-11T10:00:00.000Z' });
  });

  it('save -> share link -> load keeps ids, colours and wiring exactly', () => {
    const p = createProject('print(1)', 'python', comps, wires);
    const decoded = decodeProject(encodeProject(p));
    expect(decoded).toEqual(validateProject(p).project);
    expect(decoded.connections.map((w) => w.id)).toEqual(['wire_1700000000500', 'wire_1700000000501']);
  });

  it('wires without a usable id are not saved with one (no unsafe text ever reaches a file)', () => {
    expect(serializeWires([{ id: '<script>', start: { nodeType: 'gpio', pin: 1 }, end: { nodeType: 'gpio', pin: 2 } }])[0].id).toBeUndefined();
  });
});

describe('what a version-2 project must satisfy', () => {
  const v2 = () => structuredClone(validateProject(v1).project);
  const errors = (p) => { const r = validateProject(p); return r.ok ? [] : r.errors.join(' | '); };

  it('rejects an unsafe or duplicated wire id', () => {
    let p = v2(); p.connections[0].id = '"><img src=x onerror=alert(1)>'; expect(errors(p)).toMatch(/invalid wire id/);
    p = v2(); p.connections[1].id = p.connections[0].id; expect(errors(p)).toMatch(/duplicate wire id/);
  });

  it('assigns the lowest free ids to wires that have none (hand-edited file), without disturbing the ones that do', () => {
    const p = v2(); p.connections[0].id = 'wire_2'; delete p.connections[1].id; delete p.connections[2].id;
    const out = validateProject(p).project.connections.map((w) => w.id);
    expect(out.slice(0, 3)).toEqual(['wire_2', 'wire_1', 'wire_3']);
    expect(new Set(out).size).toBe(out.length);
  });

  it('removes duplicate and self-connecting wires, and says so', () => {
    const p = v2();
    p.connections.push({ ...structuredClone(p.connections[0]), id: 'wire_900' });                                                       // exact duplicate
    p.connections.push({ id: 'wire_901', start: structuredClone(p.connections[0].end), end: structuredClone(p.connections[0].start) }); // same pair, other way round
    p.connections.push({ id: 'wire_902', start: { nodeType: 'gpio', pin: 7 }, end: { nodeType: 'gpio', pin: 7 } });                    // pin to itself
    const r = validateProject(p);
    expect(r.ok).toBe(true);
    expect(r.project.connections).toHaveLength(5);
    expect(r.notes).toContain('2 duplicate connections removed');
    expect(r.notes).toContain('1 connection from a pin to itself removed');
  });

  it('keeps savedAt only if it is a real timestamp', () => {
    let p = v2(); p.meta = { app: 'picolab', savedAt: '2026-10-11T10:00:00.000Z' };     // a file written by an earlier build still loads;
    expect(validateProject(p).project.meta.savedAt).toBe('2026-10-11T10:00:00.000Z');
    expect(validateProject(p).project.meta.app).toBe('voltloom');                          // the stored app name is normalised, not trusted
    p = v2(); p.meta = { savedAt: 'yesterday-ish<script>' };
    expect(validateProject(p).project.meta).toEqual({ app: 'voltloom' });
    p = v2(); p.meta = 'x';
    expect(validateProject(p).project.meta).toEqual({ app: 'voltloom' });
  });
});

describe('versions that cannot be opened are refused with a reason, never half-read', () => {
  const withoutVersion = (() => { const { version, ...rest } = v1; return rest; })();
  it.each([
    [{ ...v1, version: 3 }, /newer version of Voltloom/],
    [{ ...v1, version: 99 }, /newer version of Voltloom/],
    [{ ...v1, version: 0 }, /unsupported version/],
    [{ ...v1, version: -1 }, /unsupported version/],
    [{ ...v1, version: 1.5 }, /unsupported version/],
    [{ ...v1, version: '1' }, /unsupported version/],
    [{ ...v1, version: null }, /unsupported version/],
    [withoutVersion, /unsupported version/],
    [null, /must be an object/],
    [[], /must be an object/],
    ['{"version":1}', /must be an object/],
  ])('%#', (input, pattern) => {
    const r = migrateProject(input);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(pattern);
    expect(validateProject(input).ok).toBe(false);
  });

  it('a hostile v1 project is still rejected after migration (the migration does not launder bad data)', () => {
    const bad = structuredClone(v1);
    bad.components[0].color = '#ef4444;" onload="x';
    expect(validateProject(bad).ok).toBe(false);
    const polluted = JSON.parse('{"version":1,"__proto__":{"polluted":true},"components":[],"connections":[]}');
    const r = validateProject(polluted);
    expect(r.ok).toBe(true);
    expect({}.polluted).toBeUndefined();
    expect(r.project.polluted).toBeUndefined();
  });
});
