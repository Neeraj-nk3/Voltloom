import { describe, it, expect } from 'vitest';
import { evaluateBoard, readLevel, MAX_PWM_PADS } from '../../../src/electrical/board-eval.js';
import { buildNetlist, normalizePad } from '../../../src/electrical/netlist.js';
import { resolveBoardParams, BOARD_DEFAULTS } from '../../../src/electrical/board-params.js';
import { classifyPhysicalPin, physicalPinOfGpio, headerGpios } from '../../../src/electrical/pico-pins.js';
import { ledModel } from '../../../src/electrical/led-model.js';

// Expected values are computed here by hand / by bisection on the physical equations, not by the engine.

const PIN = { GP0: 1, GP1: 2, GND: 3, GP2: 4, GP14: 19, GP15: 20, GP16: 21, GP17: 22, RUN: 30, ADC_VREF: 35,
  V3V3: 36, EN3V3: 37, VSYS: 39, VBUS: 40 };
const pin = (physical) => ({ nodeType: 'gpio', pin: physical });
const cp = (componentId, p) => ({ nodeType: 'component_pin', componentId, pin: p });
const wire = (start, end) => ({ id: `w_${Math.random()}`, start, end });
const led = (id = 'led_1', color = '#ef4444') => ({ id, color });
const resistor = (id, value, unit = 1) => ({ id, value, unit });
const button = (id = 'btn_1', isPressed = false) => ({ id, isPressed });

function seriesLedCurrent(volts, ohms, vf) {
  const m = ledModel(vf);
  let lo = 0; let hi = volts / (ohms + m.rs);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (volts - mid * (ohms + m.rs) - m.nVt * Math.log(mid / m.is + 1) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const lit = (r, id = 'led_1') => r.parts[id].current;
const codes = (r) => r.warnings.map((w) => w.code);

describe('pin classification', () => {
  it('knows grounds, the three rails, 30 GPIOs-worth of header pads, and the unmodelled pins', () => {
    expect(classifyPhysicalPin(3)).toEqual({ kind: 'ground', label: 'GND.1' });
    expect(classifyPhysicalPin(36)).toEqual({ kind: 'rail', label: '3V3(OUT)' });
    expect(classifyPhysicalPin(40).kind).toBe('rail');
    expect(classifyPhysicalPin(39).kind).toBe('rail');
    for (const p of [37, 35, 30]) expect(classifyPhysicalPin(p).kind).toBe('unmodelled');
    expect(classifyPhysicalPin(31)).toEqual({ kind: 'gpio', label: 'GP26', gpio: 26 });
    expect(classifyPhysicalPin(99)).toBeNull();
    expect(headerGpios()).toHaveLength(26);
    expect(physicalPinOfGpio(15)).toBe(20);
    expect(physicalPinOfGpio(23)).toBeNull();
  });

  it('every one of the 40 pins is classified exactly once', () => {
    const kinds = {};
    for (let p = 1; p <= 40; p++) { const c = classifyPhysicalPin(p); expect(c, `pin ${p}`).not.toBeNull(); kinds[c.kind] = (kinds[c.kind] || 0) + 1; }
    expect(kinds).toEqual({ ground: 8, rail: 3, unmodelled: 3, gpio: 26 });
  });
});

describe('board parameters', () => {
  it('documented defaults come from the datasheet-derived figures', () => {
    expect(BOARD_DEFAULTS).toMatchObject({ padHighOhms: 170, padLowOhms: 100, pullOhms: 65000, readHighVolts: 2.0, readLowVolts: 0.8, gpioTotalAmps: 0.05 });
    expect(Object.isFrozen(BOARD_DEFAULTS)).toBe(true);
  });
  it('overrides are validated', () => {
    expect(resolveBoardParams({ padHighOhms: 200 }).padHighOhms).toBe(200);
    expect(() => resolveBoardParams({ padHighOhm: 200 })).toThrow(/unknown board parameter/);
    expect(() => resolveBoardParams({ pullOhms: 0 })).toThrow();
    expect(() => resolveBoardParams({ readLowVolts: 2.5 })).toThrow(/below/);
    expect(() => resolveBoardParams({ padDriveAmps: 0.02 })).toThrow();
  });
  it('pad states default to the chip reset state: input, pull-down; bad drive strength or duty rejected', () => {
    const p = resolveBoardParams();
    expect(normalizePad({}, p)).toMatchObject({ mode: 'input', pull: 'down', level: 0, duty: null, driveAmps: 0.004 });
    expect(() => normalizePad({ driveAmps: 0.005 }, p)).toThrow(/drive strength/);
    expect(() => normalizePad({ duty: 1.5 }, p)).toThrow();
    expect(normalizePad({ driveAmps: 0.012 }, p).driveAmps).toBe(0.012);
  });
});

describe('LED circuits from the rails', () => {
  it('3V3 -> 330 ohm -> LED -> GND lights with no program (B1)', () => {
    const r = evaluateBoard({
      components: [resistor('res_1', 330), led()],
      wires: [wire(pin(PIN.V3V3), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(cp('led_1', 'C'), pin(PIN.GND))]
    });
    expect(r.ok).toBe(true);
    expect(lit(r)).toBeCloseTo(seriesLedCurrent(3.3, 0.2 + 330, 1.9), 6);
    expect(r.parts.res_1.power).toBeCloseTo(lit(r) ** 2 * 330, 8);
    expect(r.warnings).toEqual([]);
  });

  it('resistance matters: 10 Mohm is dark, 330 ohm is lit, 1 ohm raises an overcurrent error', () => {
    const run = (ohms) => evaluateBoard({
      components: [resistor('res_1', ohms), led()],
      wires: [wire(pin(PIN.V3V3), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(cp('led_1', 'C'), pin(PIN.GND))]
    });
    expect(lit(run(1e7))).toBeLessThan(2e-6);
    expect(lit(run(330))).toBeGreaterThan(2e-3);
    const hot = run(1);
    expect(lit(hot)).toBeGreaterThan(0.03);
    expect(codes(hot)).toContain('led-destroyed');
  });

  it('resistor units: value x unit', () => {
    const run = (value, unit) => lit(evaluateBoard({
      components: [resistor('res_1', value, unit), led()],
      wires: [wire(pin(PIN.V3V3), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(cp('led_1', 'C'), pin(PIN.GND))]
    }));
    expect(run(1, 1000)).toBeCloseTo(run(1000, 1), 12);
    expect(run(1, 1e6)).toBeCloseTo(run(1000, 1000), 12);
  });

  it('VBUS (5 V) and VSYS (4.7 V) drive LEDs through their own resistances; colour changes the current', () => {
    const run = (rail, color) => evaluateBoard({
      components: [resistor('res_1', 330), led('led_1', color)],
      wires: [wire(pin(rail), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(cp('led_1', 'C'), pin(PIN.GND))]
    });
    expect(lit(run(PIN.VBUS, '#ef4444'))).toBeCloseTo(seriesLedCurrent(5, 0.1 + 330, 1.9), 6);
    expect(lit(run(PIN.VSYS, '#ef4444'))).toBeCloseTo(seriesLedCurrent(4.7, 0.3 + 330, 1.9), 6);
    expect(lit(run(PIN.V3V3, '#3b82f6'))).toBeCloseTo(seriesLedCurrent(3.3, 0.2 + 330, 3.0), 6);
    expect(lit(run(PIN.V3V3, '#3b82f6'))).toBeLessThan(lit(run(PIN.V3V3, '#ef4444')) / 2);
  });

  it('an LED reversed (anode to GND, cathode to the rail) stays dark', () => {
    const r = evaluateBoard({ components: [resistor('res_1', 330), led()],
      wires: [wire(pin(PIN.V3V3), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'C')), wire(cp('led_1', 'A'), pin(PIN.GND))] });
    expect(Math.abs(lit(r))).toBeLessThan(1e-9);
  });

  it('B7: 3V3_EN, ADC_VREF and RUN are not sources', () => {
    for (const p of [PIN.EN3V3, PIN.ADC_VREF, PIN.RUN]) {
      const r = evaluateBoard({ components: [led()], wires: [wire(pin(p), cp('led_1', 'A')), wire(cp('led_1', 'C'), pin(PIN.GND))] });
      expect(Math.abs(lit(r)), `pin ${p}`).toBeLessThan(1e-9);
    }
  });

  it('all eight GND pins are one node', () => {
    const r = evaluateBoard({ components: [resistor('res_1', 330), led()],
      wires: [wire(pin(PIN.V3V3), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(cp('led_1', 'C'), pin(38))] });
    expect(lit(r)).toBeCloseTo(seriesLedCurrent(3.3, 330.2, 1.9), 6);
  });
});

describe('push button', () => {
  const circuit = (pressed, topPin = '1', bottomPin = '3') => evaluateBoard({
    components: [button('btn_1', pressed), resistor('res_1', 330), led()],
    wires: [wire(pin(PIN.V3V3), cp('btn_1', topPin)), wire(cp('btn_1', bottomPin), cp('res_1', '1')),
      wire(cp('res_1', '2'), cp('led_1', 'A')), wire(cp('led_1', 'C'), pin(PIN.GND))]
  });

  it('open: dark. pressed: lit, with 0.1 ohm contact resistance in the loop', () => {
    expect(Math.abs(lit(circuit(false)))).toBeLessThan(1e-9);
    expect(lit(circuit(true))).toBeCloseTo(seriesLedCurrent(3.3, 0.2 + 0.1 + 330, 1.9), 6);
  });

  it('pins 1/2 are one contact and 3/4 the other: any top pin to any bottom pin works', () => {
    for (const top of ['1', '2']) for (const bottom of ['3', '4']) {
      expect(lit(circuit(true, top, bottom))).toBeGreaterThan(2e-3);
      expect(Math.abs(lit(circuit(false, top, bottom)))).toBeLessThan(1e-9);
    }
  });

  it('wiring both contacts to the same side never conducts through the switch', () => {
    const r = evaluateBoard({ components: [button('btn_1', true), resistor('res_1', 330)],
      wires: [wire(pin(PIN.V3V3), cp('btn_1', '1')), wire(cp('btn_1', '2'), cp('res_1', '1')), wire(cp('res_1', '2'), pin(PIN.GND))] });
    expect(Math.abs(r.parts.btn_1.current)).toBeLessThan(1e-9);
    expect(r.parts.res_1.current).toBeCloseTo(3.3 / 330.2, 5);
  });
});

describe('GPIO pads', () => {
  const padLed = (pads, ohms = 330) => evaluateBoard({
    components: [resistor('res_1', ohms), led()],
    wires: [wire(pin(PIN.GP15), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(cp('led_1', 'C'), pin(PIN.GND))],
    pads
  });

  it('output high drives the LED through the 170 ohm pad stage; low or input does not', () => {
    const on = padLed({ 15: { mode: 'output', level: 1 } });
    expect(lit(on)).toBeCloseTo(seriesLedCurrent(3.3, 170 + 330, 1.9), 6);
    expect(Math.abs(lit(padLed({ 15: { mode: 'output', level: 0 } })))).toBeLessThan(1e-9);
    expect(Math.abs(lit(padLed({})))).toBeLessThan(1e-9); // input: pull-down only
  });

  it('a 2.6 mA pad current is within 4 mA drive; 47 ohm exceeds it and says so with numbers', () => {
    expect(codes(padLed({ 15: { mode: 'output', level: 1 } }, 330))).toEqual([]);
    const w = padLed({ 15: { mode: 'output', level: 1 } }, 47).warnings;
    expect(w.map((x) => x.code)).toEqual(['source-overload']);
    expect(w[0].message).toMatch(/^GP15 supplies 6\.\d\d mA \(rated 4\.00 mA\)\.$/);
  });

  it('a higher drive-strength setting raises the pad rating', () => {
    expect(codes(padLed({ 15: { mode: 'output', level: 1, driveAmps: 0.008 } }, 47))).toEqual([]);
  });

  it('GPIO low is a real sink: LED from 3V3 to a pad driven low lights (B3)', () => {
    const r = evaluateBoard({ components: [resistor('res_1', 330), led()],
      wires: [wire(pin(PIN.V3V3), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(cp('led_1', 'C'), pin(PIN.GP14))],
      pads: { 14: { mode: 'output', level: 0 } } });
    expect(lit(r)).toBeCloseTo(seriesLedCurrent(3.3, 0.2 + 330 + 100, 1.9), 6);
    expect(r.pads[14].current).toBeLessThan(0); // sinking
  });

  it('GPIO -> GPIO: an input reads the output through the pads (B3)', () => {
    const wires = [wire(pin(PIN.GP14), pin(PIN.GP15))];
    const high = evaluateBoard({ wires, pads: { 14: { mode: 'output', level: 1 }, 15: { mode: 'input' } } });
    expect(high.pads[15].voltage).toBeCloseTo(3.3 * 65000 / (65000 + 170), 4); // pad 170 ohm vs 65 kohm pull-down
    expect(high.pads[15].read).toBe(1);
    const low = evaluateBoard({ wires, pads: { 14: { mode: 'output', level: 0 }, 15: { mode: 'input', pull: 'up' } } });
    expect(low.pads[15].voltage).toBeCloseTo(3.3 * 100 / (65000 + 100), 4);
    expect(low.pads[15].read).toBe(0);
    expect(codes(high)).toEqual([]);
  });

  it('contention: two pads fighting form the 170/100 ohm divider and are reported', () => {
    const r = evaluateBoard({ wires: [wire(pin(PIN.GP14), pin(PIN.GP15))],
      pads: { 14: { mode: 'output', level: 1 }, 15: { mode: 'output', level: 0 } } });
    expect(r.pads[14].voltage).toBeCloseTo(3.3 * 100 / 270, 3);
    const w = r.warnings.find((x) => x.code === 'contention');
    expect(w.message).toBe('GP14 and GP15 drive the same net to opposite levels.');
    expect(w.severity).toBe('error');
    expect(codes(r)).toContain('source-over-max'); // 12.2 mA exceeds the 12 mA maximum
  });

  it('two pads driving the SAME level are not contention', () => {
    const r = evaluateBoard({ wires: [wire(pin(PIN.GP14), pin(PIN.GP15))],
      pads: { 14: { mode: 'output', level: 1 }, 15: { mode: 'output', level: 1 } } });
    expect(codes(r)).not.toContain('contention');
  });

  it('a pad driven high into GND, and a pad driven low into a rail, are reported by name', () => {
    const a = evaluateBoard({ wires: [wire(pin(PIN.GP14), pin(PIN.GND))], pads: { 14: { mode: 'output', level: 1 } } });
    expect(a.warnings.find((x) => x.code === 'contention').message).toBe('GP14 drives high but is connected to GND.');
    const b = evaluateBoard({ wires: [wire(pin(PIN.GP14), pin(PIN.V3V3))], pads: { 14: { mode: 'output', level: 0 } } });
    expect(b.warnings.find((x) => x.code === 'contention').message).toBe('GP14 drives low but is connected to 3V3(OUT).');
  });

  it('an output separated from another by a resistor is not contention (it is a divider)', () => {
    const r = evaluateBoard({ components: [resistor('res_1', 1000)],
      wires: [wire(pin(PIN.GP14), cp('res_1', '1')), wire(cp('res_1', '2'), pin(PIN.GP15))],
      pads: { 14: { mode: 'output', level: 1 }, 15: { mode: 'output', level: 0 } } });
    expect(codes(r)).not.toContain('contention');
    expect(r.pads[15].voltage).toBeCloseTo(3.3 * 100 / (170 + 1000 + 100), 3);
  });

  it('total GPIO source current above 50 mA is reported', () => {
    const wires = []; const pads = {};
    for (const [gpio, physical] of [[14, 19], [15, 20], [16, 21], [17, 22], [2, 4]]) { wires.push(wire(pin(physical), pin(PIN.GND))); pads[gpio] = { mode: 'output', level: 1 }; }
    const r = evaluateBoard({ wires, pads });
    const w = r.warnings.find((x) => x.code === 'group-overload');
    expect(w.message).toMatch(/^Total source current through all GPIO pins is 9\d\.\d mA \(limit 50\.0 mA\)\.$/);
  });

  it('a 3V3 rail shorted to GND is a clear short-circuit error', () => {
    const r = evaluateBoard({ wires: [wire(pin(PIN.V3V3), pin(PIN.GND))] });
    expect(r.ok).toBe(true);
    const w = r.warnings.find((x) => x.code === 'source-short');
    expect(w.message).toMatch(/^3V3\(OUT\) is short-circuited \(16\.5 A, rated 300\.0 mA\)\.$/);
  });

  it('VBUS wired to 3V3: the rails fight through their resistances and are reported', () => {
    const r = evaluateBoard({ wires: [wire(pin(PIN.VBUS), pin(PIN.V3V3))] });
    // (5 - 3.3) / (0.1 + 0.2) = 5.67 A
    expect(r.warnings.map((w) => w.code)).toContain('source-short');
  });
});

describe('input reading', () => {
  const params = resolveBoardParams();

  it('thresholds with hysteresis', () => {
    expect(readLevel(3.3, 0, params)).toBe(1);
    expect(readLevel(2.0, 0, params)).toBe(1);
    expect(readLevel(1.99, 0, params)).toBe(0);
    expect(readLevel(1.99, 1, params)).toBe(1);
    expect(readLevel(0.81, 1, params)).toBe(1);
    expect(readLevel(0.8, 1, params)).toBe(0);
    expect(readLevel(0, 1, params)).toBe(0);
  });

  it('unwired pads: pull-down reads 0, pull-up reads 1 (B9), no pull keeps the previous value', () => {
    expect(evaluateBoard({ pads: {} }).pads[3].read).toBe(0);
    expect(evaluateBoard({ pads: { 3: { pull: 'up' } } }).pads[3].read).toBe(1);
    const none = evaluateBoard({ pads: { 3: { pull: 'none', previousRead: 1 } } }).pads[3];
    expect(none.floating).toBe(true);
    expect(none.read).toBe(1);
  });

  it('B9/B10: a 100 kohm pull-up against the internal 65 kohm pull-down is undefined (~1.3 V), 10 kohm reads high (2.86 V)', () => {
    const run = (ohms, previousRead) => evaluateBoard({ components: [resistor('res_1', ohms)],
      wires: [wire(pin(PIN.V3V3), cp('res_1', '1')), wire(cp('res_1', '2'), pin(PIN.GP0))], pads: { 0: { previousRead } } }).pads[0];
    const weak = run(100000, 0);
    expect(weak.voltage).toBeCloseTo(3.3 * 65000 / (100000.2 + 65000), 3);
    expect(weak.read).toBe(0);
    expect(run(100000, 1).read).toBe(1); // in the undefined band the previous value is kept
    const strong = run(10000, 0);
    expect(strong.voltage).toBeCloseTo(3.3 * 65000 / (10000.2 + 65000), 3);
    expect(strong.read).toBe(1);
  });

  it('a button wired between 3V3 and an input pulls it up only while pressed', () => {
    const run = (pressed) => evaluateBoard({ components: [button('btn_1', pressed)],
      wires: [wire(pin(PIN.V3V3), cp('btn_1', '1')), wire(cp('btn_1', '3'), pin(PIN.GP0))] }).pads[0].read;
    expect(run(false)).toBe(0);
    expect(run(true)).toBe(1);
  });

  it('a button to GND with an internal pull-up reads 1 released, 0 pressed (the usual wiring)', () => {
    const run = (pressed) => evaluateBoard({ components: [button('btn_1', pressed)],
      wires: [wire(pin(PIN.GND), cp('btn_1', '1')), wire(cp('btn_1', '3'), pin(PIN.GP0))], pads: { 0: { pull: 'up' } } }).pads[0].read;
    expect(run(false)).toBe(1);
    expect(run(true)).toBe(0);
  });
});

describe('PWM (B2)', () => {
  const wires = [wire(pin(PIN.GP15), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(cp('led_1', 'C'), pin(PIN.GND))];
  const run = (duty) => evaluateBoard({ components: [resistor('res_1', 330), led()], wires, pads: { 15: { mode: 'output', level: 1, duty } } });

  it('LED current is the duty-weighted average of the high and low solutions', () => {
    const full = seriesLedCurrent(3.3, 170 + 330, 1.9);
    for (const duty of [0.1, 0.25, 0.5, 0.9]) {
      const r = run(duty);
      expect(r.solves).toBe(2);
      expect(lit(r)).toBeCloseTo(duty * full, 7);
    }
  });

  it('duty 0 and 1 are plain constant levels (one solve)', () => {
    expect(run(0).solves).toBe(1); expect(Math.abs(lit(run(0)))).toBeLessThan(1e-9);
    expect(run(1).solves).toBe(1); expect(lit(run(1))).toBeCloseTo(seriesLedCurrent(3.3, 500, 1.9), 7);
  });

  it('pad ratings are judged on the instantaneous peak, not the average', () => {
    const r = evaluateBoard({ components: [resistor('res_1', 47), led()], wires, pads: { 15: { mode: 'output', level: 1, duty: 0.1 } } });
    expect(r.warnings.map((w) => w.code)).toContain('source-overload'); // 6.6 mA peak > 4 mA, though the average is 0.7 mA
    expect(r.pads[15].current).toBeLessThan(0.004);
  });

  it('more PWM pads than the exact limit is flagged as approximated, not silently dropped', () => {
    const pads = {}; const w = [];
    [[0, 1], [1, 2], [2, 4], [3, 5]].slice(0, MAX_PWM_PADS + 1).forEach(([g, p]) => { pads[g] = { mode: 'output', duty: 0.5 }; w.push(wire(pin(p), pin(PIN.GND))); });
    const r = evaluateBoard({ wires: w, pads: Object.fromEntries(Object.entries(pads)) });
    expect(r.notes.join(' ')).toMatch(/approximated as constant/);
    expect(r.solves).toBe(2 ** MAX_PWM_PADS);
  });
});

describe('robustness', () => {
  it('unknown components are ignored with a note; wires to missing components do not crash', () => {
    const r = evaluateBoard({ components: [{ id: 'xyz_1' }, null], wires: [wire(cp('led_9', 'A'), pin(PIN.GND)), { start: null, end: null }] });
    expect(r.ok).toBe(true);
    expect(r.notes.join(' ')).toMatch(/unknown id/);
  });

  it('invalid resistor values are treated as 0 ohm with a note', () => {
    const r = evaluateBoard({ components: [{ id: 'res_1', value: NaN, unit: 1 }, { id: 'res_2', value: -5, unit: 1 }] });
    expect(r.notes.filter((n) => /invalid value/.test(n))).toHaveLength(1); // NaN becomes 0 silently (as the UI does); only the negative value is noted
  });

  it('an enormous design reports "too large" instead of throwing', () => {
    const components = []; const wires = [];
    for (let i = 0; i < 160; i++) components.push(resistor(`res_${i}`, 100));
    const r = evaluateBoard({ components, wires });
    expect(r.ok).toBe(false);
    expect(r.warnings[0].code).toBe('too-large');
  });

  it('every wire merges: a netlist has one node per net, ground is node 0', () => {
    const { circuit, meta } = buildNetlist({ components: [resistor('res_1', 100)], params: resolveBoardParams(),
      wires: [wire(pin(PIN.GND), cp('res_1', '1')), wire(pin(38), pin(PIN.GP0))] });
    const res = circuit.elements.find((e) => e.id === 'res_1');
    expect(res.a).toBe(0);
    expect(meta.nodeOfGpio[0]).toBe(0);
  });

  it('is deterministic and does not mutate its inputs', () => {
    const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
    const spec = deepFreeze({ components: [resistor('res_1', 330), led()],
      wires: [wire(pin(PIN.V3V3), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(cp('led_1', 'C'), pin(PIN.GND))],
      pads: { 15: { mode: 'output', level: 1 } } });
    expect(evaluateBoard(spec)).toEqual(evaluateBoard(spec));
  });
});

describe('performance', () => {
  it('a busy but realistic board (8 LEDs, 8 resistors, 2 buttons, PWM) solves quickly', () => {
    const components = []; const wires = []; const pads = {};
    const gpios = [[0, 1], [1, 2], [2, 4], [3, 5], [4, 6], [5, 7], [6, 9], [7, 10]];
    gpios.forEach(([g, physical], i) => {
      components.push(resistor(`res_${i}`, 330), led(`led_${i}`));
      wires.push(wire(pin(physical), cp(`res_${i}`, '1')), wire(cp(`res_${i}`, '2'), cp(`led_${i}`, 'A')), wire(cp(`led_${i}`, 'C'), pin(PIN.GND)));
      pads[g] = { mode: 'output', level: 1 };
    });
    pads[0].duty = 0.5; pads[1].duty = 0.25;
    components.push(button('btn_1', true), button('btn_2'));
    wires.push(wire(pin(PIN.V3V3), cp('btn_1', '1')), wire(cp('btn_1', '3'), pin(PIN.GP17)), wire(pin(PIN.GND), cp('btn_2', '1')), wire(cp('btn_2', '3'), pin(PIN.GP16)));
    const spec = { components, wires, pads };
    evaluateBoard(spec);
    const times = [];
    for (let i = 0; i < 30; i++) { const t = performance.now(); const r = evaluateBoard(spec); times.push(performance.now() - t); expect(r.ok).toBe(true); }
    times.sort((a, b) => a - b);
    expect(times[15]).toBeLessThan(25); // 4 PWM states x ~45-node solve; generous so loaded machines do not flake
  });
});
