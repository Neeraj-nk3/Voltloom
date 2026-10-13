/**
 * solver.js — DC operating-point solver (pure: no DOM, no workers, no globals, no I/O)
 *
 * Method: Modified Nodal Analysis. Nonlinear parts (LED diodes) are handled with Newton-Raphson,
 * using SPICE-style tolerances (vntol / reltol), the standard `pnjlim` junction-voltage limiter,
 * and two fallbacks when plain Newton fails: gmin stepping, then source stepping.
 *
 * Circuit description (all numbers SI: volts, ohms, amps):
 *   {
 *     nodeCount: N,                 // nodes are 0..N; node 0 is ground (0 V)
 *     elements: [
 *       { type: 'resistor', id, a, b, ohms },
 *       { type: 'source',   id, node, volts, ohms },      // ideal volts behind `ohms` from node to ground
 *       { type: 'switch',   id, a, b, closed, ohms },     // closed = `ohms` contact, open = nothing
 *       { type: 'led',      id, anode, cathode, model }   // model from led-model.js (ledModel())
 *     ]
 *   }
 * Wires are NOT elements: the caller merges wired pins into one node (see the netlist builder).
 *
 * Result:
 *   { ok, method, iterations, voltages: Float64Array(N+1), elements: { id: {current, voltage, power} } }
 *   - voltage = V(a)-V(b)   (source: V(node)),   current flows a->b  (led: anode->cathode;
 *     source: positive when it SOURCES current into the circuit),   power = dissipated (source: delivered).
 *   - ok=false means no operating point was found; voltages/elements then describe nothing useful.
 *
 * Limits of the model (documented in the README): DC only (no capacitors, inductors, transients);
 * ideal wires; dense O(n^3) elimination, intended for tens of nodes (MAX_NODES).
 */

const THERMAL_VOLTAGE = 0.025852; // kT/q at 300 K
const GMIN = 1e-12;               // siemens to ground on every node: floating nodes stay solvable
const MIN_OHMS = 1e-6;            // a "0 ohm" part is treated as 1 micro-ohm
const MAX_EXPONENT = 120;         // exp() argument clamp, keeps diode math finite
export const MAX_NODES = 256;

export const DEFAULT_TOLERANCES = Object.freeze({ maxIterations: 200, vntol: 1e-6, reltol: 1e-5 });

function assertFinite(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${what} must be a finite number (got ${value})`);
}

function validate(circuit) {
  if (!circuit || typeof circuit !== 'object') throw new TypeError('circuit must be an object');
  const { nodeCount, elements } = circuit;
  if (!Number.isInteger(nodeCount) || nodeCount < 0) throw new RangeError('nodeCount must be a non-negative integer');
  if (nodeCount > MAX_NODES) throw new RangeError(`nodeCount ${nodeCount} exceeds the supported maximum of ${MAX_NODES}`);
  if (!Array.isArray(elements)) throw new TypeError('elements must be an array');

  const seen = new Set();
  const node = (n, where) => {
    if (!Number.isInteger(n) || n < 0 || n > nodeCount) throw new RangeError(`${where}: node ${n} is outside 0..${nodeCount}`);
  };
  for (const e of elements) {
    if (!e || typeof e.id !== 'string' || e.id === '') throw new TypeError('every element needs a non-empty string id');
    if (seen.has(e.id)) throw new RangeError(`duplicate element id "${e.id}"`);
    seen.add(e.id);
    const where = `element "${e.id}"`;
    switch (e.type) {
      case 'resistor':
        node(e.a, where); node(e.b, where);
        assertFinite(e.ohms, `${where} ohms`);
        if (e.ohms < 0) throw new RangeError(`${where}: ohms must not be negative`);
        break;
      case 'source':
        node(e.node, where);
        assertFinite(e.volts, `${where} volts`); assertFinite(e.ohms, `${where} ohms`);
        if (e.ohms < 0) throw new RangeError(`${where}: ohms must not be negative`);
        break;
      case 'switch':
        node(e.a, where); node(e.b, where);
        assertFinite(e.ohms, `${where} ohms`);
        if (e.ohms < 0) throw new RangeError(`${where}: ohms must not be negative`);
        if (typeof e.closed !== 'boolean') throw new TypeError(`${where}: closed must be a boolean`);
        break;
      case 'led':
        node(e.anode, where); node(e.cathode, where);
        if (!e.model) throw new TypeError(`${where}: model is required`);
        for (const k of ['is', 'nVt', 'rs']) assertFinite(e.model[k], `${where} model.${k}`);
        if (!(e.model.is > 0) || !(e.model.nVt > 0) || e.model.rs < 0) throw new RangeError(`${where}: invalid LED model`);
        break;
      default:
        throw new TypeError(`${where}: unknown element type "${e.type}"`);
    }
  }
}

/** SPICE pnjlim: limits how far a junction voltage may move in one Newton step. */
function pnjlim(vnew, vold, nVt, vcrit) {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * nVt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / nVt;
      return arg > 0 ? vold + nVt * Math.log(arg) : vcrit;
    }
    return nVt * Math.log(vnew / nVt);
  }
  return vnew;
}

/** Solve A x = z in place by Gaussian elimination with partial pivoting; null if singular. */
function gauss(A, z) {
  const m = z.length;
  for (let c = 0; c < m; c++) {
    let p = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-300) return null;
    if (p !== c) { [A[c], A[p]] = [A[p], A[c]]; [z[c], z[p]] = [z[p], z[c]]; }
    for (let r = c + 1; r < m; r++) {
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k < m; k++) A[r][k] -= f * A[c][k];
      z[r] -= f * z[c];
    }
  }
  const x = new Float64Array(m);
  for (let r = m - 1; r >= 0; r--) {
    let s = z[r];
    for (let k = r + 1; k < m; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

export function solveDC(circuit, tolerances = {}) {
  validate(circuit);
  const { maxIterations, vntol, reltol } = { ...DEFAULT_TOLERANCES, ...tolerances };

  // Expand LEDs into (series resistance) + (diode) with one internal node each. Input is never mutated.
  let nextNode = circuit.nodeCount + 1;
  const parts = [];
  for (const e of circuit.elements) {
    if (e.type === 'led') {
      const inner = nextNode++;
      parts.push({ kind: 'res', a: e.anode, b: inner, g: 1 / Math.max(e.model.rs, MIN_OHMS) });
      parts.push({ kind: 'diode', id: e.id, a: inner, b: e.cathode, is: e.model.is, nVt: e.model.nVt,
        vcrit: e.model.nVt * Math.log(e.model.nVt / (Math.SQRT2 * e.model.is)), vd: 0, vdNext: 0 });
    } else if (e.type === 'resistor') {
      parts.push({ kind: 'res', a: e.a, b: e.b, g: 1 / Math.max(e.ohms, MIN_OHMS) });
    } else if (e.type === 'switch') {
      if (e.closed) parts.push({ kind: 'res', a: e.a, b: e.b, g: 1 / Math.max(e.ohms, MIN_OHMS) });
    } else {
      parts.push({ kind: 'src', node: e.node, volts: e.volts, g: 1 / Math.max(e.ohms, MIN_OHMS) });
    }
  }
  const diodes = parts.filter((p) => p.kind === 'diode');
  const size = nextNode - 1; // unknowns are nodes 1..size
  let v = new Float64Array(size + 1);

  const build = (scale, gextra) => {
    const A = Array.from({ length: size }, () => new Float64Array(size));
    const z = new Float64Array(size);
    for (let i = 0; i < size; i++) A[i][i] += GMIN + gextra;
    const stampG = (a, b, g) => {
      if (a > 0) A[a - 1][a - 1] += g;
      if (b > 0) A[b - 1][b - 1] += g;
      if (a > 0 && b > 0) { A[a - 1][b - 1] -= g; A[b - 1][a - 1] -= g; }
    };
    for (const p of parts) {
      if (p.kind === 'res') stampG(p.a, p.b, p.g);
      else if (p.kind === 'src') {
        if (p.node > 0) { A[p.node - 1][p.node - 1] += p.g; z[p.node - 1] += p.g * p.volts * scale; }
      } else {
        const ex = Math.exp(Math.min(p.vd / p.nVt, MAX_EXPONENT));
        const gd = (p.is / p.nVt) * ex + GMIN;
        const ieq = p.is * (ex - 1) - gd * p.vd; // companion current source, flows a -> b
        stampG(p.a, p.b, gd);
        if (p.a > 0) z[p.a - 1] -= ieq;
        if (p.b > 0) z[p.b - 1] += ieq;
      }
    }
    return { A, z };
  };

  const newton = (scale, gextra = 0) => {
    for (let iter = 0; iter < maxIterations; iter++) {
      const { A, z } = build(scale, gextra);
      const x = gauss(A, z);
      if (!x) return { ok: false, iterations: iter };
      const vnew = new Float64Array(size + 1);
      for (let i = 0; i < size; i++) vnew[i + 1] = x[i];

      let limited = false;
      let worst = 0;
      for (const d of diodes) {
        const want = vnew[d.a] - vnew[d.b];
        const lim = pnjlim(want, d.vd, d.nVt, d.vcrit);
        if (Math.abs(lim - want) > 1e-12) limited = true;
        worst = Math.max(worst, Math.abs(want - d.vd));
        d.vdNext = lim;
      }
      for (let i = 1; i <= size; i++) worst = Math.max(worst, Math.abs(vnew[i] - v[i]) - reltol * Math.abs(vnew[i]));
      for (const d of diodes) d.vd = d.vdNext;
      v = vnew;
      if (worst < vntol && !limited) return { ok: true, iterations: iter + 1 };
    }
    return { ok: false, iterations: maxIterations };
  };

  const restart = () => { for (const d of diodes) d.vd = 0; v = new Float64Array(size + 1); };
  const ladder = (steps, run) => { restart(); for (const s of steps) { if (!run(s).ok) return false; } return true; };

  let method = 'newton';
  let result = newton(1);
  if (!result.ok && ladder([1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-8, 1e-10, 0], (g) => newton(1, g))) {
    result = { ok: true, iterations: -1 }; method = 'gmin-stepping';
  }
  if (!result.ok && ladder([0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1], (s) => newton(s))) {
    result = { ok: true, iterations: -1 }; method = 'source-stepping';
  }
  if (!result.ok) method = 'failed';

  const volt = (n) => (n > 0 ? v[n] : 0);
  const out = {};
  for (const e of circuit.elements) {
    let current; let voltage;
    if (e.type === 'resistor') {
      voltage = volt(e.a) - volt(e.b); current = voltage / Math.max(e.ohms, MIN_OHMS);
    } else if (e.type === 'switch') {
      voltage = volt(e.a) - volt(e.b); current = e.closed ? voltage / Math.max(e.ohms, MIN_OHMS) : 0;
    } else if (e.type === 'source') {
      voltage = volt(e.node); current = (e.volts - voltage) / Math.max(e.ohms, MIN_OHMS);
    } else {
      const d = diodes.find((p) => p.id === e.id);
      voltage = volt(e.anode) - volt(e.cathode);
      current = d.is * (Math.exp(Math.min(d.vd / d.nVt, MAX_EXPONENT)) - 1);
    }
    out[e.id] = { current, voltage, power: voltage * current };
  }
  return { ok: result.ok, method, iterations: result.iterations, voltages: v.slice(0, circuit.nodeCount + 1), elements: out };
}
