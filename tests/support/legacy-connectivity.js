/**
 * legacy-connectivity.js — the original graph-walking circuit analysis, kept as a test oracle
 *
 * Before the electrical solver (src/electrical), the app decided "which GPIO drives this LED" and "is this net grounded or
 * powered" by walking the wires breadth-first. The app no longer uses any of it. It is kept here, unchanged in behaviour,
 * because tests/unit/electrical/differential-vs-legacy.test.js compares the new netlist/solver results against this independent
 * implementation on thousands of random circuits, and tests/unit/circuit/wire-registry-and-connectivity.test.js pins its own behaviour.
 *
 * It reads the same wire list as the app (getWires() from src/circuit/wire-registry.js): call syncWires(wires) first.
 */

import { LEFT_PINS, RIGHT_PINS } from '../../src/circuit/board-pin-layout.js';
import { partTypeOfId, isPartOfType, buttonConnectedPins } from '../../src/circuit/part-types.js';
import { getWires, nodesEqual, resolvePinDef, extractGpioNumber } from '../../src/circuit/wire-registry.js';

const ALL_PINS = [...LEFT_PINS, ...RIGHT_PINS];

/**
 * Generate a canonical key for a node (for visited-set operations).
 *
 * @param {object} node — wire endpoint node
 * @returns {string}
 */
export function nodeKey(node) {
    if (node.nodeType === 'gpio') return `gpio_${node.pin}`;
    return `comp_${node.componentId}_${node.pin}`;
}

/**
 * Resolve a GPIO number (0–29) to its Pico pin definition.
 *
 * @param {number} gpNum — GPIO number
 * @returns {object|undefined} — pin definition { pin, label, type }
 */
export function resolveGpioPin(gpNum) {
    return ALL_PINS.find(p => p.label === `GP${gpNum}`);
}

// ─── Component Internal Connections ──────────────────────────────────

/**
 * Returns which pins are internally connected to a given pin on a push button.
 * (The rule lives in the part registry; this name is kept for existing callers and tests.)
 *
 * @param {string} pin — the pin being queried ('1', '2', '3', or '4')
 * @param {boolean} isPressed — whether the button is currently pressed
 * @returns {string[]} — array of connected pin names
 */
export function getButtonConnectedPins(pin, isPressed) {
    return buttonConnectedPins(pin, isPressed);
}

/**
 * Adds internal connections for components to the BFS queue.
 * Handles the "transparency" of components where pins are internally connected:
 * what is joined inside each kind of part is described by the part registry.
 *
 * @param {object} neighbor — the current node being processed
 * @param {array} queue — BFS queue
 * @param {Set} visited — visited set
 * @param {Array} components — component array (for button press state)
 */
function addInternalConnections(neighbor, queue, visited, components) {
    if (neighbor.nodeType !== 'component_pin') return;

    const descriptor = partTypeOfId(neighbor.componentId);
    const component = components.find(c => c.id === neighbor.componentId);
    if (!descriptor || !component) return;

    descriptor.internalLinks(neighbor.pin, component).forEach(otherPin => {
        addNodeIfNotVisited({ ...neighbor, pin: otherPin }, queue, visited);
    });
}

/**
 * Helper to add a node to the BFS queue if not already visited.
 */
function addNodeIfNotVisited(node, queue, visited) {
    const key = nodeKey(node);
    if (!visited.has(key)) {
        visited.add(key);
        queue.push(node);
    }
}

// ─── Unified BFS Traversal ──────────────────────────────────────────

/**
 * Core BFS traversal of the connection graph from a starting node.
 * Walks through wires and component internal connections.
 *
 * @param {object} startNode — starting node
 * @param {Array} components — component array (for internal connections)
 * @param {object} [options] — optional early-termination conditions
 * @param {Function} [options.onGpio] — called with (gpNum, pinDef) for each GPIO found; return true to stop
 * @param {Function} [options.onComponent] — called with (node) for each component_pin; return true to stop
 * @param {Function} [options.onPinDef] — called with (pinDef) for each Pico pin found; return true to stop
 * @returns {object} — { gpios: number[], isGrounded: boolean, hasPower: boolean, terminated: boolean }
 */
function bfsTraverse(startNode, components, options = {}) {
    const queue = [startNode];
    const visited = new Set();
    visited.add(nodeKey(startNode));

    const result = {
        gpios: [],
        isGrounded: false,
        hasPower: false,
        terminated: false
    };

    // Add internal connections for the start node itself
    addInternalConnections(startNode, queue, visited, components);

    while (queue.length > 0) {
        const current = queue.shift();

        // Process GPIO / Pico pins
        if (current.nodeType === 'gpio') {
            const pinDef = resolvePinDef(current.pin);
            if (pinDef) {
                if (pinDef.type === 'Ground') {
                    result.isGrounded = true;
                }
                if (pinDef.type === 'Power') {
                    result.hasPower = true;
                }
                if (pinDef.type === 'GPIO' || pinDef.type === 'ADC0' || pinDef.type === 'ADC1' || pinDef.type === 'ADC2') {
                    const gpNum = extractGpioNumber(pinDef);
                    if (!isNaN(gpNum) && !result.gpios.includes(gpNum)) {
                        result.gpios.push(gpNum);
                    }
                }

                // Early termination callbacks
                if (options.onPinDef && options.onPinDef(pinDef)) {
                    result.terminated = true;
                    return result;
                }
                if (options.onGpio && pinDef.type === 'GPIO') {
                    const gpNum = extractGpioNumber(pinDef);
                    if (!isNaN(gpNum) && options.onGpio(gpNum, pinDef)) {
                        result.terminated = true;
                        return result;
                    }
                }
            }
        }

        // Early termination for component_pin
        if (current.nodeType === 'component_pin' && options.onComponent) {
            if (options.onComponent(current)) {
                result.terminated = true;
                return result;
            }
        }

        // Traverse wires to find neighbors
        getWires().forEach(w => {
            let neighbor = null;

            if (nodesEqual(w.start, current)) neighbor = w.end;
            else if (nodesEqual(w.end, current)) neighbor = w.start;

            if (neighbor) {
                const key = nodeKey(neighbor);
                if (!visited.has(key)) {
                    visited.add(key);
                    queue.push(neighbor);

                    // Handle component internal connections
                    addInternalConnections(neighbor, queue, visited, components);
                }
            }
        });
    }

    return result;
}

// ─── Public Circuit Analysis API ─────────────────────────────────────

/**
 * Analyzes the electrical net connected to a component pin.
 * Finds connected GPIOs and checks if the net is grounded.
 *
 * Replaces SimulatorBridge.analyzeNet()
 *
 * @param {string} componentId — the component's ID
 * @param {string} pin — the pin name/number
 * @param {Array} components — component array
 * @returns {object} — { gpios: number[], isGrounded: boolean, hasPower: boolean }
 */
export function analyzeNet(componentId, pin, components) {
    const startNode = { nodeType: 'component_pin', componentId, pin };
    const result = bfsTraverse(startNode, components);
    return {
        gpios: result.gpios,
        isGrounded: result.isGrounded,
        hasPower: result.hasPower
    };
}

/**
 * Analyzes the electrical net that a GPIO pin is wired into (through wires, resistors and
 * closed buttons) and reports whether that net reaches a ground pin and/or a power rail.
 *
 * @param {number} gpNum — GPIO number (0–29)
 * @param {Array} components — component array
 * @returns {object} — { gpios: number[], isGrounded: boolean, hasPower: boolean }
 */
export function analyzeGpioNet(gpNum, components) {
    const pinDef = resolveGpioPin(gpNum);
    if (!pinDef) return { gpios: [], isGrounded: false, hasPower: false };
    const result = bfsTraverse({ nodeType: 'gpio', pin: pinDef.pin }, components);
    return { gpios: result.gpios, isGrounded: result.isGrounded, hasPower: result.hasPower };
}

/**
 * What a net drives onto an input pin attached to it.
 *   ground reached           -> 0
 *   else power rail reached  -> 1
 *   neither (open circuit)   -> null (floating: the pin's own pull resistor decides)
 * A net that reaches both is a short; ground wins.
 * Other GPIOs driving the same net are not modelled yet.
 *
 * @param {{isGrounded: boolean, hasPower: boolean}} net
 * @returns {0|1|null}
 */
export function netDrive(net) {
    if (net.isGrounded) return 0;
    if (net.hasPower) return 1;
    return null;
}

/**
 * Checks if a component pin is connected to a target type (Power or Ground).
 * Also handles GPIO-as-Power (output HIGH).
 *
 * Replaces SimulatorBridge.checkConnection()
 *
 * @param {string} componentId — the component's ID
 * @param {string} pin — the pin name/number
 * @param {string} targetType — 'Power' or 'Ground'
 * @param {Array} components — component array
 * @param {Function} isOutputHighFn — function(gpNum) => boolean, checks if GPIO is outputting HIGH
 * @param {boolean} workerActive — whether a worker is running (needed for Power check)
 * @returns {boolean}
 */
export function checkConnection(componentId, pin, targetType, components, isOutputHighFn, workerActive) {
    const startNode = { nodeType: 'component_pin', componentId, pin };

    let found = false;
    bfsTraverse(startNode, components, {
        onPinDef: (pinDef) => {
            if (targetType === 'Ground' && pinDef.type === 'Ground') {
                found = true;
                return true; // stop
            }
            if (targetType === 'Power') {
                if (!workerActive) return false;
                if (pinDef.type === 'Power') {
                    found = true;
                    return true; // stop
                }
                if (pinDef.type === 'GPIO') {
                    const gpNum = extractGpioNumber(pinDef);
                    if (!isNaN(gpNum) && isOutputHighFn(gpNum)) {
                        found = true;
                        return true; // stop
                    }
                }
            }
            return false;
        }
    });

    return found;
}

/**
 * BFS from a GPIO pin to check if it reaches a component of the given type.
 * Traverses wires and passes through resistors/buttons.
 *
 * Replaces SimulatorBridge._isGpioConnectedTo()
 *
 * @param {number} gpNum — GPIO number (0–29)
 * @param {string} partType — registry type name ('led', 'button', ...)
 * @param {Array} components — component array
 * @returns {boolean}
 */
export function isGpioConnectedTo(gpNum, partType, components) {
    const pinDef = resolveGpioPin(gpNum);
    if (!pinDef) return false;

    const startNode = { nodeType: 'gpio', pin: pinDef.pin };

    let found = false;
    bfsTraverse(startNode, components, {
        onComponent: (node) => {
            if (node.componentId && isPartOfType(node.componentId, partType)) {
                found = true;
                return true; // stop
            }
            return false;
        }
    });

    return found;
}

/**
 * Find the GPIO pin number driving an LED's anode.
 * Traces from the LED's anode (pin 'A') through wires to find the GPIO.
 *
 * Replaces SimulatorBridge.findDrivingGpio()
 *
 * @param {string} ledId — LED component ID
 * @param {Array} components — component array
 * @returns {number|null} — GPIO number (0–29), or null if not connected
 */
export function findDrivingGpio(ledId, components) {
    const startNode = { nodeType: 'component_pin', componentId: ledId, pin: 'A' };

    let gpioNum = null;
    bfsTraverse(startNode, components, {
        onGpio: (gpNum) => {
            gpioNum = gpNum;
            return true; // stop at first GPIO
        }
    });

    return gpioNum;
}
