/**
 * irq.js — GPIO interrupt bookkeeping for one firmware worker (pure)
 *
 * Values are the Pico SDK's (hardware/gpio.h: enum gpio_irq_level) and MicroPython's (Pin.IRQ_*):
 *     LEVEL_LOW 0x1   LEVEL_HIGH 0x2   EDGE_FALL 0x4   EDGE_RISE 0x8
 *
 * The controller watches the level of every pin that has an interrupt enabled. `collect()` compares each such pin
 * with the level it had last time and reports one entry per pin with the events that happened, matched against the
 * pin's enabled mask. The worker calls it at every point where virtual time passes or pin state changes, and
 * delivers the result to the program's handler (C callback, Python function) there.
 *
 * Simplifications, on purpose:
 *   - Edges are detected by comparing levels at those points, so a pulse shorter than the gap between two such
 *     points is not seen. A program's own writes and reads, every clock advance and every scripted or published
 *     circuit change are such points; between two of them nothing can change a pin.
 *   - Level interrupts (LEVEL_LOW / LEVEL_HIGH) are reported once when the condition becomes true (or when enabled
 *     while true), not repeatedly for as long as it holds.
 *   - One report per pin per collection, with all matching events OR-ed (as the real status register would hold).
 */

export const IRQ = Object.freeze({ LEVEL_LOW: 0x1, LEVEL_HIGH: 0x2, EDGE_FALL: 0x4, EDGE_RISE: 0x8 });
const ALL = IRQ.LEVEL_LOW | IRQ.LEVEL_HIGH | IRQ.EDGE_FALL | IRQ.EDGE_RISE;

export class IrqController {
  /** @param {(pin: number) => 0|1} levelOf  the pin's current level, with no side effects on the clock */
  constructor(levelOf) {
    this.levelOf = levelOf;
    this.pins = new Map();          // pin -> { mask, last, highReported, lowReported }
  }

  anyEnabled() { return this.pins.size > 0; }

  maskOf(pin) { return this.pins.has(pin) ? this.pins.get(pin).mask : 0; }

  /** SDK gpio_set_irq_enabled(): add (enabled) or remove (!enabled) event bits. */
  enable(pin, mask, enabled) {
    const bits = mask & ALL;
    this.setMask(pin, enabled ? this.maskOf(pin) | bits : this.maskOf(pin) & ~bits);
  }

  /** MicroPython Pin.irq(trigger=...): replace the whole mask (0 disables). */
  setMask(pin, mask) {
    const next = mask & ALL;
    if (next === 0) { this.pins.delete(pin); return; }
    const existing = this.pins.get(pin);
    if (existing) {
      // Newly enabled level conditions that already hold are reported once, as if the pin had just reached them.
      if ((next & IRQ.LEVEL_HIGH) && !(existing.mask & IRQ.LEVEL_HIGH)) existing.highReported = false;
      if ((next & IRQ.LEVEL_LOW) && !(existing.mask & IRQ.LEVEL_LOW)) existing.lowReported = false;
      existing.mask = next;
      return;
    }
    const level = this.levelOf(pin);
    this.pins.set(pin, { mask: next, last: level, highReported: false, lowReported: false, pending: 0 });
  }

  /** Events that happened since the last call, for pins that asked for them, in ascending pin order. */
  collect() {
    this.latch();
    return this.takePending();
  }

  /**
   * Look at every pin now and remember what happened, without handing it out. The CPU-side interrupt mask
   * (machine.disable_irq()) holds delivery back, but the chip still latches edges: so does this.
   */
  latch() {
    const pins = [...this.pins.keys()].sort((a, b) => a - b);
    for (const pin of pins) {
      const state = this.pins.get(pin);
      if (!state) continue;
      const level = this.levelOf(pin);
      let events = 0;
      if (level !== state.last) { events |= level ? IRQ.EDGE_RISE : IRQ.EDGE_FALL; state.last = level; }
      if (level === 1) {
        state.lowReported = false;
        if (!state.highReported) { state.highReported = true; events |= IRQ.LEVEL_HIGH; }
      } else {
        state.highReported = false;
        if (!state.lowReported) { state.lowReported = true; events |= IRQ.LEVEL_LOW; }
      }
      state.pending |= events & state.mask;
    }
  }

  /** The latched events per pin (ascending pin order); clears them. */
  takePending() {
    const out = [];
    for (const pin of [...this.pins.keys()].sort((a, b) => a - b)) {
      const state = this.pins.get(pin);
      if (state && state.pending) { out.push({ pin, events: state.pending }); state.pending = 0; }
    }
    return out;
  }
}
