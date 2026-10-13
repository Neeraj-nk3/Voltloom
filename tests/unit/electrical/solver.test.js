import { describe, it, expect } from 'vitest';
import { solveDC, MAX_NODES } from '../../../src/electrical/solver.js';
import { ledModel, ledModelForColor, ledBrightness, LED_FORWARD_VOLTS } from '../../../src/electrical/led-model.js';

// Every expectation below comes from a calculation written separately from the solver:
// closed-form algebra, or bisection on the physical equations (Ohm, KCL, Shockley), never a call to solveDC.

const res = (id, a, b, ohms) => ({ type: 'resistor', id, a, b, ohms });
const src = (id, node, volts, ohms = 0) => ({ type: 'source', id, node, volts, ohms });
const sw = (id, a, b, closed, ohms = 0.1) => ({ type: 'switch', id, a, b, closed, ohms });
const led = (id, anode, cathode, model) => ({ type: 'led', id, anode, cathode, model });

/** Independent diode: the LED current for a terminal voltage v (bisection on v = I*rs + nVt*ln(I/is+1)). */
function ledCurrentAt(model, v) {
  if (v <= 0) return -model.is * (1 - Math.exp(v / model.nVt)); // reverse: ideal-diode leakage, rs negligible
  let lo = 0; let hi = 10;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const vm = mid * model.rs + model.nVt * Math.log(mid / model.is + 1);
    if (vm < v) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Independent: source -> total series resistance -> one LED to ground. Returns the loop current. */
function seriesLedCurrent(volts, ohms, model) {
  let lo = 0; let hi = volts / Math.max(ohms + model.rs, 1e-9);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const drop = volts - mid * (ohms + model.rs) - model.nVt * Math.log(mid / model.is + 1);
    if (drop > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const red = ledModel(1.9);

describe('resistive networks match closed-form algebra', () => {
  it('voltage divider', () => {
    // (ideal sources are modelled as 1 micro-ohm, so exact figures agree to ~1e-7)
    // 5 V -- 1k -- n2 -- 3k -- GND
    const r = solveDC({ nodeCount: 2, elements: [src('s', 1, 5), res('r1', 1, 2, 1000), res('r2', 2, 0, 3000)] });
    expect(r.ok).toBe(true);
    expect(r.voltages[2]).toBeCloseTo(5 * 3000 / 4000, 7);
    expect(r.elements.r1.current).toBeCloseTo(5 / 4000, 8);
    expect(r.elements.r2.voltage).toBeCloseTo(3.75, 7);
    expect(r.elements.r1.power).toBeCloseTo((5 / 4000) ** 2 * 1000, 9);
  });

  it('series source resistance sags the output (Thevenin source)', () => {
    // 3.3 V behind 0.2 ohm feeding 10 ohm: I = 3.3/10.2
    const r = solveDC({ nodeCount: 1, elements: [src('v', 1, 3.3, 0.2), res('load', 1, 0, 10)] });
    expect(r.voltages[1]).toBeCloseTo(3.3 * 10 / 10.2, 9);
    expect(r.elements.v.current).toBeCloseTo(3.3 / 10.2, 9);
  });

  it('parallel resistors', () => {
    const r = solveDC({ nodeCount: 1, elements: [src('s', 1, 6), res('a', 1, 0, 100), res('b', 1, 0, 300)] });
    expect(r.elements.s.current).toBeCloseTo(6 / 100 + 6 / 300, 7);
  });

  it('Wheatstone bridge, balanced and unbalanced', () => {
    // nodes: 1 top, 2 left mid, 3 right mid. R(1-2)=a, R(2-0)=b, R(1-3)=c, R(3-0)=d, bridge 2-3 = rb
    const bridge = (a, b, c, d, rb) => solveDC({ nodeCount: 3, elements: [
      src('s', 1, 10), res('a', 1, 2, a), res('b', 2, 0, b), res('c', 1, 3, c), res('d', 3, 0, d), res('rb', 2, 3, rb)] });
    const balanced = bridge(100, 200, 150, 300, 47);
    expect(balanced.elements.rb.current).toBeCloseTo(0, 9);
    // Unbalanced: solve the 2-unknown KCL system by Cramer's rule here, independently.
    const [a, b, c, d, rb, V] = [100, 220, 150, 330, 47, 10];
    const g = (x) => 1 / x;
    const a11 = g(a) + g(b) + g(rb); const a12 = -g(rb);
    const a21 = -g(rb); const a22 = g(c) + g(d) + g(rb);
    const b1 = V * g(a); const b2 = V * g(c);
    const det = a11 * a22 - a12 * a21;
    const v2 = (b1 * a22 - a12 * b2) / det; const v3 = (a11 * b2 - a21 * b1) / det;
    const un = bridge(a, b, c, d, rb);
    expect(un.voltages[2]).toBeCloseTo(v2, 6);
    expect(un.voltages[3]).toBeCloseTo(v3, 6);
    expect(un.elements.rb.current).toBeCloseTo((v2 - v3) / rb, 7);
  });

  it('switches: closed is its contact resistance, open carries nothing', () => {
    const closed = solveDC({ nodeCount: 2, elements: [src('s', 1, 3.3), sw('b', 1, 2, true, 0.1), res('r', 2, 0, 330)] });
    expect(closed.elements.b.current).toBeCloseTo(3.3 / 330.1, 10);
    const open = solveDC({ nodeCount: 2, elements: [src('s', 1, 3.3), sw('b', 1, 2, false), res('r', 2, 0, 330)] });
    expect(open.elements.b.current).toBe(0);
    expect(Math.abs(open.voltages[2])).toBeLessThan(1e-9);
  });
});

describe('LED circuits match an independent solution of the diode equation', () => {
  it.each([
    ['red, 330 ohm from a 3V3 pad (170 ohm)', 3.3, 170 + 330, 1.9],
    ['green, 100 ohm', 3.3, 170 + 100, 2.1],
    ['blue, 330 ohm', 3.3, 170 + 330, 3.0],
    ['white, 47 ohm from 5 V', 5, 47, 3.1],
    ['red, 1 kohm', 3.3, 1170, 1.9],
    ['red, 10 kohm', 3.3, 10170, 1.9],
    ['red, 1 Mohm', 3.3, 1000170, 1.9],
    ['red, 10 Mohm', 3.3, 10000170, 1.9]
  ])('%s', (_name, volts, ohms, vf) => {
    const model = ledModel(vf);
    const r = solveDC({ nodeCount: 2, elements: [src('s', 1, volts, 0), res('r', 1, 2, ohms), led('d', 2, 0, model)] });
    expect(r.ok).toBe(true);
    const expected = seriesLedCurrent(volts, ohms, model);
    expect(Math.abs(r.elements.d.current - expected)).toBeLessThan(Math.max(1e-9, expected * 1e-4));
    // Kirchhoff: the resistor carries the same current
    expect(Math.abs(r.elements.r.current - r.elements.d.current)).toBeLessThan(Math.max(1e-9, expected * 1e-4));
  });

  it('an LED reads its specified forward voltage at 10 mA for every colour in the table', () => {
    for (const [color, vf] of Object.entries(LED_FORWARD_VOLTS)) {
      const r = solveDC({ nodeCount: 1, elements: [src('s', 1, vf, 0), led('d', 1, 0, ledModelForColor(color))] });
      expect(r.elements.d.current).toBeCloseTo(0.010, 4);
    }
  });

  it('two LEDs in series add their voltages', () => {
    const m1 = ledModel(1.9); const m2 = ledModel(2.1);
    const r = solveDC({ nodeCount: 3, elements: [src('s', 1, 5, 0), res('r', 1, 2, 100), led('d1', 2, 3, m1), led('d2', 3, 0, m2)] });
    // independent: total loop; bisection on I with both diode drops
    let lo = 0; let hi = 0.05;
    for (let i = 0; i < 200; i++) {
      const I = (lo + hi) / 2;
      const drop = 5 - I * 100 - (I * m1.rs + m1.nVt * Math.log(I / m1.is + 1)) - (I * m2.rs + m2.nVt * Math.log(I / m2.is + 1));
      if (drop > 0) lo = I; else hi = I;
    }
    expect(r.elements.d1.current).toBeCloseTo((lo + hi) / 2, 7);
    expect(r.elements.d1.voltage + r.elements.d2.voltage).toBeCloseTo(r.voltages[2], 9);
  });

  it('two different LEDs in parallel share the node voltage; the lower-Vf LED takes more current', () => {
    const mr = ledModel(1.9); const mb = ledModel(3.0);
    const r = solveDC({ nodeCount: 2, elements: [src('s', 1, 5, 0), res('r', 1, 2, 200), led('dr', 2, 0, mr), led('db', 2, 0, mb)] });
    // independent: outer bisection on the common node voltage v: (5-v)/200 = Ir(v) + Ib(v)
    let lo = 0; let hi = 5;
    for (let i = 0; i < 200; i++) {
      const v = (lo + hi) / 2;
      const supplied = (5 - v) / 200; const drawn = ledCurrentAt(mr, v) + ledCurrentAt(mb, v);
      if (supplied > drawn) lo = v; else hi = v;
    }
    const v = (lo + hi) / 2;
    expect(r.voltages[2]).toBeCloseTo(v, 6);
    expect(r.elements.dr.current).toBeCloseTo(ledCurrentAt(mr, v), 7);
    expect(r.elements.dr.current).toBeGreaterThan(r.elements.db.current);
  });
});

describe('edge cases', () => {
  it('a bare LED across a 3V3 rail (0.2 ohm) converges to the physical, very large current', () => {
    const r = solveDC({ nodeCount: 1, elements: [src('v', 1, 3.3, 0.2), led('d', 1, 0, red)] });
    expect(r.ok).toBe(true);
    // independent: loop with source resistance 0.2
    expect(r.elements.d.current).toBeCloseTo(seriesLedCurrent(3.3, 0.2, red), 4);
    expect(r.elements.d.current).toBeGreaterThan(0.1);
  });

  it('a reversed LED conducts only the tiny reverse current', () => {
    const r = solveDC({ nodeCount: 2, elements: [src('s', 1, 3.3, 0), res('r', 1, 2, 330), led('d', 0, 2, red)] });
    expect(r.ok).toBe(true);
    expect(Math.abs(r.elements.d.current)).toBeLessThan(1e-12);
    expect(r.voltages[2]).toBeCloseTo(3.3, 6);
  });

  it('a dead short on a source gives V/R, not NaN', () => {
    const r = solveDC({ nodeCount: 1, elements: [src('v', 1, 3.3, 0.2), res('wire', 1, 0, 0)] });
    expect(r.ok).toBe(true);
    expect(r.elements.v.current).toBeCloseTo(3.3 / 0.2, 3);
    expect(Number.isFinite(r.voltages[1])).toBe(true);
  });

  it('two opposing sources fight through their internal resistances', () => {
    const r = solveDC({ nodeCount: 1, elements: [src('a', 1, 3.3, 0.2), src('b', 1, 5, 0.1)] });
    expect(r.elements.b.current).toBeCloseTo(1.7 / 0.3, 6);
    expect(r.elements.a.current).toBeCloseTo(-1.7 / 0.3, 6);
    expect(r.voltages[1]).toBeCloseTo(3.3 + 0.2 * (1.7 / 0.3), 6);
  });

  it('floating (unconnected) nodes settle at 0 V and do not disturb the rest', () => {
    const r = solveDC({ nodeCount: 4, elements: [src('s', 1, 3.3), res('r', 1, 0, 1000)] });
    expect(r.ok).toBe(true);
    for (const n of [2, 3, 4]) expect(Math.abs(r.voltages[n])).toBeLessThan(1e-9);
  });

  it('a node connected only through an open switch is floating, not a source', () => {
    const r = solveDC({ nodeCount: 2, elements: [src('s', 1, 3.3), sw('b', 1, 2, false), led('d', 2, 0, red)] });
    expect(Math.abs(r.elements.d.current)).toBeLessThan(1e-12);
  });

  it('very large resistance (1e12 ohm) carries essentially nothing', () => {
    const r = solveDC({ nodeCount: 2, elements: [src('s', 1, 3.3), res('r', 1, 2, 1e12), res('l', 2, 0, 1e3)] });
    expect(r.ok).toBe(true);
    expect(r.elements.r.current).toBeLessThan(1e-8);
  });

  it('empty circuit, ground-only circuit, and an element with both ends on one node', () => {
    expect(solveDC({ nodeCount: 0, elements: [] }).ok).toBe(true);
    const r = solveDC({ nodeCount: 1, elements: [res('loop', 1, 1, 100), res('g', 0, 0, 100), src('s', 1, 3.3, 1)] });
    expect(r.ok).toBe(true);
    expect(r.elements.loop.current).toBe(0);
    expect(r.elements.g.current).toBe(0);
  });

  it('many LEDs in series from a high voltage still converge', () => {
    const els = [src('s', 1, 30, 0), res('r', 1, 2, 220)];
    for (let i = 0; i < 8; i++) els.push(led(`d${i}`, 2 + i, 3 + i, red));
    els.push(res('tail', 10, 0, 1));
    const r = solveDC({ nodeCount: 10, elements: els });
    expect(r.ok).toBe(true);
    for (let i = 1; i < 8; i++) expect(r.elements[`d${i}`].current).toBeCloseTo(r.elements.d0.current, 7);
  });

  it('a stiff start (large hostile voltage across a bare LED) converges via the fallbacks if needed', () => {
    const r = solveDC({ nodeCount: 1, elements: [src('s', 1, 48, 0.05), led('d', 1, 0, ledModel(3.1))] });
    expect(r.ok).toBe(true);
    expect(['newton', 'gmin-stepping', 'source-stepping']).toContain(r.method);
    expect(r.elements.d.current).toBeCloseTo(seriesLedCurrent(48, 0.05, ledModel(3.1)), 3);
  });

  it('failing to converge is reported, not hidden', () => {
    const r = solveDC({ nodeCount: 2, elements: [src('s', 1, 3.3, 0), res('r', 1, 2, 330), led('d', 2, 0, red)] }, { maxIterations: 1 });
    expect(r.ok).toBe(false);
    expect(r.method).toBe('failed');
  });
});

describe('input contract', () => {
  const base = () => ({ nodeCount: 1, elements: [src('s', 1, 3.3), res('r', 1, 0, 100)] });

  it.each([
    ['node out of range', (c) => { c.elements[1].b = 5; }],
    ['negative node', (c) => { c.elements[1].a = -1; }],
    ['fractional node', (c) => { c.elements[1].a = 0.5; }],
    ['NaN resistance', (c) => { c.elements[1].ohms = NaN; }],
    ['negative resistance', (c) => { c.elements[1].ohms = -5; }],
    ['infinite voltage', (c) => { c.elements[0].volts = Infinity; }],
    ['duplicate id', (c) => { c.elements[1].id = 's'; }],
    ['missing id', (c) => { delete c.elements[1].id; }],
    ['unknown type', (c) => { c.elements[1].type = 'capacitor'; }],
    ['bad nodeCount', (c) => { c.nodeCount = -1; }],
    ['too many nodes', (c) => { c.nodeCount = MAX_NODES + 1; }],
    ['LED without a model', (c) => { c.elements.push({ type: 'led', id: 'd', anode: 1, cathode: 0 }); }],
    ['switch with non-boolean state', (c) => { c.elements.push({ type: 'switch', id: 'w', a: 1, b: 0, closed: 'yes', ohms: 0.1 }); }]
  ])('rejects %s', (_name, mutate) => {
    const c = base(); mutate(c);
    expect(() => solveDC(c)).toThrow();
  });

  it('never mutates its input (deep-frozen circuit solves fine) and is deterministic', () => {
    const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
    const c = deepFreeze({ nodeCount: 2, elements: [src('s', 1, 3.3, 0.2), res('r', 1, 2, 330), led('d', 2, 0, deepFreeze({ ...red }))] });
    const a = solveDC(c); const b = solveDC(c);
    expect(Array.from(a.voltages)).toEqual(Array.from(b.voltages));
    expect(a.elements).toEqual(b.elements);
  });
});

describe('property: Kirchhoff current law holds on random circuits, checked with independent device equations', () => {
  function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
  const models = [ledModel(1.9), ledModel(2.1), ledModel(3.0), ledModel(3.1)];

  function randomCircuit(rand) {
    const n = 3 + Math.floor(rand() * 6);
    const pick = () => Math.floor(rand() * (n + 1));
    const elements = [src('s', 1, [3.3, 5, 4.7][Math.floor(rand() * 3)], rand() * 0.5)];
    const count = 4 + Math.floor(rand() * 8);
    for (let i = 0; i < count; i++) {
      const kind = rand();
      const a = pick(); const b = pick();
      if (kind < 0.5) elements.push(res(`r${i}`, a, b, Math.pow(10, rand() * 6)));
      else if (kind < 0.8) elements.push(led(`d${i}`, a, b, models[Math.floor(rand() * models.length)]));
      else elements.push(sw(`w${i}`, a, b, rand() < 0.5, 0.1));
    }
    if (rand() < 0.4) elements.push(src('s2', pick(), 3.3, 170));
    return { nodeCount: n, elements };
  }

  it('400 random circuits: converge, and every node balances within solver tolerance', () => {
    const rand = rng(12345);
    for (let k = 0; k < 400; k++) {
      const c = randomCircuit(rand);
      const r = solveDC(c);
      expect(r.ok, `circuit ${k}`).toBe(true);
      const inflow = new Float64Array(c.nodeCount + 1); const magnitude = new Float64Array(c.nodeCount + 1);
      const add = (node, amps) => { inflow[node] += amps; magnitude[node] += Math.abs(amps); };
      const V = (n) => r.voltages[n];
      for (const e of c.elements) {
        let i;
        if (e.type === 'resistor') { i = (V(e.a) - V(e.b)) / Math.max(e.ohms, 1e-6); add(e.a, -i); add(e.b, i); }
        else if (e.type === 'switch') { if (e.closed) { i = (V(e.a) - V(e.b)) / e.ohms; add(e.a, -i); add(e.b, i); } }
        else if (e.type === 'source') { i = (e.volts - V(e.node)) / Math.max(e.ohms, 1e-6); add(e.node, i); }
        else { i = ledCurrentAt(e.model, V(e.anode) - V(e.cathode)); add(e.anode, -i); add(e.cathode, i); }
      }
      for (let n = 1; n <= c.nodeCount; n++) {
        expect(Math.abs(inflow[n]), `circuit ${k} node ${n}`).toBeLessThan(1e-5 * magnitude[n] + 1e-9);
      }
    }
  });
});

describe('performance budget', () => {
  it('a 30-node ladder with LEDs solves quickly', () => {
    const els = [src('s', 1, 5, 0.2)];
    for (let i = 1; i < 30; i++) {
      els.push(res(`r${i}`, i, i + 1, 100 + i * 10));
      els.push(led(`d${i}`, i + 1, 0, ledModel(1.9 + (i % 3) * 0.3)));
    }
    const circuit = { nodeCount: 30, elements: els };
    solveDC(circuit); // warm-up
    const times = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); expect(solveDC(circuit).ok).toBe(true); times.push(performance.now() - t); }
    times.sort((a, b) => a - b);
    // generous bound so loaded CI machines do not flake; the real figure is reported in the stage report
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(50);
  });

  it('a typical LED + resistor + button board solves well under a millisecond budget of 5 ms', () => {
    const c = { nodeCount: 3, elements: [src('v', 1, 3.3, 170), sw('b', 1, 2, true), res('r', 2, 3, 330), led('d', 3, 0, red)] };
    solveDC(c);
    const t = performance.now();
    for (let i = 0; i < 100; i++) solveDC(c);
    expect((performance.now() - t) / 100).toBeLessThan(5);
  });
});

describe('LED brightness heuristic', () => {
  it('is off below 0.02 mA, full at 10 mA and above, and monotonic', () => {
    expect(ledBrightness(0)).toBe(0);
    expect(ledBrightness(-1e-3)).toBe(0);
    expect(ledBrightness(0.00001)).toBe(0);
    expect(ledBrightness(0.010)).toBe(1);
    expect(ledBrightness(0.5)).toBe(1);
    expect(ledBrightness(NaN)).toBe(0);
    let prev = 0;
    for (let a = 0.00002; a < 0.02; a *= 1.3) { const b = ledBrightness(a); expect(b).toBeGreaterThanOrEqual(prev); prev = b; }
  });

  it('reproduces the resistor sweep promised in docs/history/r3-behaviour-changes.md (red LED from a 170 ohm pad)', () => {
    const rows = [[47, 6.6, 81], [100, 5.4, 73], [220, 3.8, 62], [330, 3.0, 55], [1000, 1.3, 36],
      [4700, 0.33, 18], [10000, 0.16, 13], [1e5, 0.018, 0], [1e6, 0.0019, 0], [1e7, 0.0002, 0]];
    for (const [ohms, mA, percent] of rows) {
      const r = solveDC({ nodeCount: 3, elements: [src('v', 1, 3.3, 170), res('r', 1, 2, ohms), led('d', 2, 0, red)] });
      const i = r.elements.d.current;
      expect(i).toBeCloseTo(seriesLedCurrent(3.3, 170 + ohms, red), 6); // independent solution
      expect(i * 1000).toBeGreaterThan(mA * 0.95); expect(i * 1000).toBeLessThan(mA * 1.05);
      expect(Math.round(ledBrightness(i) * 100)).toBe(percent);
    }
  });

  it('resistance matters monotonically: bigger resistor, less current, never brighter', () => {
    let prevI = Infinity; let prevB = 1;
    for (const ohms of [10, 47, 100, 330, 1e3, 1e4, 1e5, 1e6, 1e7]) {
      const r = solveDC({ nodeCount: 3, elements: [src('v', 1, 3.3, 170), res('r', 1, 2, ohms), led('d', 2, 0, red)] });
      const i = r.elements.d.current;
      expect(i).toBeLessThan(prevI); expect(ledBrightness(i)).toBeLessThanOrEqual(prevB);
      prevI = i; prevB = ledBrightness(i);
    }
  });

  it('colour matters: a blue LED is dimmer than a red one from the same pad and resistor', () => {
    const run = (vf) => solveDC({ nodeCount: 3, elements: [src('v', 1, 3.3, 170), res('r', 1, 2, 330), led('d', 2, 0, ledModel(vf))] }).elements.d.current;
    expect(run(3.0)).toBeLessThan(run(1.9) / 2);
  });
});
