/**
 * part-types.js — the part registry (DOM-free)
 *
 * Every kind of circuit part (LED, resistor, push button) is described ONCE here. Code that needs
 * to know "what is this part?" asks the registry instead of looking at the id text
 * (`id.startsWith('led_')`). Adding a new part type means adding one descriptor.
 *
 * A descriptor holds everything that is true of the part regardless of how it is drawn:
 *   type / idPrefix     'led' and the id prefix in "led_1700000000000"
 *   pins                pin names, in order
 *   role                how the circuit engine will treat it: 'diode' | 'resistor' | 'switch'
 *   pinKind(pin)        polarity class used by the wire-validity rules ('Anode' | 'Cathode' | 'Passive')
 *   internalLinks(...)  pins that are joined inside the part (button contacts, resistor ends)
 *   defaults()/restore  the fields a part has when created / rebuilt from a saved project
 *   serializeFields     what is saved to a project; validateFields checks an imported project
 *   inspectorEntry      what the state inspector shows
 *   floatingWarnings    the circuit-validator warnings for badly wired pins
 *   diagram             how the part appears in the exported diagram.json view
 *
 * How a part LOOKS (SVG, pin positions, popup controls) lives in the view layer
 * (src/ui/parts/part-views.js), keyed by the same type name.
 */

// ---------------------------------------------------------------------------------------------
// shared validation helpers (the messages are part of the project-import contract)
// ---------------------------------------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const RESISTOR_UNITS = [1, 1000, 1000000];
const DEFAULT_LED_COLOR = '#ef4444';

// ---------------------------------------------------------------------------------------------
// LED
// ---------------------------------------------------------------------------------------------

const led = {
    type: 'led',
    idPrefix: 'led',
    pins: ['A', 'C'],
    role: 'diode',

    pinKind: (pin) => (pin === 'A' ? 'Anode' : pin === 'C' ? 'Cathode' : 'Unknown'),
    internalLinks: () => [],

    restore: (data = {}) => ({
        color: data.color || DEFAULT_LED_COLOR,
        flipped: data.flipped || false,
        value: 0,
        unit: 0
    }),
    defaults() { return this.restore({}); },

    serializeFields: (c) => ({ color: c.color || DEFAULT_LED_COLOR, flipped: c.flipped || false }),

    validateFields(raw, where, errors) {
        const color = raw.color === undefined ? DEFAULT_LED_COLOR : raw.color;
        if (typeof color !== 'string' || !HEX_COLOR.test(color)) { errors.push(`${where}: color must be #rrggbb`); return null; }
        if (raw.flipped !== undefined && typeof raw.flipped !== 'boolean') { errors.push(`${where}: flipped must be boolean`); return null; }
        return { color: color.toLowerCase(), flipped: raw.flipped === true };
    },

    inspectorEntry: (c) => ({ type: 'LED', id: c.id, color: c.color || 'red' }),

    floatingWarnings(c, connected) {
        const hasAnode = connected.pins.has('A');
        const hasCathode = connected.pins.has('C');
        if (hasAnode && !hasCathode) return ['Warning: Floating LED cathode detected. Consider wiring it to GND.'];
        if (!hasAnode && hasCathode) return ['Warning: Floating LED anode detected. Consider wiring it to a GPIO or VBUS.'];
        return [];
    },

    diagram: { type: 'led', idPrefix: 'led', attrs: () => ({ color: 'red' }) }
};

// ---------------------------------------------------------------------------------------------
// Resistor
// ---------------------------------------------------------------------------------------------

const resistor = {
    type: 'resistor',
    idPrefix: 'res',
    pins: ['1', '2'],
    role: 'resistor',

    pinKind: () => 'Passive',
    internalLinks: (pin) => [pin === '1' ? '2' : '1'],

    restore: (data = {}) => ({ value: data.value || 1, unit: data.unit || 1000 }),
    defaults() { return this.restore({}); },

    serializeFields: (c) => ({ value: c.value, unit: c.unit }),

    validateFields(raw, where, errors) {
        const value = raw.value === undefined ? 1 : raw.value;
        const unit = raw.unit === undefined ? 1000 : raw.unit;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9) { errors.push(`${where}: value must be a number between 0 and 1e9`); return null; }
        if (!RESISTOR_UNITS.includes(unit)) { errors.push(`${where}: unit must be 1, 1000 or 1000000`); return null; }
        return { value, unit };
    },

    inspectorEntry: (c) => ({ type: 'Resistor', id: c.id, value: (c.value || 0) * (c.unit || 1) }),

    floatingWarnings(c, connected) {
        const hasPin1 = connected.pins.has('1');
        const hasPin2 = connected.pins.has('2');
        if ((hasPin1 && !hasPin2) || (!hasPin1 && hasPin2)) {
            return [`Warning: Resistor ${c.id.replace('res_', '')} has a floating pin. Resistors must be connected in-line with a circuit.`];
        }
        return [];
    },

    diagram: { type: 'resistor', idPrefix: 'res', attrs: (c) => ({ value: c.value.toString() }) }
};

// ---------------------------------------------------------------------------------------------
// Push button (4 pins: 1-2 are one contact, 3-4 the other; pressing joins the contacts)
// ---------------------------------------------------------------------------------------------

const TOP_PINS = ['1', '2'];
const BOTTOM_PINS = ['3', '4'];

/**
 * Pins that are connected to `pin` inside a push button.
 *   Pins 1 and 2 are always connected (top row); pins 3 and 4 are always connected (bottom row).
 *   When pressed, the two rows are joined and all four pins are connected.
 *
 * @param {string} pin — '1' | '2' | '3' | '4'
 * @param {boolean} isPressed
 * @returns {string[]}
 */
export function buttonConnectedPins(pin, isPressed) {
    const connected = [];
    if (TOP_PINS.includes(pin)) connected.push(...TOP_PINS.filter((p) => p !== pin));
    else if (BOTTOM_PINS.includes(pin)) connected.push(...BOTTOM_PINS.filter((p) => p !== pin));

    if (isPressed) {
        if (TOP_PINS.includes(pin)) connected.push(...BOTTOM_PINS);
        else if (BOTTOM_PINS.includes(pin)) connected.push(...TOP_PINS);
    }
    return connected;
}

const button = {
    type: 'button',
    idPrefix: 'btn',
    pins: ['1', '2', '3', '4'],
    role: 'switch',

    pinKind: () => 'Passive',
    internalLinks: (pin, component) => buttonConnectedPins(pin, !!(component && component.isPressed)),

    restore: () => ({ isPressed: false }),
    defaults() { return this.restore(); },

    serializeFields: () => ({}),                 // the pressed state is runtime-only, never saved
    validateFields: () => ({}),

    inspectorEntry: (c) => ({ type: 'Button', id: c.id, pressed: !!c.isPressed }),

    floatingWarnings(c, connected) {
        if (connected.count === 1) {
            return [`Warning: Button ${c.id.replace('btn_', '')} is only connected on one side. It will not form a complete circuit.`];
        }
        return [];
    },

    diagram: { type: 'push-button', idPrefix: 'btn', attrs: () => ({}) }
};

// ---------------------------------------------------------------------------------------------
// Registry API
// ---------------------------------------------------------------------------------------------

const PART_TYPES = Object.freeze({ led, resistor, button });
const BY_PREFIX = Object.freeze(Object.fromEntries(Object.values(PART_TYPES).map((d) => [d.idPrefix, d])));

/** All part descriptors, in a stable order. */
export function allPartTypes() {
    return Object.values(PART_TYPES);
}

/** The descriptor for a type name ('led', 'resistor', 'button'), or null. */
export function getPartType(type) {
    return Object.prototype.hasOwnProperty.call(PART_TYPES, type) ? PART_TYPES[type] : null;
}

/** The descriptor for an id such as "led_1700000000000", or null if it is not a part id. */
export function partTypeOfId(id) {
    if (typeof id !== 'string') return null;
    const sep = id.indexOf('_');
    if (sep <= 0) return null;
    const prefix = id.slice(0, sep);
    return Object.prototype.hasOwnProperty.call(BY_PREFIX, prefix) ? BY_PREFIX[prefix] : null;
}

/** The descriptor of a component object (anything with an `id`), or null. */
export function partTypeOf(component) {
    return component ? partTypeOfId(component.id) : null;
}

/** True if the component (or id) is a part of the given type name. */
export function isPartOfType(componentOrId, type) {
    const id = typeof componentOrId === 'string' ? componentOrId : componentOrId && componentOrId.id;
    const descriptor = partTypeOfId(id);
    return descriptor !== null && descriptor.type === type;
}

/** The components of one type, in canvas order. */
export function partsOfType(components, type) {
    return components.filter((c) => isPartOfType(c, type));
}

/** 1-based position of a component among the components of its own type (labels "LED 2", "led2", "btn1"). */
export function indexAmongType(components, component) {
    const descriptor = partTypeOf(component);
    if (!descriptor) return 0;
    return partsOfType(components, descriptor.type).indexOf(component) + 1;
}

/** The set of valid id prefixes (used to validate ids). */
export function partIdPrefixes() {
    return Object.keys(BY_PREFIX);
}
