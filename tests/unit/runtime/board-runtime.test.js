import { describe, it, expect, beforeEach } from 'vitest';
import { WorkerPins, FUNC } from '../../../src/runtime/common/pin-model.js';
import { WorkerBoard } from '../../../src/runtime/common/board-runtime.js';
import { createCircuitBuffer, writeCircuit, snapshotCircuit } from '../../../src/electrical/circuit-channel.js';
import { PIN_DIR, PULL, EVENT } from '../../../src/worker-protocol/protocol.js';

// The worker-side electrical model: what a program READS from an input pin, given its own pin settings
// (pull, direction, output, PWM) and the circuit the user built. Python and C use this same object, so the
// browser parity tests (tests/e2e/pin_parity.spec.js) check the wiring of each language to it, and this file checks
// the electrical behaviour itself.

const pin = (physical) => ({ nodeType: 'gpio', pin: physical });
const cp = (componentId, p) => ({ nodeType: 'component_pin', componentId, pin: p });
const wire = (start, end) => ({ start, end });
const P = { GP0: 1, GP1: 2, GP14: 19, GP15: 20, GND: 3, V3V3: 36, VBUS: 40 };
const resistor = (id, value, unit = 1) => ({ id, value, unit });

let events; let pins; let board;
beforeEach(() => {
  events = [];
  pins = new WorkerPins((e) => events.push(e));
  board = new WorkerBoard(null);
  pins.attachBoard(board);
});
const circuit = (components, wires) => board.setCircuit({ components, wires });

describe('reset state and pulls (B9)', () => {
  it('every pad resets to an input with the pull-down enabled: an unwired input reads 0', () => {
    expect(pins.pins[5]).toMatchObject({ dir: PIN_DIR.IN, pull: PULL.DOWN });
    expect(pins.read(5)).toBe(0);
  });

  it('an unwired input follows its pull: up reads 1, down reads 0', () => {
    pins.create(3, 0, PULL.UP); expect(pins.read(3)).toBe(1);
    pins.create(3, 0, PULL.DOWN); expect(pins.read(3)).toBe(0);
  });

  it('Pin(x, IN) with no pull argument keeps the pull that was set; gpio_init keeps it too', () => {
    pins.create(3, 0, PULL.UP);
    pins.create(3, 0, -1);
    expect(pins.read(3)).toBe(1);
    pins.init(3);
    expect(pins.read(3)).toBe(1);
    expect(events.at(-1)).toEqual({ type: EVENT.PIN_INIT, pin: 3, pull: PULL.UP });
  });

  it('an unwired input with NO pull is floating: it keeps its last reading (starts low)', () => {
    pins.create(3, 0, PULL.NONE);
    expect(pins.read(3)).toBe(0);
  });

  it('a pin that is not on the 40-pin header (GP25, the Pico W LED) falls back to the simple pull rule', () => {
    pins.create(25, 0, PULL.UP);
    expect(pins.read(25)).toBe(1);
    pins.create(25, 0, PULL.DOWN);
    expect(pins.read(25)).toBe(0);
  });
});

describe('thresholds and hysteresis (B10)', () => {
  // 3V3 -> R -> GP0, with GP0's own pull-down (65 kohm): V = 3.3 * 65k / (R + 0.2 + 65k)
  const divider = (ohms) => circuit([resistor('res_1', ohms)], [wire(pin(P.V3V3), cp('res_1', '1')), wire(cp('res_1', '2'), pin(P.GP0))]);

  it('a strong pull-up (10 kohm: 2.86 V) reads high, a hard ground reads low', () => {
    divider(10_000);
    expect(pins.read(0)).toBe(1);
    circuit([], [wire(pin(P.GND), pin(P.GP0))]);
    expect(pins.read(0)).toBe(0);
  });

  it('a weak pull-up (100 kohm vs the internal pull-down: 1.3 V) is in the undefined band and keeps the previous reading', () => {
    divider(100_000);
    expect(pins.read(0)).toBe(0);               // previous reading at reset: low
    divider(1_000);
    expect(pins.read(0)).toBe(1);               // driven high
    divider(100_000);
    expect(pins.read(0)).toBe(1);               // 1.3 V: stays high
    circuit([], [wire(pin(P.GND), pin(P.GP0))]);
    expect(pins.read(0)).toBe(0);
    divider(100_000);
    expect(pins.read(0)).toBe(0);               // and stays low on the way back
  });

  it('removing the internal pull-down (pull=None) makes the same 100 kohm pull-up read high (3.3 V)', () => {
    divider(100_000);
    pins.create(0, 0, PULL.NONE);
    expect(pins.read(0)).toBe(1);
  });

  it('either side of the thresholds (2.0 V and 0.8 V), with divider resistors chosen for the target voltage', () => {
    const ohmsFor = (volts) => 3.3 * 65_000 / volts - 65_000.2;       // 3V3 -> R -> pad with its 65 kohm pull-down
    const at = (volts) => { divider(ohmsFor(volts)); return pins.read(0); };
    expect(at(1.95)).toBe(0);      // below VIH from low: stays low
    expect(at(2.05)).toBe(1);      // above VIH: high
    expect(at(1.95)).toBe(1);      // between the thresholds: stays high
    expect(at(0.85)).toBe(1);      // still above VIL: stays high
    expect(at(0.75)).toBe(0);      // below VIL: low
    expect(at(1.95)).toBe(0);      // and stays low on the way back up
  });
});

describe('the circuit decides what an input reads (Python and C share this)', () => {
  it('GPIO-to-GPIO: an input reads the output on the same net, high and low', () => {
    circuit([], [wire(pin(P.GP14), pin(P.GP15))]);
    pins.create(14, PIN_DIR.OUT, PULL.NONE);
    pins.create(15, PIN_DIR.IN, PULL.DOWN);
    pins.write(14, 1); expect(pins.read(15)).toBe(1);
    pins.write(14, 0); expect(pins.read(15)).toBe(0);
    pins.write(14, 1); expect(pins.read(15)).toBe(1);
  });

  it('a button between 3V3 and an input pulls it up only while pressed; a change of the circuit is noticed without any pin activity', () => {
    const wires = [wire(pin(P.V3V3), cp('btn_1', '1')), wire(cp('btn_1', '3'), pin(P.GP0))];
    circuit([{ id: 'btn_1', isPressed: false }], wires);
    expect(pins.read(0)).toBe(0);
    circuit([{ id: 'btn_1', isPressed: true }], wires);
    expect(pins.read(0)).toBe(1);
    circuit([{ id: 'btn_1', isPressed: false }], wires);
    expect(pins.read(0)).toBe(0);
  });

  it('a button to GND with the internal pull-up: 1 released, 0 pressed (the usual wiring)', () => {
    const wires = [wire(pin(P.GND), cp('btn_1', '1')), wire(cp('btn_1', '3'), pin(P.GP0))];
    pins.create(0, 0, PULL.UP);
    circuit([{ id: 'btn_1', isPressed: false }], wires); expect(pins.read(0)).toBe(1);
    circuit([{ id: 'btn_1', isPressed: true }], wires); expect(pins.read(0)).toBe(0);
  });

  it('an input wired only to an open button, with no pull, is floating and keeps its last reading', () => {
    const wires = [wire(pin(P.V3V3), cp('btn_1', '1')), wire(cp('btn_1', '3'), pin(P.GP0))];
    pins.create(0, 0, PULL.NONE);
    circuit([{ id: 'btn_1', isPressed: true }], wires);
    expect(pins.read(0)).toBe(1);
    circuit([{ id: 'btn_1', isPressed: false }], wires);     // released: nothing holds the pin any more
    expect(pins.read(0)).toBe(1);
  });

  it('two outputs fighting on one net read the divider, not either rail', () => {
    circuit([], [wire(pin(P.GP14), pin(P.GP15)), wire(pin(P.GP15), pin(P.GP0))]);
    pins.create(14, PIN_DIR.OUT, PULL.NONE); pins.write(14, 1);
    pins.create(15, PIN_DIR.OUT, PULL.NONE); pins.write(15, 0);
    expect(pins.read(0)).toBe(0);               // 3.3 V * 100 / 270 = 1.22 V: undefined band, previous (low)
  });

  it('reading an output pin returns the level the program wrote, whatever the circuit does', () => {
    circuit([], [wire(pin(P.GP14), pin(P.GND))]);
    pins.create(14, PIN_DIR.OUT, PULL.NONE);
    pins.write(14, 1);
    expect(pins.read(14)).toBe(1);
  });
});

describe('PWM edge cases (C feeds its slices to the same model)', () => {
  // GP14 = slice 7 channel 0. Wire GP14 -> GP15 so an input can observe it.
  beforeEach(() => {
    circuit([], [wire(pin(P.GP14), pin(P.GP15))]);
    pins.create(14, PIN_DIR.OUT, PULL.NONE);
    pins.create(15, PIN_DIR.IN, PULL.DOWN);
    pins.write(14, 0);
    pins.setFunction(14, FUNC.PWM);             // gpio_set_function(14, GPIO_FUNC_PWM): the slice now drives the pad
  });
  const slice = 7;

  it('a mostly-high PWM reads high, a mostly-low PWM reads low (the input sees the most probable level)', () => {
    pins.pwmSetWrap(slice, 999); pins.pwmSetEnabled(slice, true);
    pins.pwmSetLevel(slice, 0, 900); expect(pins.read(15)).toBe(1);
    pins.pwmSetLevel(slice, 0, 100); expect(pins.read(15)).toBe(0);
  });

  it('level above wrap+1 is clamped to a constant high; level 0 is a constant low', () => {
    pins.pwmSetWrap(slice, 99); pins.pwmSetEnabled(slice, true);
    pins.pwmSetLevel(slice, 0, 5000); expect(pins.read(15)).toBe(1);
    pins.pwmSetLevel(slice, 0, 0); expect(pins.read(15)).toBe(0);
  });

  it('wrap 0 with any level is a constant high', () => {
    pins.pwmSetWrap(slice, 0); pins.pwmSetEnabled(slice, true);
    pins.pwmSetLevel(slice, 0, 1); expect(pins.read(15)).toBe(1);
  });

  it('a PWM pin with a stopped slice, or duty 0, is an output held LOW (not a floating input, not its old SIO level)', () => {
    pins.write(14, 1);                           // the SIO level is high, but the pad belongs to PWM now
    pins.pwmSetWrap(slice, 99); pins.pwmSetLevel(slice, 0, 99);
    expect(pins.read(15)).toBe(0);               // configured but the slice is not enabled
    pins.pwmSetEnabled(slice, true); expect(pins.read(15)).toBe(1);
    pins.pwmSetLevel(slice, 0, 0); expect(pins.read(15)).toBe(0);      // duty 0: low, whatever gpio_put last wrote
    pins.pwmSetLevel(slice, 0, 99); expect(pins.read(15)).toBe(1);
    pins.pwmSetEnabled(slice, false); expect(pins.read(15)).toBe(0);
  });

  it('only a pin whose function is PWM follows the slice: back to plain GPIO (gpio_init / Pin(id, mode)) it follows gpio_put again', () => {
    pins.pwmSetWrap(slice, 99); pins.pwmSetLevel(slice, 0, 99); pins.pwmSetEnabled(slice, true);
    expect(pins.read(15)).toBe(1);
    pins.init(14); pins.setDir(14, 1);           // gpio_init + gpio_set_dir(OUT): plain GPIO, level 0
    expect(pins.getFunction(14)).toBe(FUNC.SIO);
    expect(pins.read(15)).toBe(0);
    pins.write(14, 1); expect(pins.read(15)).toBe(1);
    pins.setFunction(14, FUNC.PWM);
    expect(pins.getFunction(14)).toBe(FUNC.PWM);
  });

  it('a slice that is running but whose pin was never given the PWM function does nothing to the pad (as on the chip)', () => {
    pins.setFunction(14, FUNC.SIO);
    pins.pwmSetWrap(slice, 99); pins.pwmSetLevel(slice, 0, 99); pins.pwmSetEnabled(slice, true);
    expect(pins.read(15)).toBe(0);
  });

  it('PWM on an unwired pad changes nothing visible to other pins', () => {
    pins.pwmSetWrap(0, 99); pins.pwmSetLevel(0, 0, 50); pins.pwmSetEnabled(0, true);
    expect(pins.read(1)).toBe(0);
  });
});

describe('laziness and revisions', () => {
  it('re-reading with nothing changed does not re-solve; any pin change or new circuit does', () => {
    circuit([], [wire(pin(P.GP14), pin(P.GP15))]);
    pins.create(14, PIN_DIR.OUT, PULL.NONE);
    pins.read(15);
    const solves = board.solves;
    for (let i = 0; i < 200; i++) pins.read(15);
    expect(board.solves).toBe(solves);
    pins.write(14, 1); pins.read(15);
    expect(board.solves).toBe(solves + 1);
    pins.write(14, 1); pins.read(15);            // same value again: no change, no solve
    expect(board.solves).toBe(solves + 1);
    circuit([], [wire(pin(P.GP14), pin(P.GP15))]); pins.read(15);
    expect(board.solves).toBe(solves + 2);
  });

  it('a toggling loop with a read each time stays fast (the engine caches recent pad states)', () => {
    circuit([], [wire(pin(P.GP14), pin(P.GP15))]);
    pins.create(14, PIN_DIR.OUT, PULL.NONE);
    pins.read(15); pins.write(14, 1); pins.read(15); pins.write(14, 0); pins.read(15);   // warm the cache
    const t = performance.now();
    for (let i = 0; i < 2000; i++) { pins.write(14, i & 1); expect(pins.read(15)).toBe(i & 1); }
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('the circuit arrives through shared memory', () => {
  it('a board attached to a circuit buffer sees the first snapshot, then later edits and button presses', () => {
    const buffer = createCircuitBuffer();
    const shared = new WorkerPins(() => {});
    shared.attachBoard(new WorkerBoard(buffer));
    const wires = [{ start: pin(P.V3V3), end: cp('btn_1', '1') }, { start: cp('btn_1', '3'), end: pin(P.GP0) }];
    writeCircuit(buffer, snapshotCircuit([{ id: 'btn_1', isPressed: false }], wires));
    expect(shared.read(0)).toBe(0);
    writeCircuit(buffer, snapshotCircuit([{ id: 'btn_1', isPressed: true }], wires));
    expect(shared.read(0)).toBe(1);
    writeCircuit(buffer, snapshotCircuit([{ id: 'btn_1', isPressed: true }], []));   // wire removed while running
    expect(shared.read(0)).toBe(0);
  });

  it('with no circuit published yet, reads behave like an empty board (pull only)', () => {
    const shared = new WorkerPins(() => {});
    shared.attachBoard(new WorkerBoard(createCircuitBuffer()));
    shared.create(3, 0, PULL.UP);
    expect(shared.read(3)).toBe(1);
  });
});
