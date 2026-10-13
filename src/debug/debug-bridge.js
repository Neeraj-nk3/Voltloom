/**
 * debug-bridge.js
 * 
 * Handles communication between UI thread and Worker for the debugger.
 * Uses a SharedArrayBuffer so the worker can pause synchronously (Atomics.wait)
 * without freezing the main UI thread.
 */

// Debug States
export const DEBUG_RUNNING = 0;
export const DEBUG_PAUSED = 1;
export const DEBUG_STEP = 2;

// Shared state array: [STATE, CURRENT_LINE, ...]
let sharedDebugBuffer = null;
let sharedDebugView = null;

let onPausedCallback = null;

/**
 * Initialize the shared buffer for debugger state.
 * @returns {SharedArrayBuffer} The buffer to send to the worker.
 */
export function initDebugState() {
    // 4 ints = 16 bytes: [state, line, reserved, reserved]
    sharedDebugBuffer = new SharedArrayBuffer(16);
    sharedDebugView = new Int32Array(sharedDebugBuffer);

    // Default to running
    Atomics.store(sharedDebugView, 0, DEBUG_RUNNING);
    Atomics.store(sharedDebugView, 1, 0);

    return sharedDebugBuffer;
}

/**
 * Gets the current shared buffer view.
 */
export function getDebugStateView() {
    return sharedDebugView;
}

/**
 * Register a callback when the worker reports it has paused.
 * @param {Function} callback - f(lineNumber)
 */
export function setOnDebugPaused(callback) {
    onPausedCallback = callback;
}

/**
 * Call this when the worker sends a DEBUG_PAUSED message.
 * @param {number} line - The line number it paused at.
 */
export function handleWorkerPaused(line) {
    if (sharedDebugView) {
        Atomics.store(sharedDebugView, 1, line);
    }
    if (onPausedCallback) {
        onPausedCallback(line);
    }
}

/**
 * Set the execution state (RUNNING, PAUSED, STEP).
 * If transitioning from PAUSED -> RUNNING/STEP, this unblocks the worker.
 * @param {number} state - DEBUG_RUNNING, DEBUG_PAUSED, or DEBUG_STEP
 */
export function setDebugCommand(state) {
    if (!sharedDebugView) return;

    const oldState = Atomics.load(sharedDebugView, 0);
    Atomics.store(sharedDebugView, 0, state);

    // If the worker was paused (waiting), wake it up
    if (oldState === DEBUG_PAUSED && (state === DEBUG_RUNNING || state === DEBUG_STEP)) {
        Atomics.notify(sharedDebugView, 0, 1);
    }
}
