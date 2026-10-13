/**
 * watchdog.js — the simulated watchdog timer (pure), driven by the program's virtual clock
 *
 * Once enabled it must be fed (watchdog_update() / WDT.feed()) before its timeout passes; if it is not, the board
 * resets: `onExpire` runs at exactly the deadline on the virtual timeline, which makes the behaviour repeatable.
 * Like the real one it cannot be switched off again once enabled.
 *
 * The RP2040 watchdog counts in microseconds up to 0xFFFFFF (about 8.4 s). Longer timeouts are clamped, which is
 * what the SDK does. [MicroPython's WDT limit of 8388 ms is the same figure.]
 */

export const WATCHDOG_MAX_MS = 8388;

export class WatchdogTimer {
  /**
   * @param {{ nowUs: () => number }} clock
   * @param {() => void} onExpire  called once, at the deadline
   */
  constructor(clock, onExpire) {
    this.clock = clock;
    this.onExpire = onExpire;
    this.enabled = false;
    this.locked = false;          // a scheduled reboot (watchdog_reboot with a delay) cannot be fed away
    this.periodUs = 0;
    this.deadlineUs = Infinity;
  }

  /** watchdog_reboot(pc, sp, delay_ms) with a delay: the board reboots after that long, whatever the program does. */
  schedule(delayMs) {
    this.enable(delayMs);
    this.locked = true;
  }

  /** watchdog_enable(delay_ms) / WDT(timeout=ms). Returns the timeout actually used, in ms. */
  enable(delayMs) {
    const ms = Number.isFinite(delayMs) && delayMs > 0 ? Math.min(delayMs, WATCHDOG_MAX_MS) : 1;
    this.enabled = true;
    this.periodUs = ms * 1000;
    this.deadlineUs = this.clock.nowUs() + this.periodUs;
    return ms;
  }

  /** watchdog_update() / WDT.feed(): restart the countdown. */
  feed() {
    if (this.enabled && !this.locked) this.deadlineUs = this.clock.nowUs() + this.periodUs;
  }

  /** For the clock: when something must happen next. */
  nextWakeUs() { return this.enabled ? this.deadlineUs : Infinity; }

  /** For the clock's onAdvance listener: expire if the deadline has been reached. */
  check(toUs) {
    if (this.enabled && toUs >= this.deadlineUs) {
      this.enabled = false;
      this.onExpire();
    }
  }

  /** Wire this timer into a clock (wake point + advance listener). */
  attachTo(clock) {
    clock.addWakeSource(() => this.nextWakeUs());
    clock.onAdvance((from, to) => this.check(to));
  }
}
