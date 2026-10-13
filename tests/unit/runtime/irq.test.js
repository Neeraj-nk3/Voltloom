import { describe, it, expect, beforeEach } from 'vitest';
import { IrqController, IRQ } from '../../../src/runtime/common/irq.js';
import { WorkerPins } from '../../../src/runtime/common/pin-model.js';
import { WorkerBoard } from '../../../src/runtime/common/board-runtime.js';
import { VirtualClock } from '../../../src/clock/virtual-clock.js';
import { PIN_DIR, PULL, EVENT } from '../../../src/worker-protocol/protocol.js';

describe('interrupt event values are the Pico SDK / MicroPython ones', () => {
  it('LEVEL_LOW 1, LEVEL_HIGH 2, EDGE_FALL 4, EDGE_RISE 8', () => {
    expect(IRQ).toEqual({ LEVEL_LOW: 1, LEVEL_HIGH: 2, EDGE_FALL: 4, EDGE_RISE: 8 });
  });
});

describe('IrqController', () => {
  let levels; let irq;
  beforeEach(() => { levels = {}; irq = new IrqController((pin) => levels[pin] ?? 0); });

  it('reports a rising and a falling edge once each, with the right event bit', () => {
    irq.setMask(3, IRQ.EDGE_RISE | IRQ.EDGE_FALL);
    expect(irq.collect()).toEqual([]);
    levels[3] = 1; expect(irq.collect()).toEqual([{ pin: 3, events: IRQ.EDGE_RISE }]);
    expect(irq.collect()).toEqual([]);                                   // nothing new
    levels[3] = 0; expect(irq.collect()).toEqual([{ pin: 3, events: IRQ.EDGE_FALL }]);
  });

  it('only the enabled edges are reported', () => {
    irq.setMask(3, IRQ.EDGE_FALL);
    levels[3] = 1; expect(irq.collect()).toEqual([]);
    levels[3] = 0; expect(irq.collect()).toEqual([{ pin: 3, events: IRQ.EDGE_FALL }]);
  });

  it('enabling baselines the current level: no edge is reported for a pin that is already high', () => {
    levels[3] = 1;
    irq.setMask(3, IRQ.EDGE_RISE | IRQ.EDGE_FALL);
    expect(irq.collect()).toEqual([]);
  });

  it('enable() adds and removes bits (SDK gpio_set_irq_enabled); setMask() replaces (MicroPython irq(trigger=))', () => {
    irq.enable(2, IRQ.EDGE_RISE, true); irq.enable(2, IRQ.EDGE_FALL, true);
    expect(irq.maskOf(2)).toBe(IRQ.EDGE_RISE | IRQ.EDGE_FALL);
    irq.enable(2, IRQ.EDGE_RISE, false);
    expect(irq.maskOf(2)).toBe(IRQ.EDGE_FALL);
    irq.setMask(2, IRQ.EDGE_RISE);
    expect(irq.maskOf(2)).toBe(IRQ.EDGE_RISE);
    irq.setMask(2, 0);
    expect(irq.anyEnabled()).toBe(false);
  });

  it('several pins are reported in ascending pin order', () => {
    irq.setMask(9, IRQ.EDGE_RISE); irq.setMask(2, IRQ.EDGE_RISE);
    levels[9] = 1; levels[2] = 1;
    expect(irq.collect().map((e) => e.pin)).toEqual([2, 9]);
  });

  it('a level interrupt is reported once when the condition becomes true, and once when enabled while true', () => {
    levels[4] = 1;
    irq.setMask(4, IRQ.LEVEL_HIGH);
    expect(irq.collect()).toEqual([{ pin: 4, events: IRQ.LEVEL_HIGH }]);
    expect(irq.collect()).toEqual([]);                                   // not repeated while it stays high
    levels[4] = 0; expect(irq.collect()).toEqual([]);
    levels[4] = 1; expect(irq.collect()).toEqual([{ pin: 4, events: IRQ.LEVEL_HIGH }]);
    // adding LEVEL_LOW while the pin is high reports nothing; dropping to low then reports it
    irq.setMask(4, IRQ.LEVEL_HIGH | IRQ.LEVEL_LOW);
    levels[4] = 0; expect(irq.collect()).toEqual([{ pin: 4, events: IRQ.LEVEL_LOW }]);
  });

  it('a pulse that is over before the next look is not seen (documented limit)', () => {
    irq.setMask(3, IRQ.EDGE_RISE | IRQ.EDGE_FALL);
    levels[3] = 1; levels[3] = 0;
    expect(irq.collect()).toEqual([]);
  });
});

describe('WorkerPins interrupts', () => {
  let pins; let delivered; let events; let clock;
  beforeEach(() => {
    events = []; delivered = [];
    pins = new WorkerPins((e) => events.push(e));
    clock = new VirtualClock({ mode: 'fast' });
    pins.attachClock(clock);
    pins.setIrqDispatch((pin, mask) => delivered.push([pin, mask, clock.nowUs()]));
  });
  const gpio = (n) => ({ nodeType: 'gpio', pin: n });

  it('the program writing an output that is wired to an input with an interrupt delivers it at once, at that virtual time', () => {
    const board = new WorkerBoard(null);
    board.setCircuit({ components: [], wires: [{ start: gpio(19), end: gpio(20) }] });   // GP14 -> GP15
    pins.attachBoard(board);
    pins.create(14, PIN_DIR.OUT, PULL.NONE);
    pins.create(15, PIN_DIR.IN, PULL.DOWN);
    pins.irqSet(15, 8 | 4);
    clock.sleepUs(1000);
    pins.write(14, 1);
    pins.write(14, 0);
    expect(delivered).toEqual([[15, 8, 1000], [15, 4, 1000]]);
    expect(events.filter((e) => e.type === EVENT.IRQ_FIRED).map((e) => [e.pin, e.events])).toEqual([[15, 8], [15, 4]]);
  });

  it('a circuit change (e.g. a button) that happens during a sleep is delivered at its own time when the clock wakes there', () => {
    const board = new WorkerBoard(null);
    const wires = [{ start: gpio(3), end: { nodeType: 'component_pin', componentId: 'btn_1', pin: '1' } }, { start: { nodeType: 'component_pin', componentId: 'btn_1', pin: '3' }, end: gpio(1) }];
    const press = (pressed) => board.setCircuit({ components: [{ id: 'btn_1', isPressed: pressed }], wires });
    press(false);
    pins.attachBoard(board);
    pins.create(0, PIN_DIR.IN, PULL.UP);
    pins.irqSet(0, 4);
    clock.addWakeSource(() => (clock.nowUs() < 400_000 ? 400_000 : Infinity));
    clock.onAdvance((from, to) => { if (to === 400_000 && from < to) press(true); });
    clock.sleepUs(1_000_000);
    expect(delivered).toEqual([[0, 4, 400_000]]);
    expect(clock.nowUs()).toBe(1_000_000);
  });

  it('handlers do not nest: a handler that reads or sleeps does not start another service, and edges it causes are delivered after it', () => {
    const board = new WorkerBoard(null);
    board.setCircuit({ components: [], wires: [{ start: gpio(19), end: gpio(20) }] });
    pins.attachBoard(board);
    pins.create(14, PIN_DIR.OUT, PULL.NONE); pins.create(15, PIN_DIR.IN, PULL.DOWN);
    pins.irqSet(15, 8);
    let depth = 0; let maxDepth = 0;
    pins.setIrqDispatch((pin, mask) => {
      depth++; maxDepth = Math.max(maxDepth, depth);
      delivered.push([pin, mask]);
      clock.sleepUs(10); pins.read(15);
      depth--;
    });
    pins.write(14, 1);
    expect(maxDepth).toBe(1);
    expect(delivered).toEqual([[15, 8]]);
  });

  it('with no interrupt enabled nothing is looked at (zero cost) and no events are emitted', () => {
    pins.create(3, PIN_DIR.IN, PULL.UP);
    pins.read(3); clock.sleepUs(100);
    expect(delivered).toEqual([]);
    expect(events.some((e) => e.type === EVENT.IRQ_FIRED)).toBe(false);
  });

  it('disabling an interrupt stops delivery; a pin number outside the chip is rejected like any other pin call', () => {
    pins.create(3, PIN_DIR.OUT, PULL.NONE);
    pins.irqSet(3, 8); pins.write(3, 1);
    expect(delivered).toHaveLength(1);
    pins.irqSet(3, 0); pins.write(3, 0); pins.write(3, 1);
    expect(delivered).toHaveLength(1);
    expect(() => pins.irqSet(77, 8)).toThrow(/Pin 77 is invalid/);
  });
});
