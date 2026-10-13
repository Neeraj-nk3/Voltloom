/**
 * board-runtime.js — the electrical model inside a firmware worker (no DOM)
 *
 * Both workers (MicroPython and C) create one of these and give it to their WorkerPins. A GPIO input read
 * then asks the circuit solver, so the answer depends only on what the PROGRAM has done (pull settings,
 * outputs, PWM) and on the circuit the user built, never on how quickly the main thread reacted. That is what
 * makes reads identical in Python and C, and repeatable.
 *
 *   - The circuit (parts, wires, pressed buttons) arrives through a shared-memory channel
 *     (circuit-channel.js), so edits and button presses reach a worker that is busy in a loop.
 *   - Solving is lazy: it happens on a read, and only when something changed since the last solve
 *     (a pad state revision in WorkerPins, or a new circuit snapshot).
 *   - If the circuit cannot be solved, the last good answer is kept, and when there is none, readInput()
 *     returns null so WorkerPins falls back to the main thread's drive. The main thread reports the failure.
 */

import { createCircuitEngine } from '../../electrical/circuit-engine.js';
import { CircuitReader } from '../../electrical/circuit-channel.js';
import { blockingWaitMs } from '../../clock/virtual-clock.js';

export class WorkerBoard {
  /** @param {SharedArrayBuffer|null} circuitBuffer  where the main thread publishes the circuit */
  constructor(circuitBuffer, engineOptions = {}) {
    this.reader = circuitBuffer ? new CircuitReader(circuitBuffer) : null;
    this.engine = createCircuitEngine(engineOptions);
    this.circuit = { components: [], wires: [] };
    this.circuitVersion = 0;       // bumped when a new snapshot arrives
    this.solvedCircuitVersion = -1;
    this.solvedRevision = -1;
    this.result = null;            // last good result
    this.solves = 0;               // how many real solver runs (cache hits included), for tests
  }

  /** Replace the circuit directly (tests, or a host without shared memory). */
  setCircuit(snapshot) {
    this.circuit = snapshot;
    this.circuitVersion++;
  }

  /**
   * The reading (0 or 1) of an input pad, or null if the model has no answer (pin not on the header, or
   * nothing could be solved yet).
   * @param {number} pin   GPIO number
   * @param {{revision:number, padSnapshot:Function}} pins  the worker's pin state
   */
  readInput(pin, pins) {
    if (this.reader) {
      const snapshot = this.reader.poll();
      if (snapshot) this.setCircuit(snapshot);
    }
    if (this.solvedCircuitVersion !== this.circuitVersion || this.solvedRevision !== pins.revision) {
      this.#solve(pins);
    }
    const pad = this.result && this.result.pads[pin];
    return pad ? pad.read : null;
  }

  /**
   * Block for up to `ms`, returning early when the main thread publishes a circuit change (a button press, an
   * edit), so a sleeping program can react to it at once. Any change already published is consumed first; otherwise
   * the wait would return immediately forever.
   */
  wait(ms) {
    if (!this.reader) { blockingWaitMs(ms); return; }
    const snapshot = this.reader.poll();
    if (snapshot) this.setCircuit(snapshot);
    try {
      Atomics.wait(this.reader.header, 0, Atomics.load(this.reader.header, 0), ms);
    } catch {
      blockingWaitMs(ms);
    }
  }

  #solve(pins) {
    this.solves++;
    const out = this.engine.update({ components: this.circuit.components, wires: this.circuit.wires, pads: pins.padSnapshot() });
    this.solvedCircuitVersion = this.circuitVersion;
    this.solvedRevision = pins.revision;
    if (!out.stale && out.result) this.result = out.result;     // stale: keep the last good picture
  }
}
