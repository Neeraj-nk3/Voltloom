/**
 * serial-monitor.js — Serial Output Engine
 *
 * This is the core serial output simulation for Voltloom.
 * It manages all text output that appears in the Serial Monitor panel.
 *
 * RESPONSIBILITIES:
 *   - Render formatted output lines to the Serial Monitor DOM element
 *   - Support multiple output types: info, error, system
 *   - Track initialization state (mirrors stdio_init_all behavior)
 *   - Provide clear/reset functionality
 *
 * DOES NOT:
 *   - Communicate with the Web Worker
 *   - Handle GPIO or any other peripheral
 *   - Manage the Serial Monitor UI layout (that stays in index.html)
 *
 * This module is the "truth" for serial output rendering.
 * All output to the Serial Monitor MUST go through this module.
 */

// ---------- State ----------

/**
 * Reference to the Serial Monitor DOM element (#output).
 * Set via init(). All output is appended here.
 */
let outputElement = null;

/**
 * Whether stdio has been initialized.
 * Mirrors the real Pico SDK requirement that stdio_init_all()
 * must be called before printf/puts work.
 */
let initialized = false;

// ---------- Initialization ----------

/**
 * Initialize the serial output engine.
 * Binds to the Serial Monitor DOM element.
 *
 * @param {HTMLElement} element — the #output DOM element
 */
export function init(element) {
    outputElement = element;
    initialized = true;
}

/**
 * Check if the serial engine is initialized.
 *
 * @returns {boolean}
 */
export function isInitialized() {
    return initialized && outputElement !== null;
}

// ---------- Output Rendering ----------

/** Most lines kept in the console; older lines are discarded. */
export const MAX_LINES = 1000;

// Lines are queued and drawn once per short interval. A program printing in a tight loop therefore
// costs one DOM update per interval (of at most MAX_LINES lines), not one per printed line.
const RENDER_INTERVAL_MS = 16;
let queue = [];
let renderTimer = null;

/**
 * Write a line of text to the Serial Monitor.
 * This is the single entry point — all output goes through here.
 *
 * @param {string} text — the text to display
 * @param {string} type — "info" | "error" | "system"
 */
export function write(text, type = 'info') {
    if (!outputElement) return;
    queue.push({ text, type, time: new Date() });
    if (renderTimer === null) renderTimer = setTimeout(flushQueue, RENDER_INTERVAL_MS);
}

function flushQueue() {
    renderTimer = null;
    if (!outputElement) { queue = []; return; }
    const items = queue.length > MAX_LINES ? queue.slice(-MAX_LINES) : queue;   // older ones would be trimmed anyway
    queue = [];
    items.forEach(renderLine);
    while (outputElement.childElementCount > MAX_LINES) {
        outputElement.removeChild(outputElement.firstElementChild);
    }
    outputElement.scrollTop = outputElement.scrollHeight;
}

function renderLine({ text, type, time }) {
    const div = document.createElement('div');
    const kind = type === 'error' || type === 'warning' || type === 'system' ? type : 'info';
    div.className = `line line--${kind}`;

    const timestamp = time.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    // The tag says what kind of line it is; colour is only reinforcement (see .line--* in panels.css)
    const labelText = kind === 'error' ? '[Error]' : kind === 'warning' ? '[Warning]' : kind === 'system' ? '[System]' : `[${timestamp}]`;

    // Program output is untrusted: build text nodes, never parse it as HTML.
    const label = document.createElement('span');
    label.className = 'line__tag';
    label.textContent = labelText;

    const body = document.createElement('span');
    body.className = 'line__text';
    body.textContent = String(text);

    div.append(label, body);
    outputElement.appendChild(div);
}

// ---------- Lifecycle ----------

/**
 * Clear all output from the Serial Monitor.
 */
export function clear() {
    queue = [];
    if (outputElement) {
        outputElement.innerHTML = '';
    }
}

/**
 * Reset the serial engine.
 * Clears output and resets initialization state.
 * Called on simulation stop or system reset.
 */
export function reset() {
    initialized = false;
}
