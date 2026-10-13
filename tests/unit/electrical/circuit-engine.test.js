import { describe, it, expect } from 'vitest';
import { createCircuitEngine, warningKey } from '../../../src/electrical/circuit-engine.js';
import { formatCurrent, formatVoltage, formatPower, readoutText } from '../../../src/electrical/readout.js';

const pin = (physical) => ({ nodeType: 'gpio', pin: physical });
const cp = (componentId, p) => ({ nodeType: 'component_pin', componentId, pin: p });
const wire = (start, end) => ({ start, end });
const V3V3 = 36; const GND = 3; const GP0 = 1;

const ledCircuit = (ohms) => ({
  components: [{ id: 'res_1', value: ohms, unit: 1 }, { id: 'led_1', color: '#ef4444' }],
  wires: [wire(pin(V3V3), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(cp('led_1', 'C'), pin(GND))],
  pads: {}
});

describe('circuit engine', () => {
  it('solves, and an identical second update reuses the cached result', () => {
    const engine = createCircuitEngine();
    const spec = ledCircuit(330);
    const first = engine.update(spec);
    expect(first.stale).toBe(false);
    expect(first.result.parts.led_1.current).toBeGreaterThan(0.002);
    engine.update(spec);                      // readings settle (they are part of the cache key)
    const a = engine.update(spec); const b = engine.update(spec);
    expect(a.result).toBe(b.result);          // same object: not re-solved
  });

  it('changing a resistor changes the result (no stale cache)', () => {
    const engine = createCircuitEngine();
    const lo = engine.update(ledCircuit(330)).result.parts.led_1.current;
    const hi = engine.update(ledCircuit(10_000_000)).result.parts.led_1.current;
    expect(hi).toBeLessThan(lo / 1000);
  });

  it('input readings keep hysteresis memory between updates', () => {
    const engine = createCircuitEngine();
    // 3V3 -> 100 kohm -> GP0 (pull-down 65 kohm) = 1.3 V, in the undefined band
    const between = (previousRead) => ({
      components: [{ id: 'res_1', value: 100000, unit: 1 }],
      wires: [wire(pin(V3V3), cp('res_1', '1')), wire(cp('res_1', '2'), pin(GP0))],
      pads: { 0: { pull: 'down' } }
    });
    expect(engine.update(between()).result.pads[0].read).toBe(0);
    // Drive it high with a strong pull, then weaken: the reading must stay 1 while in the band
    const strong = { components: [{ id: 'res_1', value: 1000, unit: 1 }], wires: between().wires, pads: { 0: { pull: 'down' } } };
    expect(engine.update(strong).result.pads[0].read).toBe(1);
    expect(engine.update(between()).result.pads[0].read).toBe(1);
    engine.reset();
    expect(engine.update(between()).result.pads[0].read).toBe(0);
  });

  it('a pad is "driven" only when its net reaches ground, a rail or an output pad', () => {
    const engine = createCircuitEngine();
    const r = (spec) => engine.update(spec).result.pads;
    expect(r({ wires: [wire(pin(V3V3), pin(GP0))] })[0].driven).toBe(true);
    expect(r({ wires: [wire(pin(GND), pin(GP0))] })[0].driven).toBe(true);
    expect(r({ wires: [wire(pin(2), pin(GP0))] })[0].driven).toBe(false);          // another input pad: only pulls
    expect(r({ wires: [wire(pin(2), pin(GP0))], pads: { 1: { mode: 'output', level: 1 } } })[0].driven).toBe(true);
    expect(r({ components: [{ id: 'btn_1', isPressed: false }], wires: [wire(pin(V3V3), cp('btn_1', '1')), wire(cp('btn_1', '3'), pin(GP0))] })[0].driven).toBe(false);
    expect(r({ components: [{ id: 'btn_1', isPressed: true }], wires: [wire(pin(V3V3), cp('btn_1', '1')), wire(cp('btn_1', '3'), pin(GP0))] })[0].driven).toBe(true);
    expect(r({})[0].driven).toBe(false);
  });

  it('warnings are reported once when they appear and reported as cleared when they go', () => {
    const engine = createCircuitEngine();
    const bad = engine.update(ledCircuit(1));
    expect(bad.added.map((w) => w.code)).toContain('led-destroyed');
    const again = engine.update(ledCircuit(1));
    expect(again.added).toEqual([]);                       // not repeated while the condition holds
    const good = engine.update(ledCircuit(330));
    expect(good.warnings).toEqual([]);
    expect(good.cleared.some((k) => k.startsWith('led-destroyed'))).toBe(true);
    expect(engine.update(ledCircuit(1)).added.map((w) => w.code)).toContain('led-destroyed'); // and again if it returns
  });

  it('a circuit that cannot be solved keeps the last good result, is flagged stale, and reports the failure', () => {
    const engine = createCircuitEngine();
    const good = engine.update(ledCircuit(330));
    const tooMany = { components: Array.from({ length: 160 }, (_, i) => ({ id: `res_${i}`, value: 100, unit: 1 })), wires: [], pads: {} };
    const failed = engine.update(tooMany);
    expect(failed.stale).toBe(true);
    expect(failed.result).toBe(good.result);               // the previous valid picture, unchanged
    expect(failed.failure.code).toBe('too-large');
    expect(failed.failure.severity).toBe('error');
    expect(failed.added.map((w) => w.code)).toEqual(['too-large']);
    // persistent: still failing next time, and not re-announced
    const still = engine.update(tooMany);
    expect(still.stale).toBe(true);
    expect(still.warnings).toHaveLength(1);
    expect(still.added).toEqual([]);
    // recovery clears it
    const back = engine.update(ledCircuit(330));
    expect(back.stale).toBe(false);
    expect(back.cleared).toContain(warningKey(failed.failure));
  });

  it('with nothing good to show yet, a failure returns result=null (never invented numbers)', () => {
    const engine = createCircuitEngine();
    const failed = engine.update({ components: Array.from({ length: 160 }, (_, i) => ({ id: `res_${i}`, value: 100, unit: 1 })), wires: [], pads: {} });
    expect(failed.stale).toBe(true);
    expect(failed.result).toBeNull();
  });
});

describe('readout formatting', () => {
  it('current, voltage and power use sensible units', () => {
    expect(formatCurrent(0.003)).toBe('3.00 mA');
    expect(formatCurrent(0.0000185)).toBe('18.5 µA');
    expect(formatCurrent(2.5e-9)).toBe('2.5 nA');
    expect(formatCurrent(16.5)).toBe('16.50 A');
    expect(formatCurrent(-0.004)).toBe('-4.00 mA');
    expect(formatCurrent(0)).toBe('0 A');
    expect(formatVoltage(1.912)).toBe('1.91 V');
    expect(formatVoltage(0.0123)).toBe('12.3 mV');
    expect(formatPower(0.0021)).toBe('2.10 mW');
    expect(formatPower(0.5)).toBe('500.00 mW');
  });
  it('per-type text, empty when there is no data', () => {
    const part = { current: 0.003, voltage: 1.9, power: 0.0057 };
    expect(readoutText('led', part)).toBe('3.00 mA · 1.90 V');
    expect(readoutText('resistor', part)).toBe('3.00 mA · 1.90 V · 5.70 mW');
    expect(readoutText('led', undefined)).toBe('');
    expect(readoutText('unknown', part)).toBe('');
  });
});
