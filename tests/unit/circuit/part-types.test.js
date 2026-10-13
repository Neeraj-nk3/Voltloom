import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  allPartTypes, getPartType, partTypeOfId, partTypeOf, isPartOfType, partsOfType, indexAmongType,
  partIdPrefixes, buttonConnectedPins,
} from '../../../src/circuit/part-types.js';
import { buildDiagram } from '../../../src/circuit/diagram.js';
import { LEFT_PINS, RIGHT_PINS } from '../../../src/circuit/board-pin-layout.js';

const golden = JSON.parse(fs.readFileSync(new URL('../../e2e/fixtures/parts_golden.json', import.meta.url), 'utf8'));

describe('registry lookup', () => {
  it('knows exactly the three part types, by name and by id prefix', () => {
    expect(allPartTypes().map((d) => d.type)).toEqual(['led', 'resistor', 'button']);
    expect(partIdPrefixes()).toEqual(['led', 'res', 'btn']);
    expect(getPartType('led').idPrefix).toBe('led');
    expect(getPartType('resistor').idPrefix).toBe('res');
    expect(getPartType('button').idPrefix).toBe('btn');
    expect(getPartType('nope')).toBeNull();
    expect(getPartType('toString')).toBeNull();           // no prototype leakage
  });

  it('resolves ids to descriptors and rejects everything that is not a part id', () => {
    expect(partTypeOfId('led_1700000000000').type).toBe('led');
    expect(partTypeOfId('res_5').type).toBe('resistor');
    expect(partTypeOfId('btn_9').type).toBe('button');
    for (const bad of ['', 'led', '_1', 'wire_1', 'constructor_1', '__proto__', null, undefined, 42, {}]) {
      expect(partTypeOfId(bad)).toBeNull();
    }
    expect(partTypeOf({ id: 'led_1' }).type).toBe('led');
    expect(partTypeOf(null)).toBeNull();
  });

  it('type tests, filtering and per-type numbering', () => {
    const list = [{ id: 'led_1' }, { id: 'btn_2' }, { id: 'led_3' }, { id: 'res_4' }, { id: 'btn_5' }];
    expect(isPartOfType(list[0], 'led')).toBe(true);
    expect(isPartOfType('btn_2', 'led')).toBe(false);
    expect(partsOfType(list, 'led').map((c) => c.id)).toEqual(['led_1', 'led_3']);
    expect(indexAmongType(list, list[2])).toBe(2);        // second LED
    expect(indexAmongType(list, list[4])).toBe(2);        // second button
    expect(indexAmongType(list, list[3])).toBe(1);
    expect(indexAmongType(list, { id: 'mystery_1' })).toBe(0);
  });
});

describe('descriptors: pins, polarity, internal links', () => {
  it('lists pins and polarity classes used by the wire-validity rules', () => {
    const led = getPartType('led');
    expect(led.pins).toEqual(['A', 'C']);
    expect([led.pinKind('A'), led.pinKind('C'), led.pinKind('X')]).toEqual(['Anode', 'Cathode', 'Unknown']);
    expect(getPartType('resistor').pins).toEqual(['1', '2']);
    expect(getPartType('button').pins).toEqual(['1', '2', '3', '4']);
    expect(['1', '2'].map((p) => getPartType('resistor').pinKind(p))).toEqual(['Passive', 'Passive']);
    expect(['1', '2', '3', '4'].map((p) => getPartType('button').pinKind(p))).toEqual(Array(4).fill('Passive'));
  });

  it('roles for the circuit engine', () => {
    expect(allPartTypes().map((d) => d.role)).toEqual(['diode', 'resistor', 'switch']);
  });

  it('LED has no internal connection; a resistor joins its two ends', () => {
    expect(getPartType('led').internalLinks('A')).toEqual([]);
    expect(getPartType('resistor').internalLinks('1')).toEqual(['2']);
    expect(getPartType('resistor').internalLinks('2')).toEqual(['1']);
  });

  it('button contacts: rows always joined, rows joined together only while pressed', () => {
    const b = getPartType('button');
    expect(b.internalLinks('1', { isPressed: false }).sort()).toEqual(['2']);
    expect(b.internalLinks('3', { isPressed: false }).sort()).toEqual(['4']);
    expect(b.internalLinks('1', { isPressed: true }).sort()).toEqual(['2', '3', '4']);
    expect(b.internalLinks('4', { isPressed: true }).sort()).toEqual(['1', '2', '3']);
    expect(b.internalLinks('1')).toEqual(['2']);                       // no component: treated as released
    expect(buttonConnectedPins('9', true)).toEqual([]);                // unknown pin
  });
});

describe('descriptors: defaults, saving, restoring, validation', () => {
  it('creation defaults equal the values restored from empty data', () => {
    expect(getPartType('led').defaults()).toEqual({ color: '#ef4444', flipped: false, value: 0, unit: 0 });
    expect(getPartType('resistor').defaults()).toEqual({ value: 1, unit: 1000 });
    expect(getPartType('button').defaults()).toEqual({ isPressed: false });
  });

  it('restore keeps saved fields and fills gaps', () => {
    expect(getPartType('led').restore({ color: '#22c55e', flipped: true })).toMatchObject({ color: '#22c55e', flipped: true });
    expect(getPartType('resistor').restore({ value: 4.7, unit: 1000000 })).toEqual({ value: 4.7, unit: 1000000 });
    expect(getPartType('resistor').restore({ value: 0 })).toEqual({ value: 1, unit: 1000 });   // 0 falls back, as before
  });

  it('serializes only saved fields (runtime-only state is never saved)', () => {
    expect(getPartType('led').serializeFields({ color: '#3b82f6', flipped: true, isOn: true })).toEqual({ color: '#3b82f6', flipped: true });
    expect(getPartType('resistor').serializeFields({ value: 220, unit: 1 })).toEqual({ value: 220, unit: 1 });
    expect(getPartType('button').serializeFields({ isPressed: true })).toEqual({});
  });

  it('validateFields accepts good data and reports the same messages as before', () => {
    const errs = [];
    expect(getPartType('led').validateFields({ color: '#ABCDEF' }, 'c[0]', errs)).toEqual({ color: '#abcdef', flipped: false });
    expect(getPartType('resistor').validateFields({}, 'c[0]', errs)).toEqual({ value: 1, unit: 1000 });
    expect(getPartType('button').validateFields({}, 'c[0]', errs)).toEqual({});
    expect(errs).toEqual([]);
    expect(getPartType('led').validateFields({ color: 'red' }, 'c[1]', errs)).toBeNull();
    expect(getPartType('led').validateFields({ flipped: 'yes' }, 'c[2]', errs)).toBeNull();
    expect(getPartType('resistor').validateFields({ value: -1 }, 'c[3]', errs)).toBeNull();
    expect(getPartType('resistor').validateFields({ unit: 7 }, 'c[4]', errs)).toBeNull();
    expect(errs).toEqual([
      'c[1]: color must be #rrggbb', 'c[2]: flipped must be boolean',
      'c[3]: value must be a number between 0 and 1e9', 'c[4]: unit must be 1, 1000 or 1000000',
    ]);
  });
});

describe('descriptors: inspector, warnings, diagram attributes', () => {
  it('inspector entries match the labels and units the inspector shows', () => {
    expect(getPartType('led').inspectorEntry({ id: 'led_1', color: '#ef4444' })).toEqual({ type: 'LED', id: 'led_1', color: '#ef4444' });
    expect(getPartType('led').inspectorEntry({ id: 'led_1' })).toEqual({ type: 'LED', id: 'led_1', color: 'red' });
    expect(getPartType('resistor').inspectorEntry({ id: 'res_1', value: 4.7, unit: 1000 })).toEqual({ type: 'Resistor', id: 'res_1', value: 4700 });
    expect(getPartType('button').inspectorEntry({ id: 'btn_1', isPressed: true })).toEqual({ type: 'Button', id: 'btn_1', pressed: true });
  });

  const connected = (pins, count = pins.length) => ({ pins: new Set(pins), count });
  it('floating-pin warnings use the exact original texts', () => {
    const led = getPartType('led');
    expect(led.floatingWarnings({ id: 'led_1' }, connected(['A']))).toEqual(['Warning: Floating LED cathode detected. Consider wiring it to GND.']);
    expect(led.floatingWarnings({ id: 'led_1' }, connected(['C']))).toEqual(['Warning: Floating LED anode detected. Consider wiring it to a GPIO or VBUS.']);
    expect(led.floatingWarnings({ id: 'led_1' }, connected(['A', 'C']))).toEqual([]);
    expect(led.floatingWarnings({ id: 'led_1' }, connected([]))).toEqual([]);
    const res = getPartType('resistor');
    expect(res.floatingWarnings({ id: 'res_12' }, connected(['1']))).toEqual(['Warning: Resistor 12 has a floating pin. Resistors must be connected in-line with a circuit.']);
    expect(res.floatingWarnings({ id: 'res_12' }, connected(['1', '2']))).toEqual([]);
    const btn = getPartType('button');
    expect(btn.floatingWarnings({ id: 'btn_7' }, connected(['1'], 1))).toEqual(['Warning: Button 7 is only connected on one side. It will not form a complete circuit.']);
    expect(btn.floatingWarnings({ id: 'btn_7' }, connected(['1', '3'], 2))).toEqual([]);
  });
});

describe('buildDiagram', () => {
  const picoPins = [...LEFT_PINS, ...RIGHT_PINS];
  const g = (pin) => ({ nodeType: 'gpio', pin });
  const cp = (componentId, pin) => ({ nodeType: 'component_pin', componentId, pin });

  it('produces exactly the diagram text the simulator showed before the registry existed', () => {
    const components = [
      { id: 'led_1', x: 100, y: 300 },
      { id: 'res_1', x: 400, y: 300, value: 4.7 },
      { id: 'btn_1', x: 100, y: 600 },
    ];
    const wires = [
      { start: g(20), end: cp('res_1', '1') }, { start: cp('res_1', '2'), end: cp('led_1', 'A') },
      { start: g(3), end: cp('led_1', 'C') }, { start: g(1), end: cp('btn_1', '1') },
    ];
    expect(JSON.stringify(buildDiagram(components, wires, picoPins), null, 2)).toBe(golden.diagram);
  });

  it('numbers parts per type in canvas order and ignores unknown ids and unmatched pins', () => {
    const components = [{ id: 'led_9', x: 1, y: 2 }, { id: 'mystery_1', x: 3, y: 4 }, { id: 'led_8', x: 5, y: 6 }];
    const wires = [{ start: cp('led_8', 'A'), end: cp('mystery_1', 'A') }, { start: cp('led_8', 'C'), end: g(999) }, { start: cp('led_9', 'A'), end: g(36) }];
    const d = buildDiagram(components, wires, picoPins);
    expect(d.parts.map((p) => p.id)).toEqual(['pico', 'led1', 'led2']);
    expect(d.parts[1].connections).toEqual(['A:pico:3V3(OUT)']);
    expect(d.parts[2].connections).toEqual([]);
  });
});
