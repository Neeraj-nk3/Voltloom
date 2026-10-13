import { describe, it, expect } from 'vitest';
import { solveDC } from '../../../src/electrical/solver.js';
import { ledModel } from '../../../src/electrical/led-model.js';
import { DEFAULT_LIMITS, resolveLimits, analyze, formatAmps, formatWatts } from '../../../src/electrical/limits.js';
import { ledColorMap } from '../../../src/shared/colors.js';
import { LED_FORWARD_VOLTS } from '../../../src/electrical/led-model.js';

const res = (id, a, b, ohms, extra = {}) => ({ type: 'resistor', id, a, b, ohms, ...extra });
const src = (id, node, volts, ohms = 0, extra = {}) => ({ type: 'source', id, node, volts, ohms, ...extra });
const led = (id, anode, cathode, model, extra = {}) => ({ type: 'led', id, anode, cathode, model, ...extra });
const red = ledModel(1.9);

function check(circuit, limits) {
  const result = solveDC(circuit);
  return analyze(circuit, result, limits);
}

describe('limits configuration', () => {
  it('documented defaults', () => {
    expect(DEFAULT_LIMITS).toMatchObject({ ledWarnAmps: 0.020, ledDestroyAmps: 0.030, resistorWatts: 0.25 });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });

  it('overrides apply, null disables, unknown names and bad values are rejected', () => {
    expect(resolveLimits({ ledWarnAmps: 0.01 }).ledWarnAmps).toBe(0.01);
    expect(resolveLimits({ resistorWatts: null }).resistorWatts).toBeNull();
    expect(() => resolveLimits({ ledWarnAmp: 0.01 })).toThrow(/unknown electrical limit/);
    expect(() => resolveLimits({ ledWarnAmps: -1 })).toThrow();
    expect(() => resolveLimits({ ledWarnAmps: NaN })).toThrow();
    expect(() => resolveLimits({ ledWarnAmps: '20mA' })).toThrow();
    expect(() => resolveLimits({ ledWarnAmps: 0.04 })).toThrow(/ledDestroyAmps/);
  });

  it('does not mutate the defaults', () => {
    resolveLimits({ ledWarnAmps: 0.001 });
    expect(DEFAULT_LIMITS.ledWarnAmps).toBe(0.020);
  });

  it('every LED swatch colour the app offers has a forward voltage', () => {
    for (const color of Object.keys(ledColorMap)) expect(LED_FORWARD_VOLTS[color], color).toBeGreaterThan(1);
  });
});

describe('formatting', () => {
  it('formats amps and watts readably', () => {
    expect(formatAmps(0.0362)).toBe('36.2 mA');
    expect(formatAmps(13.2)).toBe('13.2 A');
    expect(formatAmps(0.0003)).toBe('0.30 mA');
    expect(formatAmps(-0.02)).toBe('20.0 mA');
    expect(formatWatts(0.3125)).toBe('0.31 W');
  });
});

describe('warnings', () => {
  const ledCircuit = (rOhms, sourceExtra = {}) => ({
    nodeCount: 3,
    elements: [src('v', 1, 3.3, 0.2, sourceExtra), res('r', 1, 2, rOhms, { label: 'Resistor 1' }), led('d', 2, 0, red, { label: 'LED 1' })]
  });

  it('a sensible LED circuit is silent', () => {
    expect(check(ledCircuit(330))).toEqual([]);
  });

  it('LED over the warning limit warns with numbers and advice', () => {
    // red LED at 3.3 V: 60 ohm gives a current between the 20 mA warning and 30 mA destroy limits
    const w = check(ledCircuit(60));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'led-overcurrent', severity: 'warning', subject: 'd', limit: 0.02 });
    expect(w[0].message).toMatch(/^LED 1 carries \d+\.\d mA \(rating 20\.0 mA\)\. Add or increase a series resistor\.$/);
  });

  it('LED far over the limit is an error saying it would be destroyed', () => {
    const w = check(ledCircuit(0));
    const d = w.find((x) => x.subject === 'd');
    expect(d).toMatchObject({ code: 'led-destroyed', severity: 'error' });
    expect(d.message).toMatch(/would be destroyed/);
  });

  it('the thresholds are configurable and compared strictly', () => {
    const c = ledCircuit(330); // ~3 mA
    expect(check(c, resolveLimits({ ledWarnAmps: 0.002, ledDestroyAmps: 0.004 }))).toHaveLength(1);
    expect(check(c, resolveLimits({ ledWarnAmps: 0.002, ledDestroyAmps: 0.0025 }))[0].code).toBe('led-destroyed');
    expect(check(c, resolveLimits({ ledWarnAmps: null, ledDestroyAmps: null }))).toEqual([]);
  });

  it('resistor power above the rating warns', () => {
    const c = { nodeCount: 1, elements: [src('v', 1, 5, 0), res('r', 1, 0, 50, { label: 'Resistor 9' })] }; // 0.5 W
    const w = check(c);
    expect(w).toHaveLength(1);
    expect(w[0].message).toBe('Resistor 9 dissipates 0.50 W (rated 0.25 W).');
    expect(check(c, resolveLimits({ resistorWatts: 1 }))).toEqual([]);
    expect(check(c, resolveLimits({ resistorWatts: null }))).toEqual([]);
  });

  it('rated source: overload warns, a dead short is an error with a clear message', () => {
    const rail = (load) => ({ nodeCount: 1, elements: [src('rail', 1, 3.3, 0.2, { ratedAmps: 0.3, label: '3V3' }), res('load', 1, 0, load)] });
    expect(check(rail(100))).toEqual([]);                       // 33 mA
    const over = check(rail(8));                                // ~0.4 A
    expect(over[0]).toMatchObject({ code: 'source-overload', severity: 'warning' });
    expect(over[0].message).toMatch(/^3V3 supplies \d+\.\d mA \(rated 300\.0 mA\)\.$/);
    const short = check(rail(0));
    const s = short.find((x) => x.subject === 'rail');
    expect(s).toMatchObject({ code: 'source-short', severity: 'error' });
    expect(s.message).toMatch(/^3V3 is short-circuited \(16\.5 A, rated 300\.0 mA\)\.$/);
  });

  it('a sink is measured by magnitude too', () => {
    const c = { nodeCount: 1, elements: [src('pad', 1, 0, 100, { ratedAmps: 0.004, label: 'GP2' }), src('other', 1, 3.3, 10)] };
    const w = check(c);
    expect(w[0].code).toBe('source-overload');
    expect(w[0].message).toMatch(/^GP2 sinks /);
  });

  it('group limit sums member sourcing currents (e.g. 50 mA total across pads)', () => {
    const els = [];
    const members = [];
    for (let i = 0; i < 4; i++) { els.push(src(`p${i}`, i + 1, 3.3, 170)); els.push(res(`r${i}`, i + 1, 0, 100)); members.push(`p${i}`); }
    const circuit = { nodeCount: 4, elements: els, groups: [{ id: 'gpio', label: 'all GPIO pins', members, maxAmps: 0.05, direction: 'source' }] };
    // each 3.3/270 = 12.2 mA -> 48.9 mA total: under
    expect(check(circuit)).toEqual([]);
    circuit.groups[0].maxAmps = 0.04;
    const w = check(circuit);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'group-overload', subject: 'gpio' });
    expect(w[0].message).toBe('Total source current through all GPIO pins is 48.9 mA (limit 40.0 mA).');
  });

  it('a sinking group counts only current flowing into the member', () => {
    const els = [src('a', 1, 0, 100), src('b', 2, 3.3, 100), res('r1', 1, 3, 100), res('r2', 2, 3, 100), res('rt', 3, 0, 1e9)];
    const circuit = { nodeCount: 3, elements: els, groups: [{ id: 'sink', members: ['a'], maxAmps: 0.001, direction: 'sink' }] };
    const w = check(circuit);
    expect(w.map((x) => x.code)).toEqual(['group-overload']);
    expect(w[0].message).toMatch(/^Total sink current through sink is /);
  });

  it('errors sort before warnings', () => {
    const c = { nodeCount: 2, elements: [src('v', 1, 5, 0), res('hot', 1, 0, 50), led('d', 1, 0, red)] };
    const sev = check(c).map((x) => x.severity);
    expect(sev).toEqual([...sev].sort((a, b) => (a === 'error' ? 0 : 1) - (b === 'error' ? 0 : 1)));
    expect(sev[0]).toBe('error');
  });

  it('an unsolved circuit yields exactly the "could not be solved" error', () => {
    const c = ledCircuit(330);
    const result = solveDC(c, { maxIterations: 1 });
    expect(analyze(c, result)).toEqual([{ code: 'unsolvable', severity: 'error', subject: null, value: null, limit: null,
      message: 'This circuit could not be solved; showing the last valid state.' }]);
  });
});
