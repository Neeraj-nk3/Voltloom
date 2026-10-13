/**
 * circuit-engine.js — the stateful wrapper the app talks to (pure: no DOM, no workers)
 *
 * evaluateBoard() is a function of its inputs. The app additionally needs:
 *   - input-threshold memory: a pad whose voltage sits between 0.8 V and 2.0 V keeps its previous reading
 *   - a small cache, so inputs seen recently (a program toggling between a few pad states) are not re-solved
 *   - "last good" handling: if the circuit cannot be solved, the previous valid result stays on screen and
 *     the failure is reported loudly and persistently, never swallowed
 *   - warning bookkeeping: each warning is reported once when it appears and cleared when it goes away
 *
 *   const engine = createCircuitEngine();
 *   const out = engine.update({ components, wires, pads });
 *   out.result      the result to DISPLAY (the fresh one, or the last good one when out.stale)
 *   out.stale       true if the circuit could not be solved this time
 *   out.failure     the solver-failure warning when stale, else null
 *   out.warnings    every warning currently active
 *   out.added       warnings that appeared since the previous update (report these)
 *   out.cleared     warnings that disappeared (their keys)
 *   engine.reset()  forget readings, cache, last good result and warnings (Stop, project load)
 */

import { evaluateBoard } from './board-eval.js';

export const warningKey = (w) => `${w.code}|${w.subject ?? ''}`;

function signature({ components, wires, pads }, reads, options) {
  const parts = components.map((c) => `${c.id}:${c.color ?? ''}:${c.value ?? ''}:${c.unit ?? ''}:${c.isPressed ? 1 : 0}`).join(',');
  const wireText = wires.map((w) => {
    const end = (n) => (n.nodeType === 'gpio' ? `g${n.pin}` : `c${n.componentId}.${n.pin}`);
    return `${end(w.start)}-${end(w.end)}`;
  }).join(',');
  const padText = Object.keys(pads).sort((a, b) => a - b)
    .map((g) => `${g}=${pads[g].mode ?? ''}/${pads[g].level ?? ''}/${pads[g].pull ?? ''}/${pads[g].duty ?? ''}/${pads[g].driveAmps ?? ''}/${reads[g] ?? ''}`).join(',');
  return `${parts}|${wireText}|${padText}|${options}`;
}

export function createCircuitEngine(options = {}) {
  const { boardParams, limits } = options;
  const optionText = JSON.stringify([boardParams ?? null, limits ?? null]);
  let reads = {};            // gpio -> last reading (hysteresis memory)
  const cache = new Map();   // signature -> evaluateBoard() result (good or not); small LRU
  const CACHE_SIZE = 32;     // a program alternating between a few pad states keeps hitting it
  let lastGood = null;
  let active = new Map();    // warning key -> warning

  function reconcile(warnings) {
    const next = new Map(warnings.map((w) => [warningKey(w), w]));
    const added = warnings.filter((w) => !active.has(warningKey(w)));
    const cleared = [...active.keys()].filter((k) => !next.has(k));
    active = next;
    return { added, cleared };
  }

  return {
    update({ components = [], wires = [], pads = {} }) {
      const withMemory = {};
      for (const [g, pad] of Object.entries(pads)) withMemory[g] = { ...pad, previousRead: reads[g] === 1 ? 1 : 0 };
      // Pads the caller did not mention still carry their last reading
      for (const g of Object.keys(reads)) if (!(g in withMemory)) withMemory[g] = { previousRead: reads[g] };

      const sig = signature({ components, wires, pads: withMemory }, reads, optionText);
      let result = cache.get(sig);
      if (result) {
        cache.delete(sig); cache.set(sig, result);              // most recently used last
      } else {
        result = evaluateBoard({ components, wires, pads: withMemory, boardParams, limits });
        cache.set(sig, result);
        if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
      }

      if (!result.ok) {
        const failure = result.warnings[0];
        const warnings = [failure];
        const { added, cleared } = reconcile(warnings);
        return { result: lastGood, stale: true, failure, warnings, added, cleared, notes: result.notes };
      }

      lastGood = result;
      for (const [g, pad] of Object.entries(result.pads)) reads[g] = pad.read;
      const { added, cleared } = reconcile(result.warnings);
      return { result, stale: false, failure: null, warnings: result.warnings, added, cleared, notes: result.notes };
    },

    /** The last result that solved, or null. */
    lastGood: () => lastGood,

    reset() {
      reads = {};
      cache.clear();
      lastGood = null;
      active = new Map();
    }
  };
}
