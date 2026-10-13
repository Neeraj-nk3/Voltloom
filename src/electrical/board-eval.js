/**
 * board-eval.js — solve the whole board and report what the app needs (pure)
 *
 *   evaluateBoard({ components, wires, pads, boardParams?, limits? }) ->
 *   {
 *     ok,                      false if some state had no operating point (then `warnings` says so)
 *     parts:  { [id]: {current, voltage, power} }       time-averaged when pads are PWM-driven
 *     pads:   { [gpio]: { voltage, read: 0|1, floating, driven, current, outputLevel } }
 *                  driven = the pad's net reaches ground, a rail or an output pad (otherwise only its own pull holds it)
 *     warnings: [{code, severity, subject, value, limit, message}]   most severe first
 *     notes: [string], solves: number
 *   }
 *
 * PWM: a pad with 0 < duty < 1 is solved once with the pin high and once low and the results are
 * weighted by duty (exact for resistor/LED/switch networks; DC model, no capacitors). With several PWM pads
 * every combination is solved assuming INDEPENDENT phases, for up to MAX_PWM_PADS pads; beyond that the
 * remaining pads are treated as constant at round(duty). Averages are used for LED and resistor warnings
 * (sustained heating), instantaneous peaks for pad and rail ratings.
 */

import { solveDC } from './solver.js';
import { analyze, resolveLimits } from './limits.js';
import { resolveBoardParams } from './board-params.js';
import { buildNetlist, normalizePad } from './netlist.js';

export const MAX_PWM_PADS = 3;

/** Input threshold with hysteresis: >= high reads 1, <= low reads 0, in between keeps the previous value. */
export function readLevel(volts, previous, params) {
  if (volts >= params.readHighVolts) return 1;
  if (volts <= params.readLowVolts) return 0;
  return previous === 1 ? 1 : 0;
}

const AVERAGE_CODES = new Set(['led-overcurrent', 'led-destroyed', 'resistor-power', 'group-overload']);
const PEAK_CODES = new Set(['source-overload', 'source-short', 'source-over-max']);

function failure(code, message, notes = []) {
  return { ok: false, parts: {}, pads: {}, notes, solves: 0,
    warnings: [{ code, severity: 'error', subject: null, value: null, limit: null, message }] };
}

export function evaluateBoard(spec) {
  const params = resolveBoardParams(spec.boardParams);
  const limits = resolveLimits(spec.limits);
  const { components = [], wires = [], pads = {} } = spec;

  // Which pads are PWM-driven (outputs with 0 < duty < 1)?
  const pwmGpios = [];
  for (const [g, partial] of Object.entries(pads)) {
    const pad = normalizePad(partial, params);
    if (pad.mode === 'output' && pad.duty !== null && pad.duty > 0 && pad.duty < 1) pwmGpios.push(Number(g));
  }
  pwmGpios.sort((a, b) => a - b);
  const exact = pwmGpios.slice(0, MAX_PWM_PADS);
  const approximated = pwmGpios.slice(MAX_PWM_PADS);

  // Enumerate states: each exact PWM pad high/low with its probability.
  let states = [{ levels: {}, weight: 1 }];
  for (const g of exact) {
    const duty = normalizePad(pads[g], params).duty;
    states = states.flatMap((s) => [
      { levels: { ...s.levels, [g]: 1 }, weight: s.weight * duty },
      { levels: { ...s.levels, [g]: 0 }, weight: s.weight * (1 - duty) }
    ]);
  }
  states = states.filter((s) => s.weight > 0);

  const notes = [];
  if (approximated.length) notes.push(`PWM on ${approximated.map((g) => `GP${g}`).join(', ')} is approximated as constant (more than ${MAX_PWM_PADS} PWM pads)`);

  const solved = [];
  let circuit0 = null; let meta0 = null;
  for (const state of states) {
    const { circuit, meta } = buildNetlist({ components, wires, pads, params, padLevels: state.levels });
    let result;
    try { result = solveDC(circuit); } catch (e) {
      if (e instanceof RangeError) return failure('too-large', 'This circuit is too large to simulate.', meta.notes);
      throw e;
    }
    if (!result.ok) return failure('unsolvable', 'This circuit could not be solved; showing the last valid state.', meta.notes);
    solved.push({ state, circuit, meta, result });
    if (!circuit0) { circuit0 = circuit; meta0 = meta; }
  }
  notes.push(...meta0.notes);

  // Weighted averages of every element and node voltage.
  const parts = {};
  const averagedResult = { ok: true, elements: {} };
  for (const e of circuit0.elements) {
    let current = 0; let voltage = 0; let power = 0;
    for (const s of solved) {
      const r = s.result.elements[e.id];
      current += s.state.weight * r.current; voltage += s.state.weight * r.voltage; power += s.state.weight * r.power;
    }
    averagedResult.elements[e.id] = { current, voltage, power };
    if (!e.id.startsWith('rail:') && !e.id.startsWith('pad:') && !e.id.startsWith('pull:')) parts[e.id] = { current, voltage, power };
  }

  // Warnings: sustained quantities from the average, ratings from each instantaneous state (worst value kept).
  const warnings = analyze(circuit0, averagedResult, limits).filter((w) => AVERAGE_CODES.has(w.code));
  const peaks = new Map();
  for (const s of solved) {
    for (const w of analyze(s.circuit, s.result, limits)) {
      if (!PEAK_CODES.has(w.code)) continue;
      const prev = peaks.get(w.subject);
      if (!prev || w.value > prev.value) peaks.set(w.subject, w);
    }
  }
  warnings.push(...peaks.values());

  // Contention: opposite fixed levels on one wire-merged net, when at least one side is a GPIO pad.
  const seen = new Set();
  for (const s of solved) {
    for (const members of s.meta.netMembers.values()) {
      if (!members.highs.length || !members.lows.length) continue;
      const gpioSide = [...members.highs, ...members.lows].some((l) => /^GP\d+$/.test(l));
      if (!gpioSide) continue; // pure rail-to-GND shorts are reported as source overloads
      const hi = members.highs[0]; const lo = members.lows[0];
      const message = /^GP\d+$/.test(hi) && /^GP\d+$/.test(lo)
        ? `${hi} and ${lo} drive the same net to opposite levels.`
        : /^GP\d+$/.test(hi) ? `${hi} drives high but is connected to ${lo}.` : `${lo} drives low but is connected to ${hi}.`;
      if (!seen.has(message)) {
        seen.add(message);
        warnings.push({ code: 'contention', severity: 'error', subject: /^GP\d+$/.test(hi) ? hi : lo, value: null, limit: null, message });
      }
    }
  }

  const rank = { error: 0, warning: 1 };
  warnings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  // Pad readings. With PWM on the board, `read` follows the most probable state (the input sees a toggling signal).
  const dominant = solved.reduce((best, s) => (s.state.weight > best.state.weight ? s : best), solved[0]);
  const padOut = {};
  for (const g of Object.keys(meta0.nodeOfGpio)) {
    const pad = meta0.padInfo[g];
    const node = meta0.nodeOfGpio[g];
    let voltage = 0;
    for (const s of solved) voltage += s.state.weight * s.result.voltages[node];
    const floating = pad.mode === 'input' && pad.pull === 'none' && !meta0.heldNodes.has(node);
    const read = floating ? pad.previousRead : readLevel(dominant.result.voltages[node], pad.previousRead, params);
    const driver = averagedResult.elements[`pad:GP${g}`] || averagedResult.elements[`pull:GP${g}`];
    padOut[g] = { voltage, read, floating, driven: meta0.drivenNodes.has(node), current: driver ? driver.current : 0, outputLevel: pad.mode === 'output' ? dominant.circuit.elements.find((e) => e.id === `pad:GP${g}`).volts > 0 ? 1 : 0 : null };
  }

  return { ok: true, parts, pads: padOut, warnings, notes, solves: solved.length };
}
