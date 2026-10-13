import { describe, it, expect, beforeEach } from 'vitest';
import { syncWires } from '../../../src/circuit/wire-registry.js';
import { analyzeGpioNet, analyzeNet, netDrive, checkConnection } from '../../support/legacy-connectivity.js';
import { evaluateBoard } from '../../../src/electrical/board-eval.js';
import { ledBrightness } from '../../../src/electrical/led-model.js';

// Differential check: the new electrical engine against the existing connectivity logic
// (tests/support/legacy-connectivity.js) on thousands of random circuits.
//
// Rule of the test: wherever the two models are MEANT to agree, they must agree exactly. Where they are
// meant to differ, the difference must fall inside a hazard class defined using only the OLD logic's own
// answers (a rail-to-ground short, a GPIO driven low in the LED's net, ...). A mismatch outside every
// documented class fails the test.

const P = { GND: 3, V3V3: 36, VBUS: 40, VSYS: 39, GP0: 1, GP1: 2, GP2: 4, GP14: 19, GP15: 20, GP16: 21, EN3V3: 37, ADC_VREF: 35, RUN: 30 };
const pinNode = (physical) => ({ nodeType: 'gpio', pin: physical });
const partNode = (componentId, pin) => ({ nodeType: 'component_pin', componentId, pin });

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const choice = (rand, list) => list[Math.floor(rand() * list.length)];

function randomTopology(rand, { pins, withLed }) {
  const components = [];
  const nRes = Math.floor(rand() * 4);
  for (let i = 0; i < nRes; i++) components.push({ id: `res_${i}`, value: choice(rand, [100, 330, 1000]), unit: 1 });
  const nBtn = Math.floor(rand() * 3);
  for (let i = 0; i < nBtn; i++) components.push({ id: `btn_${i}`, isPressed: rand() < 0.5 });
  if (withLed) components.push({ id: 'led_0', color: '#ef4444' });

  const ends = pins.map(pinNode);
  for (const c of components) {
    const names = c.id.startsWith('res') ? ['1', '2'] : c.id.startsWith('btn') ? ['1', '2', '3', '4'] : ['A', 'C'];
    for (const n of names) ends.push(partNode(c.id, n));
  }
  const wires = [];
  const count = 2 + Math.floor(rand() * 7);
  for (let i = 0; i < count; i++) {
    const a = choice(rand, ends); let b = choice(rand, ends);
    if (b === a) b = choice(rand, ends);
    if (a !== b) wires.push({ id: `w${i}`, start: a, end: b });
  }
  return { components, wires };
}

describe('input pin level: old netDrive vs new pad read', () => {
  const pins = [P.GND, P.GND, P.V3V3, P.VBUS, P.VSYS, P.GP0, P.GP0, P.GP1, P.GP2];

  it('4000 random circuits: exact agreement unless the old logic says the net touches BOTH ground and a rail', () => {
    const rand = rng(777);
    const tally = { agree: 0, shortDiffer: 0, old0: 0, old1: 0, oldNull: 0 };
    for (let k = 0; k < 4000; k++) {
      const { components, wires } = randomTopology(rand, { pins, withLed: false });
      const pull = rand() < 0.5 ? 'down' : 'up';
      syncWires(wires);
      const net = analyzeGpioNet(0, components);
      const oldDrive = netDrive(net);
      const oldLevel = oldDrive === null ? (pull === 'up' ? 1 : 0) : oldDrive; // old: an undriven pin keeps its own pull
      const r = evaluateBoard({ components, wires, pads: { 0: { pull } } });
      expect(r.ok, `case ${k}`).toBe(true);
      const newLevel = r.pads[0].read;

      tally[oldDrive === 0 ? 'old0' : oldDrive === 1 ? 'old1' : 'oldNull']++;
      if (newLevel === oldLevel) { tally.agree++; continue; }
      // sanctioned differences: (1) the old logic let "ground win" on a net that also reaches a rail;
      // (2) it ignored the pulls of OTHER pads sharing an undriven net (they now fight through 65 kohm each)
      const explained = (net.isGrounded && net.hasPower) || (oldDrive === null && net.gpios.length > 1);
      expect(explained, `case ${k}: unexplained difference old=${oldLevel} new=${newLevel} net=${JSON.stringify(net)}`).toBe(true);
      tally.shortDiffer++;
    }
    // the corpus really exercised every outcome
    expect(tally.old0).toBeGreaterThan(300);
    expect(tally.old1).toBeGreaterThan(300);
    expect(tally.oldNull).toBeGreaterThan(300);
    expect(tally.agree).toBeGreaterThan(3500);
    console.log('input-level differential', tally);
  }, 60_000);

  it('documented difference B7: 3V3_EN and ADC_VREF were sources in the old logic, are not now; RUN never was', () => {
    for (const [p, oldExpected] of [[P.EN3V3, 1], [P.ADC_VREF, 1], [P.RUN, null]]) {
      const wires = [{ id: 'w', start: pinNode(p), end: pinNode(P.GP0) }];
      syncWires(wires);
      expect(netDrive(analyzeGpioNet(0, []))).toBe(oldExpected);
      expect(evaluateBoard({ wires }).pads[0].read).toBe(0);
    }
  });

  it('documented difference B4/B9: a large resistor to a rail read as a hard 1 before; now the divider decides', () => {
    const components = [{ id: 'res_1', value: 1, unit: 1000000 }];
    const wires = [{ id: 'a', start: pinNode(P.V3V3), end: partNode('res_1', '1') }, { id: 'b', start: partNode('res_1', '2'), end: pinNode(P.GP0) }];
    syncWires(wires);
    expect(netDrive(analyzeGpioNet(0, components))).toBe(1);
    const r = evaluateBoard({ components, wires });
    expect(r.pads[0].voltage).toBeLessThan(0.25); // 1 Mohm against the 65 kohm pull-down: 0.2 V
    expect(r.pads[0].read).toBe(0);
  });
});

describe('LED lit: old checkConnection(A: Power, C: Ground) vs new current', () => {
  const pins = [P.GND, P.GND, P.V3V3, P.VBUS, P.VSYS, P.GP14, P.GP15, P.GP16];
  const gpioOfPin = { [P.GP14]: 14, [P.GP15]: 15, [P.GP16]: 16 };

  it('12000 random circuits: exact agreement outside the documented hazard classes', () => {
    const rand = rng(4242);
    const tally = { agree: 0, hazardDiffer: 0, oldLit: 0, oldDark: 0, hazard: 0 };
    for (let k = 0; k < 12000; k++) {
      const { components, wires } = randomTopology(rand, { pins, withLed: true });
      const pads = {};
      for (const g of [14, 15, 16]) pads[g] = rand() < 0.6 ? { mode: 'output', level: rand() < 0.5 ? 1 : 0 } : {};
      const isOutputHigh = (g) => !!pads[g] && pads[g].mode === 'output' && pads[g].level === 1;

      syncWires(wires);
      const oldLit = checkConnection('led_0', 'A', 'Power', components, isOutputHigh, true) && checkConnection('led_0', 'C', 'Ground', components, isOutputHigh, true);
      const r = evaluateBoard({ components, wires, pads });
      expect(r.ok, `case ${k}`).toBe(true);
      const newLit = ledBrightness(r.parts.led_0.current) > 0;
      tally[oldLit ? 'oldLit' : 'oldDark']++;

      // Hazard classes, defined with the OLD analysis only:
      const A = analyzeNet('led_0', 'A', components);
      const C = analyzeNet('led_0', 'C', components);
      const isLow = (g) => !!pads[g] && pads[g].mode === 'output' && pads[g].level === 0;
      const isHigh = (g) => isOutputHigh(g);
      const netHasLow = (n) => n.isGrounded || n.gpios.some(isLow);
      const netHasHigh = (n) => n.hasPower || n.gpios.some(isHigh);
      const hazard =
        (netHasHigh(A) && netHasLow(A)) ||            // anode net is shorted / contended
        (netHasHigh(C) && netHasLow(C)) ||            // cathode net is shorted / contended
        (A.gpios.some(isLow) || C.gpios.some(isLow)) || // a GPIO driven low sinks current now (B3); the old logic ignored it
        C.gpios.some((g) => !(pads[g] && pads[g].mode === 'output')) || // an input pad's pull-down is a (65 kohm) path to ground
        netHasHigh(C);                                // cathode on a rail/high pad: rails differ (5 V vs 3.3 V), so current flows
      if (hazard) tally.hazard++;

      if (newLit === oldLit) { tally.agree++; continue; }
      expect(hazard, `case ${k}: unexplained difference old=${oldLit} new=${newLit} A=${JSON.stringify(A)} C=${JSON.stringify(C)}`).toBe(true);
      tally.hazardDiffer++;
    }
    expect(tally.oldLit).toBeGreaterThan(500);
    expect(tally.oldDark).toBeGreaterThan(500);
    expect(tally.agree).toBeGreaterThan(9000);
    expect(tally.hazardDiffer).toBeLessThan(1500);
    console.log('LED-lit differential', tally);
  }, 60_000);

  it('documented differences, each pinned down on its own', () => {
    const led = { id: 'led_0', color: '#ef4444' };
    const wire = (a, b) => ({ id: `${Math.random()}`, start: a, end: b });
    const run = (components, wires, pads = {}) => {
      syncWires(wires);
      const isOutputHigh = (g) => !!pads[g] && pads[g].level === 1;
      const oldLit = checkConnection('led_0', 'A', 'Power', components, isOutputHigh, true) && checkConnection('led_0', 'C', 'Ground', components, isOutputHigh, true);
      return { oldLit, r: evaluateBoard({ components, wires, pads }) };
    };

    // B4: resistor value was ignored. 10 Mohm: old lit, new dark.
    let c = run([{ id: 'res_1', value: 10, unit: 1000000 }, led],
      [wire(pinNode(P.V3V3), partNode('res_1', '1')), wire(partNode('res_1', '2'), partNode('led_0', 'A')), wire(partNode('led_0', 'C'), pinNode(P.GND))]);
    expect(c.oldLit).toBe(true);
    expect(ledBrightness(c.r.parts.led_0.current)).toBe(0);

    // B3: a GPIO driven low is a real sink. Old: dark (cathode not on a Ground pin). New: lit.
    c = run([{ id: 'res_1', value: 330, unit: 1 }, led],
      [wire(pinNode(P.V3V3), partNode('res_1', '1')), wire(partNode('res_1', '2'), partNode('led_0', 'A')), wire(partNode('led_0', 'C'), pinNode(P.GP14))], { 14: { mode: 'output', level: 0 } });
    expect(c.oldLit).toBe(false);
    expect(ledBrightness(c.r.parts.led_0.current)).toBeGreaterThan(0.3);

    // Short: anode wired to both a rail and GND. Old: lit. New: dark, with a short-circuit error.
    c = run([led], [wire(pinNode(P.V3V3), partNode('led_0', 'A')), wire(pinNode(P.GND), partNode('led_0', 'A')), wire(partNode('led_0', 'C'), pinNode(P.GND))]);
    expect(c.oldLit).toBe(true);
    expect(ledBrightness(c.r.parts.led_0.current)).toBe(0);
    expect(c.r.warnings.map((w) => w.code)).toContain('source-short');

    // B7: LED on 3V3_EN: old lit (it counted as Power). New: dark.
    c = run([led], [wire(pinNode(P.EN3V3), partNode('led_0', 'A')), wire(partNode('led_0', 'C'), pinNode(P.GND))]);
    expect(c.oldLit).toBe(true);
    expect(ledBrightness(c.r.parts.led_0.current)).toBe(0);

    // B2: a PWM pin was never "high" for the old logic. New: lit proportionally.
    const pwmWires = [wire(pinNode(P.GP14), partNode('res_1', '1')), wire(partNode('res_1', '2'), partNode('led_0', 'A')), wire(partNode('led_0', 'C'), pinNode(P.GND))];
    c = run([{ id: 'res_1', value: 330, unit: 1 }, led], pwmWires);
    expect(c.oldLit).toBe(false);
    const pwm = evaluateBoard({ components: [{ id: 'res_1', value: 330, unit: 1 }, led], wires: pwmWires, pads: { 14: { mode: 'output', duty: 0.5 } } });
    expect(ledBrightness(pwm.parts.led_0.current)).toBeGreaterThan(0.2);
  });
});
