/**
 * gpio-sim.js — GPIO State Engine
 *
 * The main-thread record of what each of the 30 GPIO pins (GP0–GP29) is doing: initialised, direction, the last written
 * output, the pull configuration and what the circuit drives onto it. The Pico state inspector and the simulator bridge
 * read it; the firmware workers keep their own pin model (src/runtime/common/pin-model.js) and report changes here.
 *
 * RESPONSIBILITIES:
 *   - Track pin state: initialized, direction, output value, pull config
 *   - Track external drive state (null = floating, 0/1 = driven)
 *   - Provide read/write methods that mirror real Pico SDK behavior
 *   - Apply pull-resistor defaults when a pin is floating (not externally driven)
 *
 * INPUT PIN MODEL:
 *   Each input pin has two layers:
 *     1. externalDrive — set by external hardware (buttons, wires, etc.)
 *        - null  = pin is floating (no external signal)
 *        - 0 / 1 = pin is actively driven LOW / HIGH
 *     2. pull — internal pull-up/pull-down resistor config
 *        - PULL_UP   = floating pin reads HIGH (1)
 *        - PULL_DOWN = floating pin reads LOW (0)
 *        - PULL_NONE = floating pin reads LOW (0, indeterminate)
 *
 *   readPin() resolves the effective value:
 *     externalDrive !== null → return externalDrive
 *     externalDrive === null → return pull default
 *
 * Interrupts are not handled here: they are detected and delivered inside the firmware workers (irq.js / pin-model.js).
 *
 * DOES NOT:
 *   - Touch the DOM or UI
 *   - Communicate with the Web Worker
 *   - Handle SharedArrayBuffer
 *   - Perform circuit analysis (that is src/electrical)
 */

// ---------- Constants (match Pico SDK) ----------
export const GPIO_IN = 0;
export const GPIO_OUT = 1;

export const PULL_NONE = 0;
export const PULL_UP = 1;
export const PULL_DOWN = 2;

const NUM_PINS = 30; // GP0–GP29

// ---------- Pin State Array ----------

/**
 * Each pin is an object:
 *   initialized    : boolean      — has gpio_init been called?
 *   direction      : number       — GPIO_IN (0) or GPIO_OUT (1)
 *   outputValue    : number       — last written output (0 or 1)
 *   externalDrive  : number|null  — external input signal (null = floating, 0/1 = driven)
 *   pull           : number       — PULL_NONE, PULL_UP, or PULL_DOWN
 *
 * The effective input value is computed by readPin(), not stored directly.
 * When externalDrive is null, readPin uses the pull config as the default.
 */
function createDefaultPin() {
    return {
        initialized: false,
        direction: GPIO_IN,
        outputValue: 0,
        externalDrive: null, // null = floating (no external signal)
        pull: PULL_NONE
    };
}

const pins = [];
for (let i = 0; i < NUM_PINS; i++) {
    pins.push(createDefaultPin());
}

// ---------- SDK-Style Functions ----------

/**
 * Initialize a GPIO pin.
 * Mirrors: gpio_init(uint gpio)
 */
export function initPin(pin) {
    if (pin < 0 || pin >= NUM_PINS) return;
    pins[pin].initialized = true;
}

/**
 * Set pin direction.
 * Mirrors: gpio_set_dir(uint gpio, bool out)
 *
 * @param {number} pin — GPIO number (0–29)
 * @param {number} dir — GPIO_IN (0) or GPIO_OUT (1)
 */
export function setDirection(pin, dir) {
    if (pin < 0 || pin >= NUM_PINS) return;
    pins[pin].direction = dir;
}

/**
 * Write a value to an output pin.
 * Mirrors: gpio_put(uint gpio, bool value)
 *
 * Only meaningful for output pins, but we store the value regardless
 * (matches real hardware behavior).
 *
 * @param {number} pin   — GPIO number (0–29)
 * @param {number} value — 0 or 1
 */
export function writePin(pin, value) {
    if (pin < 0 || pin >= NUM_PINS) return;
    pins[pin].outputValue = value ? 1 : 0;
}

/**
 * Read the current value of a pin.
 * Mirrors: gpio_get(uint gpio)
 *
 * - For OUTPUT pins: returns the last written output value.
 * - For INPUT pins: uses the external drive model:
 *     1. If externally driven (externalDrive is 0 or 1), return that value.
 *     2. If floating (externalDrive is null), return the pull resistor default:
 *        - PULL_UP   → 1 (HIGH)
 *        - PULL_DOWN → 0 (LOW)
 *        - PULL_NONE → 0 (indeterminate, default LOW)
 *
 * @param {number} pin — GPIO number (0–29)
 * @returns {number} — 0 or 1
 */
export function readPin(pin) {
    if (pin < 0 || pin >= NUM_PINS) return 0;

    if (pins[pin].direction === GPIO_OUT) {
        return pins[pin].outputValue;
    }

    // INPUT mode: check external drive first
    if (pins[pin].externalDrive !== null) {
        return pins[pin].externalDrive;
    }

    // Pin is floating — return pull resistor default
    if (pins[pin].pull === PULL_UP) return 1;
    if (pins[pin].pull === PULL_DOWN) return 0;
    return 0; // PULL_NONE: floating with no pull, indeterminate → default LOW
}

/**
 * Set the external drive value for a pin.
 * Called by the bridge when external hardware changes (button press/release, wiring).
 * This is NOT a Pico SDK function — it's a simulator-internal operation.
 *
 * @param {number} pin        — GPIO number (0–29)
 * @param {number|null} value — 0 or 1 (driven), or null (floating / released)
 */
export function setInputValue(pin, value) {
    if (pin < 0 || pin >= NUM_PINS) return;

    // null/undefined = floating (no external signal); 0 or 1 = actively driven by external hardware
    pins[pin].externalDrive = (value === null || value === undefined)
        ? null
        : (value ? 1 : 0);
}

/**
 * Set pull-up/pull-down configuration.
 * Mirrors: gpio_pull_up / gpio_pull_down / gpio_disable_pulls
 *
 * Only sets the pull config. The effective input value is resolved
 * dynamically by readPin() — when the pin is floating (externalDrive is null),
 * readPin returns the pull default (PULL_UP → 1, PULL_DOWN → 0).
 *
 * @param {number} pin  — GPIO number (0–29)
 * @param {number} pull — PULL_NONE, PULL_UP, or PULL_DOWN
 */
export function setPull(pin, pull) {
    if (pin < 0 || pin >= NUM_PINS) return;
    pins[pin].pull = pull;
    // No immediate side effects — readPin() checks pull dynamically
}

/**
 * Get the full state of a single pin (for debugging / watch panels).
 *
 * @param {number} pin — GPIO number (0–29)
 * @returns {object|null} — copy of pin state, or null if invalid
 */
export function getPinState(pin) {
    if (pin < 0 || pin >= NUM_PINS) return null;
    return { ...pins[pin] };
}

/**
 * Check if a specific pin's output is HIGH.
 *
 * @param {number} pin — GPIO number (0–29)
 * @returns {boolean}
 */
export function isPinHigh(pin) {
    if (pin < 0 || pin >= NUM_PINS) return false;
    return pins[pin].outputValue === 1;
}

/**
 * Reset all pins to default state.
 * Called on simulation stop or system reset.
 */
export function resetAll() {
    for (let i = 0; i < NUM_PINS; i++) {
        pins[i] = createDefaultPin();
    }
}
