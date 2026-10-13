/**
 * debugger.js
 * 
 * UI-side debugger controller. Maintains breakpoints and execution state,
 * and translates UI actions into debug-bridge commands.
 */

import {
    setDebugCommand,
    DEBUG_RUNNING,
    DEBUG_PAUSED,
    DEBUG_STEP
} from './debug-bridge.js';
import { printSystem } from '../ui/panels/serial-output.js';

let isPaused = false;
let stepMode = false;
const breakpoints = new Set();

let uiUpdateCallback = null;
let stateChangeCallback = null;

/**
 * Set a callback to update debugger UI elements (e.g. highlight line).
 */
export function setDebuggerUICallback(callback) {
    uiUpdateCallback = callback;
}

/**
 * Set a callback for state change events (pause/resume/step).
 * Used by the state inspector for async updates.
 */
export function setOnStateChange(callback) {
    stateChangeCallback = callback;
}

/**
 * Called by the bridge when the worker hits a checkpoint and blocks.
 */
export function onDebuggerHit(line) {
    isPaused = true;
    stepMode = false;

    printSystem(`[Debugger] Paused at line ${line}`);

    if (uiUpdateCallback) {
        uiUpdateCallback({ paused: true, line });
    }
    if (stateChangeCallback) {
        stateChangeCallback('paused');
    }
}

/**
 * Pause execution as soon as the next checkpoint is reached.
 */
export function pauseExecution() {
    isPaused = true;
    printSystem('[Debugger] Pausing execution...');
    setDebugCommand(DEBUG_PAUSED);

    if (uiUpdateCallback) {
        uiUpdateCallback({ paused: true, line: null });
    }
    if (stateChangeCallback) {
        stateChangeCallback('paused');
    }
}

/**
 * Resume execution fully.
 */
export function resumeExecution() {
    isPaused = false;
    stepMode = false;
    printSystem('[Debugger] Resuming execution...');
    setDebugCommand(DEBUG_RUNNING);

    if (uiUpdateCallback) {
        uiUpdateCallback({ paused: false, line: null });
    }
    if (stateChangeCallback) {
        stateChangeCallback('resumed');
    }
}

/**
 * Execute a single step (run to next checkpoint, then pause again).
 */
export function stepExecution() {
    if (!isPaused) return; // Only makes sense if already paused

    stepMode = true;
    printSystem('[Debugger] Stepping...');

    // Tell bridge to wake worker but in step mode
    setDebugCommand(DEBUG_STEP);

    if (uiUpdateCallback) {
        uiUpdateCallback({ paused: false, line: null }); // Temporarily unpause UI
    }
    if (stateChangeCallback) {
        stateChangeCallback('step');
    }
}

/**
 * Toggle a breakpoint at a specific line number.
 * @param {number} line 
 * @returns {boolean} true if added, false if removed
 */
export function toggleBreakpoint(line) {
    if (breakpoints.has(line)) {
        breakpoints.delete(line);
        printSystem(`[Debugger] Breakpoint removed from line ${line}`);
        return false;
    } else {
        breakpoints.add(line);
        printSystem(`[Debugger] Breakpoint added at line ${line}`);
        return true;
    }
}

/**
 * Get the current set of breakpoints.
 * @returns {Set<number>}
 */
export function getBreakpoints() {
    return breakpoints;
}

/**
 * Check if the debugger is currently paused.
 */
export function isExecutionPaused() {
    return isPaused;
}

/**
 * Reset debugger state (called when simulation stops or restarts).
 */
export function resetDebugger() {
    isPaused = false;
    stepMode = false;
    setDebugCommand(DEBUG_RUNNING);

    if (uiUpdateCallback) {
        uiUpdateCallback({ paused: false, line: null });
    }
    if (stateChangeCallback) {
        stateChangeCallback('reset');
    }
}
