/**
 * virtual-clock.js — the program-owned virtual clock (pure: wall time and waiting are injected)
 *
 * A running program does not see the browser's clock. It sees this one, in microseconds since the program
 * started. Only the program moves it:
 *   - sleep_ms / time.sleep add exactly the requested time
 *   - every read of a pin or of the clock itself costs `readCostUs` (default 1 µs), so a busy-wait loop
 *     (`while (!gpio_get(0)) {}`, `while time.ticks_diff(...) < 50`) always makes progress and always ends
 *     at the same virtual time
 *
 * Two modes, the same program, the same virtual timeline:
 *   'fast'      nothing ever waits. Used by tests and the Node scenario runner: a 10 s program takes milliseconds
 *               and produces an identical trace on every run.
 *   'realtime'  the UI default. Sleeping waits until the wall clock reaches the virtual time, so you watch the
 *               program at real speed. If the program computed for a long time (the wall clock got ahead of the
 *               virtual clock) the clock jumps forward instead of replaying the backlog as a burst without sleeps.
 *
 * A sleep is not one jump. It proceeds in slices that end at the next WAKE POINT (a scripted input, a watchdog
 * deadline: anything registered with addWakeSource) or at the end of the sleep, and after every slice the
 * INTERRUPT HOOK runs. That is how a GPIO interrupt handler runs at the virtual time of its edge, in the middle of
 * the program's sleep, exactly like an interrupt on the real chip; the sleep still ends at its original time plus
 * whatever the handler itself took. In realtime mode a wait can also end early (`waitMs` returns when the main
 * thread publishes a circuit change), after which the clock follows the wall clock and the hook runs.
 *
 * Stop is never the clock's job: it is Worker.terminate(), which also ends a worker that is blocked waiting here.
 */

const DEFAULT_MAX_LAG_US = 250_000;     // beyond this much wall-clock lag, realtime mode resynchronises
const WALL_RESOLUTION_US = 1;           // a wall clock this close to a target has reached it
const DEFAULT_PACE_THRESHOLD_US = 1000; // reads only wait when the virtual clock is this far ahead of the wall clock

/** Block the calling thread for `ms` milliseconds (Atomics.wait if shared memory exists, else spin). */
export function blockingWaitMs(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = performance.now() + ms;
    while (performance.now() < end) { /* spin: no SharedArrayBuffer on this page */ }
  }
}

export class VirtualClock {
  /**
   * @param {object} [options]
   * @param {'fast'|'realtime'} [options.mode]
   * @param {() => number} [options.wallNowMs]   wall clock in ms (injected for tests)
   * @param {(ms: number) => void} [options.waitMs]  blocking wait; may return early (injected for tests)
   * @param {() => void} [options.beforeWait]  called right before the thread blocks (a worker flushes its pending events)
   * @param {number} [options.readCostUs]
   * @param {number} [options.maxLagUs]
   * @param {number} [options.paceThresholdUs]
   */
  constructor({ mode = 'realtime', wallNowMs = () => performance.now(), waitMs = blockingWaitMs, beforeWait = () => {},
    readCostUs = 1, maxLagUs = DEFAULT_MAX_LAG_US, paceThresholdUs = DEFAULT_PACE_THRESHOLD_US } = {}) {
    if (mode !== 'fast' && mode !== 'realtime') throw new RangeError(`unknown clock mode "${mode}"`);
    this.mode = mode;
    this.wallNowMs = wallNowMs;
    this.waitMs = waitMs;
    this.beforeWait = beforeWait;
    this.readCostUs = readCostUs;
    this.maxLagUs = maxLagUs;
    this.paceThresholdUs = paceThresholdUs;
    this.virtualUs = 0;
    this.startWallMs = wallNowMs();
    this.listeners = [];
    this.wakeSources = [];
    this.interruptHook = null;
    this.inHook = false;
  }

  /** The current virtual time in µs. Free: does not advance the clock. */
  nowUs() { return this.virtualUs; }

  /** Call `listener(fromUs, toUs)` every time the clock advances, before the program resumes. */
  onAdvance(listener) { this.listeners.push(listener); }

  /** Register `source()` -> the next absolute virtual time (µs) something must happen, or Infinity. Sleeps stop there. */
  addWakeSource(source) { this.wakeSources.push(source); }

  /** `hook()` runs after every slice of a sleep and after every read (not re-entrantly). It may itself sleep and read. */
  setInterruptHook(hook) { this.interruptHook = hook; }

  /** A read of a pin or of the clock: costs `readCostUs`. Returns the new time. */
  tick() {
    this.#resync();
    this.#moveTo(this.virtualUs + this.readCostUs);
    if (this.mode === 'realtime') this.#pace(this.paceThresholdUs);
    this.#interrupt();
    return this.virtualUs;
  }

  /** Sleep: advance by exactly `us` (non-finite or negative counts as 0). In realtime mode, wait for the wall clock. */
  sleepUs(us) {
    const amount = Number.isFinite(us) && us > 0 ? us : 0;
    this.#resync();
    const target = this.virtualUs + amount;
    if (amount === 0) { this.#moveTo(target); this.#interrupt(); return this.virtualUs; }

    while (this.virtualUs < target) {
      const stop = Math.min(target, this.#nextWake());
      if (this.mode === 'fast') {
        this.#moveTo(stop);
      } else {
        this.#sleepSliceRealtime(stop);
      }
      this.#interrupt();
    }
    return this.virtualUs;
  }

  #wallElapsedUs() { return (this.wallNowMs() - this.startWallMs) * 1000; }

  #nextWake() {
    let next = Infinity;
    for (const source of this.wakeSources) {
      const t = source();
      if (t > this.virtualUs && t < next) next = t;
    }
    return next;
  }

  /** Realtime: bring the virtual clock to `stop` (<= the sleep target), waiting for the wall clock, but wake early on a notify. */
  #sleepSliceRealtime(stop) {
    const wall = this.#wallElapsedUs();
    if (wall >= stop - WALL_RESOLUTION_US) { this.#moveTo(stop); return; }
    this.beforeWait();
    this.waitMs((stop - wall) / 1000);
    const after = this.#wallElapsedUs();
    // Virtual time follows the wall clock inside a sleep (so an interrupt that woke us up runs "now"), never past the stop.
    // Within one microsecond of the stop counts as arrived: wall clocks are not that precise, and chasing the last
    // fraction of a microsecond would loop forever.
    const arrived = after >= stop - WALL_RESOLUTION_US;
    this.#moveTo(arrived ? stop : Math.min(stop, Math.max(this.virtualUs, after)));
  }

  #resync() {
    if (this.mode !== 'realtime') return;
    const lag = this.#wallElapsedUs() - this.virtualUs;
    if (lag > this.maxLagUs) this.virtualUs += lag;       // skip the backlog; the program computed for a long time
  }

  #moveTo(toUs) {
    const from = this.virtualUs;
    this.virtualUs = toUs;
    for (const listener of this.listeners) listener(from, toUs);
  }

  #pace(thresholdUs) {
    for (let guard = 0; guard < 1000; guard++) {
      const ahead = this.virtualUs - this.#wallElapsedUs();
      if (ahead <= thresholdUs) return;
      this.beforeWait();
      this.waitMs(ahead / 1000);
    }
  }

  #interrupt() {
    if (!this.interruptHook || this.inHook) return;
    this.inHook = true;
    try { this.interruptHook(); } finally { this.inHook = false; }
  }
}
