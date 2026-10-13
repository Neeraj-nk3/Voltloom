/**
 * state-inspector.js — Runtime State Inspector
 *
 * Provides a collapsible panel that displays live simulation state
 * for debugging. Shows GPIO pin states, execution state, PWM slices,
 * WiFi status, and active canvas components.
 *
 * RESPONSIBILITIES:
 *   - Collect state snapshots from sim modules (gpio, pwm, wifi, debugger)
 *   - Render state into the inspector DOM panel
 *   - Schedule async updates via requestAnimationFrame (no perf impact)
 *   - Show/hide panel based on debugger state
 *
 * DOES NOT:
 *   - Modify simulation state
 *   - Block the main thread
 *   - Communicate with the Web Worker
 *
 * UPDATE TRIGGERS:
 *   - Debugger pauses execution
 *   - Step execution occurs
 *   - Firmware state changes (GPIO output)
 */

import { getPinState, readPin, GPIO_OUT, GPIO_IN, PULL_UP, PULL_DOWN } from '../../hardware/gpio-sim.js';
import { getSliceState, getDutyCycle, gpioToSlice, gpioToChannel } from '../../hardware/pwm-sim.js';
import { getStatus as getWifiStatus } from '../../hardware/wifi-sim.js';
import { isExecutionPaused } from '../../debug/debugger.js';
import { escapeHtml } from '../../shared/html.js';
import { partTypeOf } from '../../circuit/part-types.js';
import { icon } from '../icons.js';

// ---------- Module State ----------

let panelElement = null;
let contentElement = null;
let canvasManagerRef = null;
let isVisible = false;
let updateScheduled = false;

// ---------- Initialization ----------

/**
 * Initialize the state inspector.
 * Binds to the DOM panel and stores the CanvasManager reference.
 *
 * @param {HTMLElement} panel — the #state-inspector-panel element
 * @param {object} canvasManager — CanvasManager instance for component info
 */
export function init(panel, canvasManager) {
    panelElement = panel;
    contentElement = panel ? panel.querySelector('#inspector-content') : null;
    canvasManagerRef = canvasManager;
}

// ---------- Visibility ----------

/**
 * Show the inspector panel.
 */
export function show() {
    if (!panelElement) return;
    panelElement.classList.remove('hidden');
    isVisible = true;
    syncToggle();
    scheduleUpdate();
}

/**
 * Hide the inspector panel.
 */
export function hide() {
    if (!panelElement) return;
    panelElement.classList.add('hidden');
    isVisible = false;
    syncToggle();
}

/** Keep the toolbar button's pressed state in step with the panel. */
function syncToggle() {
    const button = document.getElementById('inspector-toggle-btn');
    if (button) button.setAttribute('aria-pressed', String(isVisible));
}

/**
 * Toggle inspector panel visibility.
 */
export function toggle() {
    if (isVisible) {
        hide();
    } else {
        show();
    }
}

/**
 * Check if the inspector is currently visible.
 * @returns {boolean}
 */
export function isInspectorVisible() {
    return isVisible;
}

// ---------- State Collection ----------

/**
 * Collect a full state snapshot from all sim modules.
 * Only includes initialized GPIO pins to avoid clutter.
 *
 * @returns {object} — state snapshot
 */
function collectState() {
    // GPIO states — only initialized pins
    const gpioPins = [];
    for (let i = 0; i < 30; i++) {
        const pin = getPinState(i);
        if (pin && pin.initialized) {
            gpioPins.push({
                pin: i,
                direction: pin.direction === GPIO_OUT ? 'OUT' : 'IN',
                value: readPin(i) === 1 ? 'HIGH' : 'LOW',
                pull: pin.pull === PULL_UP ? 'PULL_UP' : (pin.pull === PULL_DOWN ? 'PULL_DOWN' : 'NONE'),
                outputValue: pin.outputValue,
                externalDrive: pin.externalDrive
            });
        }
    }

    // PWM — only active slices
    const pwmSlices = [];
    for (let i = 0; i < 8; i++) {
        const slice = getSliceState(i);
        if (slice && slice.enabled) {
            pwmSlices.push({
                slice: i,
                wrap: slice.wrap,
                levelA: slice.levels[0],
                levelB: slice.levels[1],
                dutyA: (slice.levels[0] / (slice.wrap + 1) * 100).toFixed(1),
                dutyB: (slice.levels[1] / (slice.wrap + 1) * 100).toFixed(1)
            });
        }
    }

    // WiFi
    const wifi = getWifiStatus();

    // Execution
    const execution = {
        paused: isExecutionPaused(),
    };

    // Active components
    const components = [];
    if (canvasManagerRef && canvasManagerRef.components) {
        canvasManagerRef.components.forEach(c => {
            const descriptor = partTypeOf(c);
            if (descriptor) components.push(descriptor.inspectorEntry(c));
        });
    }

    return { gpioPins, pwmSlices, wifi, execution, components };
}

// ---------- Display Helpers ----------

/**
 * Convert a hex color code to a human-readable color name.
 * @param {string} hex — e.g. '#ef4444'
 * @returns {string} — e.g. 'Red'
 */
function hexToColorName(hex) {
    const colorMap = {
        '#ef4444': 'Red',
        '#22c55e': 'Green',
        '#3b82f6': 'Blue',
        '#facc15': 'Yellow',
        '#f97316': 'Orange',
        '#a855f7': 'Purple',
        '#ec4899': 'Pink',
        '#22d3ee': 'Cyan',
        '#ffffff': 'White',
        '#a3e635': 'Lime'
    };
    const lower = (hex || '').toLowerCase();
    return colorMap[lower] || hex || 'Unknown';
}

/**
 * Format a resistance value with the appropriate unit.
 * @param {number} ohms — resistance in ohms
 * @returns {string} — e.g. '1kΩ', '2.2MΩ', '470Ω'
 */
function formatResistance(ohms) {
    if (ohms >= 1000000) {
        const val = ohms / 1000000;
        return `${val % 1 === 0 ? val : val.toFixed(1)}MΩ`;
    } else if (ohms >= 1000) {
        const val = ohms / 1000;
        return `${val % 1 === 0 ? val : val.toFixed(1)}kΩ`;
    }
    return `${ohms}Ω`;
}

// ---------- Rendering ----------

/**
 * Render the collected state into the inspector panel.
 */
function renderState() {
    if (!contentElement) return;

    const state = collectState();
    let html = '';

    // ── GPIO Section ──
    html += renderSectionHeader('GPIO pins', 'cpu');
    if (state.gpioPins.length === 0) {
        html += `<div class="insp-empty">No initialized pins</div>`;
    } else {
        state.gpioPins.forEach(p => {
            const valueClass = p.value === 'HIGH' ? 'v-high' : 'v-low';
            const dirBadge = p.direction === 'OUT'
                ? '<span class="tag tag--out">OUT</span>'
                : '<span class="tag tag--in">IN</span>';
            html += `
                <div class="insp-row">
                    <span class="insp-row__name"><b>GP${p.pin}</b>${dirBadge}</span>
                    <span class="${valueClass}">${p.value}</span>
                </div>`;
        });
    }

    // ── PWM Section ──
    if (state.pwmSlices.length > 0) {
        html += renderSectionHeader('PWM', 'activity');
        state.pwmSlices.forEach(s => {
            html += `
                <div class="insp-row">
                    <span class="insp-row__name"><b>Slice ${s.slice}</b></span>
                    <span class="insp-row__value">A ${s.dutyA}% · B ${s.dutyB}%</span>
                </div>`;
        });
    }

    // ── Execution Section ──
    html += renderSectionHeader('Execution', 'play');
    const pausedClass = state.execution.paused ? 'v-warn' : 'v-high';
    const pausedText = state.execution.paused ? 'PAUSED' : 'RUNNING';
    html += `
        <div class="insp-row">
            <span class="insp-row__name">Status</span>
            <span class="${pausedClass}">${pausedText}</span>
        </div>`;

    // ── WiFi Section ──
    if (state.wifi.initialized) {
        html += renderSectionHeader('WiFi', 'wifi');
        const connClass = state.wifi.connected ? 'v-high' : 'v-bad';
        const connText = state.wifi.connected ? 'CONNECTED' : 'DISCONNECTED';
        html += `
            <div class="insp-row">
                <span class="insp-row__name">Status</span>
                <span class="${connClass}">${connText}</span>
            </div>`;
        if (state.wifi.connected) {
            html += `
                <div class="insp-row">
                    <span class="insp-row__name">SSID</span>
                    <span class="insp-row__value">${escapeHtml(state.wifi.ssid)}</span>
                </div>
                <div class="insp-row">
                    <span class="insp-row__name">IP</span>
                    <span class="v-info">${escapeHtml(state.wifi.ipAddress)}</span>
                </div>`;
        }
    }

    // ── Components Section ──
    if (state.components.length > 0) {
        html += renderSectionHeader('Parts', 'circuit');
        state.components.forEach(c => {
            let detail = '';
            if (c.type === 'Button') {
                detail = c.pressed
                    ? '<span class="v-bad">PRESSED</span>'
                    : '<span class="v-low">released</span>';
            } else if (c.type === 'Resistor') {
                detail = `<span class="insp-row__value">${formatResistance(c.value)}</span>`;
            } else if (c.type === 'LED') {
                detail = `<span class="insp-row__value">${hexToColorName(c.color)}</span>`;
            }
            html += `
                <div class="insp-row">
                    <span class="insp-row__name">${c.type}</span>
                    ${detail}
                </div>`;
        });
    }

    contentElement.innerHTML = html;
}

/**
 * Render a section header with icon.
 * @param {string} title
 * @param {string} iconName — name of an icon in the sprite (see icons.js)
 * @returns {string} HTML
 */
function renderSectionHeader(title, iconName) {
    return `<div class="insp-section">${icon(iconName, 'icon--sm')}<span>${title}</span></div>`;
}

// ---------- Async Update Scheduling ----------

/**
 * Schedule an asynchronous state update.
 * Uses requestAnimationFrame to avoid blocking simulation.
 * Throttled: only one update per animation frame.
 */
export function scheduleUpdate() {
    if (!isVisible || updateScheduled) return;
    updateScheduled = true;

    requestAnimationFrame(() => {
        updateScheduled = false;
        if (isVisible) {
            renderState();
        }
    });
}

/**
 * Force an immediate state update (used on pause/step events).
 * Still async via rAF but clears any pending schedule.
 */
export function forceUpdate() {
    if (!isVisible) return;
    updateScheduled = false;
    scheduleUpdate();
}
