/**
 * wire-registry.js — the registry of wires the user has drawn
 *
 * The one list of wires that the rest of the app consults: the canvas adds and removes wires here, the simulator bridge
 * reads it to build the circuit, and the circuit validator checks it for duplicates. DOM-free.
 *
 * RESPONSIBILITIES:
 *   - Wire registry (add, remove, query, duplicate prevention)
 *   - Pin definition helpers (physical pin / GPIO number lookups on the board's pin table)
 *   - Validation of a new connection (self-connection, duplicate)
 *   - Disconnect cleanup callback
 *
 * DOES NOT:
 *   - Touch the DOM or render wires (WireInteractionManager does that)
 *   - Solve the circuit (src/electrical does that)
 *   - Manage GPIO pin state (gpio-sim.js does that)
 *
 * The earlier graph-walking analysis (which nets reach ground/power, which GPIO drives an LED) is no longer part of the
 * app. It is kept as a test oracle in tests/support/legacy-connectivity.js, which the differential tests compare the
 * electrical engine against.
 *
 * DATA FLOW:
 *   WireInteractionManager.createWire() → addWire()
 *   WireInteractionManager.deleteWire() → removeWire() → onWireRemoved callback
 *   CanvasManager / SimulatorBridge     → syncWires() (the canvas owns the array; this module holds a reference to it)
 */

import { LEFT_PINS, RIGHT_PINS } from './board-pin-layout.js';

// ─── Wire Registry ───────────────────────────────────────────────────

/**
 * Internal wire store — the single source of truth for all connections.
 * Each wire: { id, start: node, end: node, color, ... }
 * Node format: { nodeType: 'gpio'|'component_pin', pin, componentId? }
 */
let wires = [];

/**
 * Callback fired when a wire is removed.
 * Signature: onWireRemovedCallback(removedWire)
 * SimulatorBridge registers this to reset GPIO input states.
 */
let onWireRemovedCallback = null;

/**
 * Register a callback for wire removal events.
 * @param {Function} callback — function(removedWire)
 */
export function setOnWireRemoved(callback) {
    onWireRemovedCallback = callback;
}

/**
 * Add a wire to the registry.
 * Rejects duplicates (same start+end in either order).
 *
 * @param {object} wire — wire object { id, start, end, color, ... }
 * @returns {boolean} true if added, false if duplicate
 */
export function addWire(wire) {
    if (isDuplicate(wire.start, wire.end)) {
        console.warn('[WireRegistry] Duplicate wire rejected:', wire.id);
        return false;
    }
    wires.push(wire);
    return true;
}

/**
 * Remove a wire from the registry by ID.
 * Triggers the onWireRemoved callback for cleanup.
 *
 * @param {string} wireId — wire ID to remove
 * @returns {object|null} the removed wire, or null if not found
 */
export function removeWire(wireId) {
    const idx = wires.findIndex(w => w.id === wireId);
    if (idx === -1) return null;

    const removed = wires[idx];
    wires.splice(idx, 1);

    // Notify listeners for cleanup (e.g., reset GPIO states)
    if (onWireRemovedCallback) {
        onWireRemovedCallback(removed);
    }

    return removed;
}

/**
 * Get all registered wires.
 * @returns {Array} — array of wire objects
 */
export function getWires() {
    return wires;
}

/**
 * Sync the registry with an external wire array.
 * Used during initialization/restore when wires already exist in CanvasManager.
 *
 * @param {Array} externalWires — array of wire objects to sync from
 */
export function syncWires(externalWires) {
    wires = externalWires;
}

/**
 * Check if a wire between two nodes already exists.
 * Checks both directions (start↔end).
 *
 * @param {object} start — start node
 * @param {object} end — end node
 * @returns {boolean}
 */
export function isDuplicate(start, end) {
    return wires.some(w =>
        (nodesEqual(w.start, start) && nodesEqual(w.end, end)) ||
        (nodesEqual(w.start, end) && nodesEqual(w.end, start))
    );
}

/**
 * Check equality between two wire endpoint nodes.
 *
 * @param {object} n1 — first node
 * @param {object} n2 — second node
 * @returns {boolean}
 */
export function nodesEqual(n1, n2) {
    if (n1.nodeType !== n2.nodeType) return false;
    if (n1.nodeType === 'component_pin') {
        return n1.componentId === n2.componentId && n1.pin === n2.pin;
    }
    if (n1.nodeType === 'gpio') {
        return n1.pin === n2.pin;
    }
    return false;
}

// ─── Pin Definition Helpers ──────────────────────────────────────────

const ALL_PINS = [...LEFT_PINS, ...RIGHT_PINS];

/**
 * Resolve a physical pin number to its definition.
 *
 * @param {number|string} pinNumber — physical pin number (1–40)
 * @returns {object|undefined} — pin definition { pin, label, type }
 */
export function resolvePinDef(pinNumber) {
    return ALL_PINS.find(p => p.pin == pinNumber);
}

/**
 * Extract GPIO number from a pin definition label (e.g., 'GP15' → 15).
 *
 * @param {object} pinDef — pin definition with label
 * @returns {number|NaN}
 */
export function extractGpioNumber(pinDef) {
    return parseInt(pinDef.label.replace('GP', ''));
}

// ─── Validation Layer ────────────────────────────────────────────────

/**
 * Validates whether a new wire connection is acceptable.
 * Checks for self-connection and duplicates; electrical validity is handled by WireInteractionManager.isValidConnection().
 *
 * @param {object} start — start node
 * @param {object} end — end node
 * @returns {object} — { valid: boolean, reason: string }
 */
export function validateWire(start, end) {
    // Self-connection
    if (nodesEqual(start, end)) {
        return { valid: false, reason: 'Cannot connect a pin to itself.' };
    }

    // Duplicate check
    if (isDuplicate(start, end)) {
        return { valid: false, reason: 'A wire already exists between these pins.' };
    }

    return { valid: true, reason: '' };
}
