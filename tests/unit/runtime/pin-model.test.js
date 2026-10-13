import { describe, it, expect, beforeEach } from 'vitest';
import { WorkerPins } from '../../../src/runtime/common/pin-model.js';
import { FLOATING } from '../../../src/worker-protocol/pin-levels.js';
import {
  SHARED_INPUT_BASE, SHARED_OUTPUT_BASE, SHARED_PINS_LENGTH, OUTPUT_UNSET,
} from '../../../src/worker-protocol/protocol.js';

let events; let pins; let shared;
beforeEach(() => {
  events = [];
  pins = new WorkerPins((e) => events.push(e));
  shared = new Int32Array(new SharedArrayBuffer(SHARED_PINS_LENGTH * 4));
  shared.fill(FLOATING);
  pins.attachShared(shared);
});
const drive = (pin, v) => Atomics.store(shared, SHARED_INPUT_BASE + pin, v);

describe('WorkerPins reads', () => {
  it('a floating input follows its pull resistor', () => {
    pins.create(5, 0, 1); expect(pins.read(5)).toBe(1);     // pull-up
    pins.create(5, 0, 2); expect(pins.read(5)).toBe(0);     // pull-down
    pins.create(5, 0, 0); expect(pins.read(5)).toBe(0);     // none behaves as low
  });

  it('a driven input ignores the pull; releasing it goes back to the pull', () => {
    pins.create(5, 0, 1);
    drive(5, 0); expect(pins.read(5)).toBe(0);
    drive(5, 1); pins.create(5, 0, 2); expect(pins.read(5)).toBe(1);
    drive(5, FLOATING); expect(pins.read(5)).toBe(0);
  });

  it('an output pin reads back the level it drives, and ignores the circuit', () => {
    pins.create(15, 1, 0);
    pins.write(15, 1); expect(pins.read(15)).toBe(1);
    drive(15, 0); expect(pins.read(15)).toBe(1);
    pins.toggle(15); expect(pins.read(15)).toBe(0);
  });

  it('falls back to messages when there is no shared memory', () => {
    const lonely = new WorkerPins(() => {});
    lonely.create(3, 0, 1);
    expect(lonely.read(3)).toBe(1);                         // floating, pull-up
    lonely.setFallbackInput(3, 0); expect(lonely.read(3)).toBe(0);
  });

  it('out-of-range reads are 0; out-of-range writes throw a Python-style ValueError', () => {
    expect(pins.read(99)).toBe(0);
    expect(() => pins.write(30, 1)).toThrow(/Pin 30 is invalid/);
    expect(() => pins.create(-1)).toThrow(/ValueError/);
  });
});

describe('WorkerPins configuration (-1 keeps the current setting, state is per GPIO)', () => {
  it('keeps direction and pull when they are not given', () => {
    pins.create(7, 1, 2);
    pins.create(7);                                          // Pin(7) with no arguments
    expect(events.at(-1)).toEqual({ type: 'pin.create', pin: 7, mode: 1, pull: 2 });
  });

  it('two Pin objects for the same GPIO share state', () => {
    pins.create(25, 1, 0); pins.write(25, 1);
    pins.create(25);                                         // second object, same pin
    expect(pins.read(25)).toBe(1);
  });

  it('gpio_init makes the pin a low input and keeps the pull', () => {
    pins.create(4, 1, 1); pins.write(4, 1);
    pins.init(4);
    expect(pins.read(4)).toBe(1);                            // input, floating, pull-up
    expect(events.at(-1)).toEqual({ type: 'pin.init', pin: 4, pull: 1 });
    expect(shared[SHARED_OUTPUT_BASE + 4]).toBe(0);
  });
});

describe('WorkerPins events and shared output mirror', () => {
  it('sends absolute values; a toggle becomes an explicit write', () => {
    pins.create(15, 1, 0);
    pins.toggle(15); pins.toggle(15);
    expect(events.filter((e) => e.type === 'pin.write').map((e) => e.value)).toEqual([1, 0]);
  });

  it('mirrors the last output level into shared memory (so floods cannot hide the final state)', () => {
    expect(shared[SHARED_OUTPUT_BASE + 15]).not.toBe(1);
    pins.create(15, 1, 0);
    pins.write(15, 1);
    expect(shared[SHARED_OUTPUT_BASE + 15]).toBe(1);
    pins.write(15, 0);
    expect(shared[SHARED_OUTPUT_BASE + 15]).toBe(0);
    expect(OUTPUT_UNSET).toBe(-1);
  });
});
