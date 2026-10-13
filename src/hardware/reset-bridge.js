/**
 * reset-bridge.js — Reset Bridge Layer (Public API)
 *
 * This is the ONLY module that simulator-bridge.js and other parts of
 * the simulator should call for reset operations.
 *
 * DATA FLOW:
 *   SimulatorBridge.restart()  → reset-bridge.performReset()
 *                                  → reset-sim.simReset()
 *                                    → gpio-sim.resetAll()
 *                                    → pwm-sim.resetAll()
 *                                    → wifi-sim.resetAll()
 *                                    → serial-monitor.reset()
 *
 *   A reset the PROGRAM asks for (machine.reset(), watchdog_reboot(), reset_usb_boot()) reaches the page as a worker event;
 *   SimulatorBridge.restart() then calls performReset() and starts the same program again.
 *
 * RESPONSIBILITIES:
 *   - Provide SDK-named reset functions
 *   - Provide high-level performReset() for SimulatorBridge
 *   - Log reset events to serial monitor
 *   - Shield consumers from internal reset orchestration
 *
 * DOES NOT:
 *   - Terminate or spawn workers (SimulatorBridge does that)
 *   - Manage UI state (LEDs, buttons)
 *   - Touch the filesystem
 */

import {
    simReset,
    getResetState,
    getResetLabel,
    wasWatchdogReset,
    RESET_SOFT,
    RESET_WATCHDOG,
    RESET_POWER_CYCLE
} from './reset-sim.js';
import { debug } from '../ui/panels/serial-output.js';

// Re-export constants so consumers only need to import from the bridge
export { RESET_SOFT, RESET_WATCHDOG, RESET_POWER_CYCLE };

// ---------- High-Level Reset API ----------

/**
 * Perform a reset of all volatile hardware state.
 * This is the primary entry point for SimulatorBridge.
 *
 * Clears GPIO, PWM, WiFi and serial init state.
 * Does NOT clear filesystem (flash survives resets).
 * Does NOT terminate the worker (SimulatorBridge handles that).
 *
 * @param {number} type — RESET_SOFT, RESET_WATCHDOG, or RESET_POWER_CYCLE
 * @returns {object} — { type, label, resetCount }
 */
export function performReset(type) {
    const label = getResetLabel(type);
    debug('reset-bridge', `Initiating ${label}...`);

    const result = simReset(type);

    debug('reset-bridge', `${label} complete (total: ${result.resetCount})`);
    return result;
}

// ---------- SDK-Named Functions ----------

/**
 * Reset into USB boot mode.
 * Mirrors: reset_usb_boot(uint32_t, uint32_t) from pico/bootrom.h
 *
 * In the simulator, this triggers a soft reset.
 * Parameters are accepted for API compatibility but ignored.
 *
 * @param {number} usbActivityGpioPinMask — ignored in simulator
 * @param {number} disableInterfaceMask   — ignored in simulator
 */
export function reset_usb_boot(usbActivityGpioPinMask, disableInterfaceMask) {
    debug('reset-bridge', 'reset_usb_boot() called — triggering soft reset');
    return performReset(RESET_SOFT);
}

/**
 * Trigger a watchdog reboot.
 * Mirrors: watchdog_reboot(uint32_t pc, uint32_t sp, uint32_t delay_ms)
 *          from hardware/watchdog.h
 *
 * In the simulator, this triggers an immediate watchdog-style reset.
 * Parameters are accepted for API compatibility but ignored.
 *
 * @param {number} pc       — ignored in simulator
 * @param {number} sp       — ignored in simulator
 * @param {number} delayMs  — ignored in simulator (instant reset)
 */
export function watchdog_reboot(pc, sp, delayMs) {
    debug('reset-bridge', `watchdog_reboot() called (delay_ms=${delayMs}) — triggering watchdog reset`);
    return performReset(RESET_WATCHDOG);
}

/**
 * Check if the last reboot was caused by the watchdog.
 * Mirrors: watchdog_caused_reboot() from hardware/watchdog.h
 *
 * @returns {boolean}
 */
export function watchdog_caused_reboot() {
    return wasWatchdogReset();
}

// ---------- Queries ----------

/**
 * Get the current reset state for diagnostics.
 *
 * @returns {object} — { resetCount, lastResetType, lastResetTime }
 */
export function queryResetState() {
    return getResetState();
}

// ---------- Lifecycle ----------

/**
 * Reset the reset module's own state.
 * This module is intentionally stateless (state lives in reset-sim),
 * so this is a no-op. Included for consistency with other bridges.
 */
export function resetResetState() {
    // No-op — reset-sim tracks its own state.
    // We don't clear the reset counter on stop; it's session-wide.
}
