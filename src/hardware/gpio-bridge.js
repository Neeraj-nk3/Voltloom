/**
 * gpio-bridge.js — GPIO Bridge Layer (Public API)
 *
 * This is the ONLY module that simulator-bridge.js and other parts of
 * the simulator should call for GPIO operations.
 *
 * DATA FLOW:
 *   Worker pin event → SimulatorBridge._handleEvent() → gpio-bridge.handlePinAction()
 *                                                        → gpio-sim.writePin()
 *
 *   Circuit change / button press → SimulatorBridge._publishInputs()
 *                   → gpio-bridge.updateInputState()
 *                     → gpio-sim.setInputValue()
 *                     → Atomics.store() to SharedArrayBuffer
 *
 * RESPONSIBILITIES:
 *   - Translate worker messages ("ON", "OFF", "TOGGLE") into gpio-sim calls
 *   - Manage SharedArrayBuffer writes for input state sync
 *   - Provide clean API for querying pin states
 *   - Act as the single entry point for all GPIO operations
 *
 * DOES NOT:
 *   - Perform circuit analysis (src/electrical does that)
 *   - Manage LED visuals (SimulatorBridge.updateCircuit handles that)
 *   - Communicate directly with the Web Worker
 */

import {
    writePin,
    readPin,
    setInputValue,
    initPin,
    setDirection,
    setPull,
    isPinHigh,
    resetAll,
    getPinState,
    GPIO_IN,
    GPIO_OUT,
    PULL_NONE,
    PULL_UP,
    PULL_DOWN
} from './gpio-sim.js';
import { debug } from '../ui/panels/serial-output.js';
import { FLOATING } from '../worker-protocol/pin-levels.js';
import { COMMAND } from '../worker-protocol/protocol.js';

// Re-export constants so consumers only need to import from the bridge
export { GPIO_IN, GPIO_OUT, PULL_NONE, PULL_UP, PULL_DOWN };

// Prevents writing the identical value to the shared buffer twice.
// Cleared whenever a new shared buffer is created (see initSharedMemory).
const lastWrittenPinState = new Map();

// ---------- Pin Initialization ----------

/**
 * Initialize a GPIO pin with direction.
 * Called when the worker reports that a pin was created or initialised.
 * Ensures gpio-sim marks the pin as initialized so the state inspector
 * can display it.
 *
 * @param {number} pin — GPIO number (0–29)
 * @param {number} dir — GPIO_IN (0) or GPIO_OUT (1)
 */
export function initializePin(pin, dir) {
    initPin(pin);
    setDirection(pin, dir);
    debug('gpio-bridge', `Pin GP${pin} initialized as ${dir === GPIO_OUT ? 'OUTPUT' : 'INPUT'}`);
}

/**
 * Record a pin's pull-resistor configuration (PULL_NONE / PULL_UP / PULL_DOWN) in the state engine.
 * Python reports it when it creates the pin; the worker itself applies the pull when reading.
 *
 * @param {number} pin  — GPIO number (0–29)
 * @param {number} pull — PULL_NONE, PULL_UP or PULL_DOWN
 */
export function configurePull(pin, pull) {
    setPull(pin, pull);
}

// ---------- Pin Action Handling ----------

/**
 * Handle a pin output action from the worker.
 * Translates the action names ("ON", "OFF", "TOGGLE") into gpio-sim state changes.
 *
 * @param {number} pin    — GPIO number (0–29)
 * @param {string} action — "ON", "OFF", or "TOGGLE"
 */
export function handlePinAction(pin, action) {
    switch (action) {
        case 'ON':
            writePin(pin, 1);
            break;
        case 'OFF':
            writePin(pin, 0);
            break;
        case 'TOGGLE':
            // Read current output and flip it
            const current = isPinHigh(pin) ? 0 : 1;
            writePin(pin, current);
            break;
        default:
            debug('gpio-bridge', `Unknown action: ${action} for pin ${pin}`);
    }
}

// ---------- Input State Management ----------

/**
 * Update what the circuit drives onto a GPIO input pin, and share it with the firmware worker.
 * Called by SimulatorBridge._publishInputs() after the circuit is solved.
 *
 * The value is stored as `externalDrive` in gpio-sim:
 *   - 0 or 1 = pin is externally driven (wired to ground / to a power rail)
 *   - null   = pin is floating (nothing drives it)
 *
 * The worker receives the DRIVE, not the resolved level: floating is sent as FLOATING and the
 * worker applies the pin's own pull resistor, which it knows about before the main thread does.
 *
 * @param {number} pin            — GPIO number (0–29)
 * @param {number|null} value     — 0 or 1 (driven), or null (floating)
 * @param {Int32Array|null} sharedPins — SharedArrayBuffer view (for Atomics)
 * @param {Worker|null} worker    — fallback: post message to worker
 */
export function updateInputState(pin, value, sharedPins, worker) {
    // Update the state engine (sets externalDrive)
    setInputValue(pin, value);

    const shared = (value === null || value === undefined) ? FLOATING : (value ? 1 : 0);

    if (sharedPins) {
        if (lastWrittenPinState.get(pin) !== shared) {
            Atomics.store(sharedPins, pin, shared);
            lastWrittenPinState.set(pin, shared);
        }
    } else if (worker) {
        // Fallback for browsers without SharedArrayBuffer
        if (lastWrittenPinState.get(pin) !== shared) {
            worker.postMessage({
                type: COMMAND.PIN_INPUT,
                pin: pin,
                value: shared
            });
            lastWrittenPinState.set(pin, shared);
        }
    }
}

// ---------- State Queries ----------

/**
 * Check if a GPIO pin's output is currently HIGH.
 *
 * @param {number} pin — GPIO number (0–29)
 * @returns {boolean}
 */
export function isOutputHigh(pin) {
    return isPinHigh(pin);
}

/**
 * Get the full state of a pin (for debugging / watch panels).
 *
 * @param {number} pin — GPIO number (0–29)
 * @returns {object|null}
 */
export function queryPinState(pin) {
    return getPinState(pin);
}

// ---------- Lifecycle ----------

/**
 * Reset all GPIO pins to default state.
 * Called on simulation stop or system reset.
 */
export function resetGpio() {
    resetAll();
}

/**
 * Initialize shared memory for input state sync.
 * Called each time a SharedArrayBuffer is created. Every pin starts FLOATING (nothing drives it)
 * so that a pin's pull resistor, not a hard-coded 1, decides its level until the circuit says otherwise.
 *
 * @param {Int32Array} sharedPins — SharedArrayBuffer view
 */
export function initSharedMemory(sharedPins) {
    lastWrittenPinState.clear();   // a new buffer holds none of the old values
    if (sharedPins) {
        sharedPins.fill(FLOATING);
    }
}
