/**
 * circuit-validator.js — Circuit Validation Engine
 *
 * Provides functions to analyze the simulation graph and detect:
 *  - Duplicate wires
 *  - Floating pins (components missing power or ground)
 *  - Unsupported links (e.g. invalid port types)
 *
 * Warnings are sent to the serial monitor without crashing simulation.
 */

import { printWarning } from '../ui/panels/serial-output.js';
import { partTypeOf } from './part-types.js';

/**
 * Validates a new wire before it is added to the canvas.
 * Prevents visually overlapping/duplicate wires between the same two endpoints.
 * 
 * @param {object} newWire - The proposed wire { start, end }
 * @param {Array} existingWires - Array of current wires
 * @returns {boolean} True if wire is valid and should be added, false otherwise
 */
export function validateNewWire(newWire, existingWires) {
    if (!newWire || !newWire.start || !newWire.end) return false;

    // A wire shouldn't connect a node to itself
    if (nodesMatch(newWire.start, newWire.end)) {
        return false;
    }

    // Check for duplicate wires (A to B, or B to A)
    const isDuplicate = existingWires.some(wire => {
        const matchesA = nodesMatch(wire.start, newWire.start) && nodesMatch(wire.end, newWire.end);
        const matchesB = nodesMatch(wire.start, newWire.end) && nodesMatch(wire.end, newWire.start);
        return matchesA || matchesB;
    });

    if (isDuplicate) {
        // We log locally but don't print to serial here since it's a UI action
        console.warn('CircuitValidator: Prevented duplicate wire.');
        return false;
    }

    return true;
}

/**
 * Validates the entire circuit state at simulation startup.
 * Detects floating components and prints warnings to the serial monitor.
 * 
 * @param {Array} components - All canvas components
 * @param {Array} wires - All canvas wires
 */
export function validateCircuit(components, wires) {
    let warningsFound = 0;

    components.forEach(comp => {
        // What counts as a badly wired pin is part-specific and lives in the part registry.
        const descriptor = partTypeOf(comp);
        if (!descriptor) return;
        descriptor.floatingWarnings(comp, connectedPins(comp.id, wires)).forEach(message => {
            printWarning(message);
            warningsFound++;
        });
    });

    if (warningsFound > 0) {
        console.warn(`CircuitValidator: Found ${warningsFound} circuit warnings.`);
    }
}

// --- Helpers ---

/** Check if two port objects represent the exact same physical endpoint */
function nodesMatch(n1, n2) {
    if (!n1 || !n2) return false;
    if (n1.nodeType !== n2.nodeType) return false;
    
    if (n1.nodeType === 'gpio') {
        return n1.pin === n2.pin;
    } else if (n1.nodeType === 'component_pin') {
        return n1.componentId === n2.componentId && n1.pin === n2.pin;
    }
    return false;
}

/**
 * Which pins of a component have a wire, and how many wire ends touch it.
 * @returns {{pins: Set<string>, count: number}}
 */
function connectedPins(componentId, wires) {
    const pins = new Set();
    let count = 0;
    wires.forEach(w => {
        [w.start, w.end].forEach(node => {
            if (node.nodeType === 'component_pin' && node.componentId === componentId) {
                pins.add(node.pin);
                count++;
            }
        });
    });
    return { pins, count };
}
