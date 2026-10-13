// worker-support.js — the two small pieces both firmware workers (worker.js for Python, worker.js for C) and the Node
// scenario host (src/scenario/host.js) need, kept in one place so they cannot drift apart.

import { VirtualClock, blockingWaitMs } from '../../clock/virtual-clock.js';

/**
 * Builds the function a worker uses to make its program's clock for a mode ('realtime' or 'fast').
 * The clock's waits end early when the main thread publishes a circuit change (so interrupts react at once),
 * and queued events are flushed to the page before the worker waits.
 *
 * @param {{batcher: {flush: Function}, pins: {board?: {wait: Function}}}} worker
 * @returns {(mode: 'realtime'|'fast') => VirtualClock}
 */
export function createClockFactory({ batcher, pins }) {
  return (mode) => new VirtualClock({
    mode,
    beforeWait: () => batcher.flush(),
    waitMs: (ms) => (pins.board ? pins.board.wait(ms) : blockingWaitMs(ms))
  });
}

/** Block this thread for good (a real reset never returns to the caller; Stop terminates the worker). */
export function blockForever() {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); } catch { /* no SharedArrayBuffer: just return */ }
}
