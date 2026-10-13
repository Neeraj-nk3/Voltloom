import { describe, it, expect } from 'vitest';
import { validateProject, isSafeComponentId, LIMITS } from '../../../src/project/project-schema.js';
import { createProject } from '../../../src/project/project-store.js';

const led = { id: 'led_1700000000000', type: 'led', x: 100, y: 300, rotation: 0, color: '#ef4444', flipped: false };
const res = { id: 'res_1700000000001', type: 'resistor', x: 50, y: 300, rotation: 90, value: 1, unit: 1000 };
const btn = { id: 'btn_1700000000002', type: 'button', x: 100, y: 600, rotation: 0 };
const base = () => structuredClone({
  version: 1, language: 'python', code: 'print(1)', board: 'pico_w',
  components: [led, res, btn],
  connections: [
    { start: { nodeType: 'gpio', pin: 20, gpNum: '15', x: 12, y: 34 }, end: { nodeType: 'component_pin', componentId: led.id, pin: 'A' }, color: '#15803d' },
    { start: { nodeType: 'gpio', pin: 3 }, end: { nodeType: 'component_pin', componentId: led.id, pin: 'C' } },
  ],
});
const errorsOf = (p) => { const r = validateProject(p); return r.ok ? [] : r.errors.join(' | '); };

describe('validateProject: accepts what the app itself produces', () => {
  it('accepts a full project', () => {
    const r = validateProject(base());
    expect(r.ok).toBe(true);
    expect(r.project.components).toHaveLength(3);
    expect(r.project.connections[1].color).toBe('#15803d'); // default applied
  });

  it('accepts the output of createProject() (round trip with project-store)', () => {
    const comps = [{ ...led, div: {} }, { ...res, div: {} }, { ...btn, div: {}, isPressed: true }];
    const wires = [{ start: { nodeType: 'gpio', pin: 20, gpNum: '15', x: 1, y: 2 }, end: { nodeType: 'component_pin', componentId: led.id, pin: 'A' }, color: '#15803d', pathElement: {} }];
    const r = validateProject(createProject('print(2)', 'python', comps, wires));
    expect(r.ok).toBe(true);
    expect(r.project.components.map((c) => c.type)).toEqual(['led', 'resistor', 'button']);
  });

  it('accepts an empty project and fills defaults', () => {
    const r = validateProject({ version: 1 });
    expect(r.ok).toBe(true);
    expect(r.project).toMatchObject({ language: 'python', code: '', board: 'pico_w', components: [], connections: [] });
  });
});

describe('validateProject: rejects hostile or malformed input', () => {
  it('rejects markup in a component id (the original XSS payload)', () => {
    const p = base(); p.components[0] = { ...led, id: 'led_1"><img src=x onerror="window.__pwn=1">' };
    expect(errorsOf(p)).toMatch(/invalid id/);
  });

  it.each([
    ['non-object', 'hello'], ['array', []], ['null', null],
  ])('rejects %s', (_n, v) => expect(validateProject(v).ok).toBe(false));

  it('rejects wrong version, language, board', () => {
    expect(errorsOf({ ...base(), version: 99 })).toMatch(/newer version/);
    expect(errorsOf({ ...base(), version: 0 })).toMatch(/unsupported version/);
    expect(errorsOf({ ...base(), version: '1' })).toMatch(/unsupported version/);
    expect(errorsOf({ ...base(), version: undefined })).toMatch(/unsupported version/);
    expect(errorsOf({ ...base(), language: 'js' })).toMatch(/language/);
    expect(errorsOf({ ...base(), board: 'esp32' })).toMatch(/board/);
  });

  it('rejects component id/type mismatch, duplicates, bad numbers and colours', () => {
    let p = base(); p.components[0].type = 'resistor'; expect(errorsOf(p)).toMatch(/type must be/);
    p = base(); p.components.push({ ...led }); expect(errorsOf(p)).toMatch(/duplicate id/);
    p = base(); p.components[0].x = Infinity; expect(errorsOf(p)).toMatch(/finite/);
    p = base(); p.components[0].x = 1e9; expect(errorsOf(p)).toMatch(/within/);
    p = base(); p.components[0].color = 'red'; expect(errorsOf(p)).toMatch(/#rrggbb/);
    p = base(); p.components[0].color = '#ef4444;" onload="x'; expect(errorsOf(p)).toMatch(/#rrggbb/);
    p = base(); p.components[1].unit = 7; expect(errorsOf(p)).toMatch(/unit/);
    p = base(); p.components[0].rotation = 45; expect(errorsOf(p)).toMatch(/rotation/);
  });

  it('rejects wires that reference unknown components, wrong pins or bad gpio numbers', () => {
    let p = base(); p.connections[0].end.componentId = 'led_999'; expect(errorsOf(p)).toMatch(/unknown component/);
    p = base(); p.connections[0].end.pin = 'X'; expect(errorsOf(p)).toMatch(/invalid pin/);
    p = base(); p.connections[0].start.pin = 41; expect(errorsOf(p)).toMatch(/1\.\.40/);
    p = base(); p.connections[0].start.gpNum = '99'; expect(errorsOf(p)).toMatch(/gpNum/);
    p = base(); p.connections[0].start = { nodeType: 'evil' }; expect(errorsOf(p)).toMatch(/nodeType/);
    p = base(); p.connections[0].color = 'url(javascript:alert(1))'; expect(errorsOf(p)).toMatch(/#rrggbb/);
  });

  it('enforces size limits', () => {
    expect(errorsOf({ ...base(), code: 'x'.repeat(LIMITS.maxCodeChars + 1) })).toMatch(/longer than/);
    const many = Array.from({ length: LIMITS.maxComponents + 1 }, (_, i) => ({ ...led, id: `led_${i + 1}` }));
    expect(errorsOf({ version: 1, components: many })).toMatch(/more than/);
    const wires = Array.from({ length: LIMITS.maxWires + 1 }, () => base().connections[1]);
    expect(errorsOf({ ...base(), connections: wires })).toMatch(/more than/);
  });

  it('does not copy unknown keys, so prototype-pollution style input is dropped', () => {
    const p = JSON.parse('{"version":1,"__proto__":{"polluted":true},"components":[{"id":"led_1","type":"led","x":1,"y":2,"constructor":{"x":1},"extra":"<b>"}]}');
    const r = validateProject(p);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.project.components[0]).sort()).toEqual(['color', 'flipped', 'id', 'rotation', 'type', 'x', 'y']);
    expect({}.polluted).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const p = base(); const before = JSON.stringify(p);
    validateProject(p);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe('isSafeComponentId', () => {
  it('only allows ids the app generates', () => {
    expect(isSafeComponentId('led_1700000000000')).toBe(true);
    expect(isSafeComponentId('res_1')).toBe(true);
    for (const bad of ['led_', 'LED_1', 'led_1x', 'led_1"', 'x_1', '', null, undefined, 5, 'led_12345678901234567']) {
      expect(isSafeComponentId(bad)).toBe(false);
    }
  });
});
