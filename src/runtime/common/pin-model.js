/**
 * pin-model.js — the worker-side view of the 30 GPIO pins, shared by the Python and C workers
 *
 * The firmware calls Pin()/gpio_*() synchronously; this object answers reads immediately and tells
 * the main thread about changes. State is per GPIO (not per Pin object), as on the real chip:
 * two Pin(25) objects refer to the same pin and see the same direction, pull and level.
 *
 * Reads:
 *   output pin  -> the level the program last wrote
 *   input pin   -> with a board model attached (the normal case: shared memory is available), the pad's
 *                  reading from the electrical solver: threshold voltages with hysteresis, the pad's own
 *                  pull resistor, other pads and PWM on the same net (see board-runtime.js);
 *                  without one (no SharedArrayBuffer), what the main thread says the circuit drives onto it
 *                  (0, 1, or FLOATING -> the pull decides: up -> 1, down/none -> 0)
 *
 * Reset state of every pad is an input with the 65 kohm pull-down enabled, as on the chip. Pin(x, IN) and
 * gpio_init() leave the pull alone; an explicit "no pull" removes it.
 *
 * Writes also go into the shared output area, so the main thread can always find out the final
 * level of every pin even if a busy program flooded the event channel.
 */

import { FLOATING } from '../../worker-protocol/pin-levels.js';
import {
    NUM_GPIO, PIN_DIR, PULL, EVENT,
    SHARED_INPUT_BASE, SHARED_OUTPUT_BASE
} from '../../worker-protocol/protocol.js';
import { PwmEngine, gpioToSlice, gpioToChannel } from '../../hardware/pwm-sim.js';
import { planFrequency, levelForDuty16, duty16ForLevel } from './pwm-frequency.js';
import { IrqController } from './irq.js';
import { headerGpios } from '../../electrical/pico-pins.js';

const OPEN_DRAIN = 2;   // MicroPython Pin.OPEN_DRAIN
export const FUNC = Object.freeze({ SPI: 1, UART: 2, I2C: 3, PWM: 4, SIO: 5, NULL: 31 });   // gpio_function values (Pico SDK)
const MAX_IRQ_ROUNDS = 10_000;   // a handler that keeps causing new edges cannot trap one service call forever

export class WorkerPins {
    /** @param {(event: object, options?: object) => void} emit */
    constructor(emit) {
        this.emit = emit;
        this.shared = null;                       // Int32Array over the SharedArrayBuffer, if available
        this.fallbackInputs = new Array(NUM_GPIO).fill(FLOATING);
        this.pins = Array.from({ length: NUM_GPIO }, () => ({ dir: PIN_DIR.IN, pull: PULL.DOWN, out: 0, func: FUNC.SIO }));
        this.pwm = new PwmEngine();               // this worker's PWM slices (feeds PWM-driven pads into the solver)
        this.board = null;                        // the electrical model, if attached (see attachBoard)
        this.revision = 0;                        // bumped by every change to pad state; the board re-solves lazily
        this.clock = null;                        // the program's VirtualClock: every pin read costs it a little time
        this.headerGpios = headerGpios();
        this.irq = new IrqController((pin) => this.peekLevel(pin));   // which pins have interrupts, and what they last saw
        this.irqDispatch = null;                  // (pin, events) => void: runs the program's handler (set by the runtime)
        this.servicing = false;
        this.irqMasked = false;                   // machine.disable_irq(): edges are latched but handlers wait
    }

    attachShared(int32) { this.shared = int32; }

    /** Attach the program's virtual clock (reads of a pin advance it by one tick, so busy-wait loops progress). */
    attachClock(clock) {
        this.clock = clock;
        // Interrupts are delivered at every point where virtual time passes: after each slice of a sleep and each read.
        clock.setInterruptHook(() => this.serviceInterrupts());
    }

    /** The runtime's way to run a handler: (pin, events) => void. */
    setIrqDispatch(dispatch) { this.irqDispatch = dispatch; }

    /** Hold interrupt handlers back (true) or let them run (false); edges that fire meanwhile run on release. Returns the previous state. */
    setIrqMasked(masked) {
        const previous = this.irqMasked;
        this.irqMasked = !!masked;
        if (previous && !this.irqMasked) this.serviceInterrupts();
        return previous;
    }

    /** SDK gpio_set_irq_enabled(): add or remove event bits for a pin. */
    irqEnable(pin, mask, enabled) {
        this.#check(pin);
        this.irq.enable(pin, mask, enabled);
        this.emit({ type: EVENT.PIN_IRQ, pin, mask, enabled: !!enabled });
        this.serviceInterrupts();
    }

    /** MicroPython Pin.irq(trigger=...): replace a pin's event mask (0 turns interrupts off). */
    irqSet(pin, mask) {
        this.#check(pin);
        this.irq.setMask(pin, mask);
        this.emit({ type: EVENT.PIN_IRQ, pin, mask, enabled: mask !== 0 });
        this.serviceInterrupts();
    }

    /**
     * Run the handlers of every interrupt that has fired since the last call. Not re-entrant (a handler that reads
     * or sleeps does not start a nested service; the loop picks up whatever it caused afterwards).
     */
    serviceInterrupts() {
        if (this.servicing || !this.irqDispatch || !this.irq.anyEnabled()) return;
        if (this.irqMasked) { this.irq.latch(); return; }
        this.servicing = true;
        try {
            for (let round = 0; round < MAX_IRQ_ROUNDS; round++) {
                const pending = this.irq.collect();
                if (pending.length === 0) break;
                for (const { pin, events } of pending) {
                    this.emit({ type: EVENT.IRQ_FIRED, pin, events });
                    this.irqDispatch(pin, events);
                }
            }
        } finally {
            this.servicing = false;
        }
    }

    /** Attach the electrical model. Input reads then come from the solver instead of the main-thread drive. */
    attachBoard(board) { this.board = board; }

    /** What each header pad is doing, in the form the electrical engine takes. */
    padSnapshot() {
        const snapshot = {};
        for (const gpio of this.headerGpios) {
            const p = this.pins[gpio];
            // A pin whose function is PWM is driven by its PWM slice, whatever its SIO direction says: with the slice
            // stopped or the level 0 it is an output held low (duty 0), not a floating input.
            const pwmDriven = p.func === FUNC.PWM;
            snapshot[gpio] = {
                mode: pwmDriven || p.dir === PIN_DIR.OUT ? 'output' : 'input',
                level: p.out,
                pull: p.pull === PULL.UP ? 'up' : p.pull === PULL.DOWN ? 'down' : 'none'
            };
            if (pwmDriven) snapshot[gpio].duty = this.pwm.getDutyCycle(gpio);
        }
        return snapshot;
    }

    // PWM: the worker keeps its own slices so PWM-driven pads reach the solver, and tells the main thread (display).
    pwmSetWrap(slice, value) {
        this.pwm.setWrap(slice, value);
        this.emit({ type: EVENT.PWM, op: 'wrap', slice, value });
        this.#changed();
    }
    pwmSetLevel(slice, channel, value) {
        this.pwm.setLevel(slice, channel, value);
        this.emit({ type: EVENT.PWM, op: 'level', slice, channel, value });
        this.#changed();
    }
    pwmSetEnabled(slice, enabled) {
        this.pwm.setEnabled(slice, enabled);
        this.emit({ type: EVENT.PWM, op: 'enable', slice, value: enabled ? 1 : 0 });
        this.#changed();
    }
    pwmSetClkdiv(slice, div) {
        this.pwm.setClkdiv(slice, div);
        this.emit({ type: EVENT.PWM, op: 'clkdiv', slice, value: div });
        this.#changed();
    }

    // MicroPython machine.PWM(pin): frequency and 16-bit duty on a GPIO.
    /** Start PWM on a pin: slice running, duty 0. */
    pwmInit(gpio) {
        this.#check(gpio);
        const slice = gpioToSlice(gpio);
        this.pins[gpio].func = FUNC.PWM;
        this.emit({ type: EVENT.PIN_FUNC, pin: gpio, fn: FUNC.PWM });
        this.pwmSetEnabled(slice, true);
    }
    /** The actual frequency in Hz (rounded), 0 if the slice is not running. */
    pwmFreq(gpio) { return Math.round(this.pwm.getFrequencyHz(gpio)); }
    /** Set the frequency (RangeError 'freq too large' / 'freq too small' as in MicroPython); keeps the duty. */
    pwmSetFreq(gpio, hz) {
        this.#check(gpio);
        const { div16, top } = planFrequency(hz);
        const slice = gpioToSlice(gpio);
        const keep = this.pwmDuty16(gpio);
        this.pwmSetClkdiv(slice, div16 / 16);
        this.pwmSetWrap(slice, top - 1);
        this.pwmSetLevel(slice, gpioToChannel(gpio), levelForDuty16(keep, top));
        this.pwmSetEnabled(slice, true);
    }
    pwmDuty16(gpio) {
        const state = this.pwm.getSliceState(gpioToSlice(gpio));
        return state ? duty16ForLevel(state.levels[gpioToChannel(gpio)], state.wrap + 1) : 0;
    }
    pwmSetDuty16(gpio, duty16) {
        this.#check(gpio);
        const slice = gpioToSlice(gpio);
        const state = this.pwm.getSliceState(slice);
        this.pwmSetLevel(slice, gpioToChannel(gpio), levelForDuty16(duty16, state.wrap + 1));
        if (!state.enabled) this.pwmSetEnabled(slice, true);
    }
    /** machine.PWM.deinit(): duty 0 and, if nothing else uses the slice, stop it. */
    pwmDeinit(gpio) {
        this.#check(gpio);
        const slice = gpioToSlice(gpio);
        this.pwmSetLevel(slice, gpioToChannel(gpio), 0);
        const state = this.pwm.getSliceState(slice);
        if (state.levels[0] === 0 && state.levels[1] === 0) this.pwmSetEnabled(slice, false);
        this.pins[gpio].func = FUNC.SIO;                              // the pin is a plain GPIO again
        this.emit({ type: EVENT.PIN_FUNC, pin: gpio, fn: FUNC.SIO });
        this.#changed();
    }

    // Reading a pin's configuration back (gpio_get_dir, Pin.mode() ...)
    getDir(pin) { return this.#valid(pin) ? this.pins[pin].dir : PIN_DIR.IN; }
    getPull(pin) { return this.#valid(pin) ? this.pins[pin].pull : PULL.NONE; }
    getOut(pin) { return this.#valid(pin) ? this.pins[pin].out : 0; }
    getFunction(pin) { return this.#valid(pin) ? this.pins[pin].func : FUNC.NULL; }

    /**
     * gpio_set_function(): which peripheral drives the pad. Only PWM changes behaviour; SIO (plain GPIO) is the reset
     * state and what gpio_init() / Pin(id, mode) select. Other functions are remembered and otherwise ignored.
     */
    setFunction(pin, fn) {
        const p = this.#check(pin);
        p.func = Number.isInteger(fn) ? fn : FUNC.SIO;
        this.emit({ type: EVENT.PIN_FUNC, pin, fn: p.func });
        this.#changed();
    }

    /** Used when SharedArrayBuffer is not available (messages from the main thread). */
    setFallbackInput(pin, value) {
        if (this.#valid(pin)) this.fallbackInputs[pin] = value;
    }

    #valid(pin) { return Number.isInteger(pin) && pin >= 0 && pin < NUM_GPIO; }

    #check(pin) {
        if (!this.#valid(pin)) throw new Error(`ValueError: Pin ${pin} is invalid (0-${NUM_GPIO - 1})`);
        return this.pins[pin];
    }

    /**
     * MicroPython Pin(id, mode, pull). -1 means "not given: keep the current setting".
     * pull: 0 none, 1 up, 2 down (None must already have been converted to 0 by the caller).
     */
    create(pin, mode = -1, pull = -1) {
        const p = this.#check(pin);
        if (mode === OPEN_DRAIN) mode = PIN_DIR.OUT;                // approximated as a plain output
        if (mode === PIN_DIR.IN || mode === PIN_DIR.OUT) { p.dir = mode; p.func = FUNC.SIO; }   // Pin(id, mode) selects plain GPIO
        if (pull === PULL.NONE || pull === PULL.UP || pull === PULL.DOWN) p.pull = pull;
        this.emit({ type: EVENT.PIN_CREATE, pin, mode: p.dir, pull: p.pull });
        this.#changed();
    }

    /** C gpio_init: input, output level low. The pull setting is left alone. */
    init(pin) {
        const p = this.#check(pin);
        p.dir = PIN_DIR.IN;
        p.func = FUNC.SIO;                                           // gpio_init selects plain GPIO
        this.#storeOutput(pin, p, 0);
        this.emit({ type: EVENT.PIN_INIT, pin, pull: p.pull });
        this.#changed();
    }

    setDir(pin, dir) {
        const p = this.#check(pin);
        p.dir = dir ? PIN_DIR.OUT : PIN_DIR.IN;
        this.emit({ type: EVENT.PIN_DIR, pin, dir: p.dir });
        this.#changed();
    }

    setPull(pin, pull) {
        const p = this.#check(pin);
        p.pull = pull === PULL.UP || pull === PULL.DOWN ? pull : PULL.NONE;
        this.emit({ type: EVENT.PIN_PULL, pin, pull: p.pull });
        this.#changed();
    }

    write(pin, value) {
        const p = this.#check(pin);
        const before = p.out;
        this.#storeOutput(pin, p, value ? 1 : 0);
        this.emit({ type: EVENT.PIN_WRITE, pin, value: p.out });
        if (p.out !== before) this.#changed();          // writing the level it already has changes nothing
    }

    toggle(pin) {
        const p = this.#check(pin);
        this.write(pin, p.out ? 0 : 1);
    }

    isOutput(pin) {
        return this.#valid(pin) && this.pins[pin].dir === PIN_DIR.OUT;
    }

    read(pin) {
        if (this.clock) this.clock.tick();
        return this.peekLevel(pin);
    }

    /** The pin's level now, without costing the clock a tick (interrupt detection uses this). */
    peekLevel(pin) {
        if (!this.#valid(pin)) return 0;
        const p = this.pins[pin];
        if (p.dir === PIN_DIR.OUT) return p.out;
        if (this.board) {
            const level = this.board.readInput(pin, this);
            if (level === 0 || level === 1) return level;
        }
        const driven = this.shared ? Atomics.load(this.shared, SHARED_INPUT_BASE + pin) : this.fallbackInputs[pin];
        if (driven === 0 || driven === 1) return driven;
        return p.pull === PULL.UP ? 1 : 0;
    }

    /** Pad state changed: the board must re-solve, and a pin with an interrupt may have fired. */
    #changed() {
        this.revision++;
        this.serviceInterrupts();
    }

    #storeOutput(pin, p, value) {
        if (p.out !== value) this.revision++;
        p.out = value;
        if (this.shared) Atomics.store(this.shared, SHARED_OUTPUT_BASE + pin, value);
    }
}
