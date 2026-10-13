/**
 * ids.js — the only place that defines what a component id looks like.
 *
 * Ids are generated as "<prefix>_<Date.now()>" ("led_1700000000000"). Component factories
 * interpolate the id into SVG/HTML templates and element ids, so anything that is not of this
 * exact shape must never reach them.
 */

import { partIdPrefixes } from '../circuit/part-types.js';

// "<prefix>_<digits>" where the prefix is one the part registry knows (led, res, btn, ...).
const COMPONENT_ID = new RegExp('^(' + partIdPrefixes().join('|') + ')_[0-9]{1,16}$');

/** True if the value is a component id this app could have generated. */
export function isSafeComponentId(id) {
    return typeof id === 'string' && COMPONENT_ID.test(id);
}

const WIRE_ID = /^wire_[0-9]{1,16}$/;

/** True if the value is a wire id this app could have generated. */
export function isSafeWireId(id) {
    return typeof id === 'string' && WIRE_ID.test(id);
}

/** Throws if the id is not safe to place in markup. */
export function assertSafeComponentId(id) {
    if (!isSafeComponentId(id)) {
        throw new Error('Refusing to create a component with an unsafe id');
    }
    return id;
}

// ---------------------------------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------------------------------

let lastNumber = 0;

/**
 * A new "<prefix>_<number>" id that is guaranteed not to exist yet.
 *
 * The number starts from the clock (so ids stay roughly time-ordered and keep the shape the importer accepts) but is
 * never repeated: it is always above the last one handed out and is advanced past anything `isTaken` reports. Using the
 * bare clock made every wire of a loaded project share one id, because they are created in the same millisecond.
 *
 * @param {string} prefix  e.g. 'wire' or a part id prefix
 * @param {(id: string) => boolean} isTaken  true if an id is already in use
 */
export function nextUniqueId(prefix, isTaken = () => false) {
    let n = Math.max(Date.now(), lastNumber + 1);
    while (isTaken(`${prefix}_${n}`)) n++;
    lastNumber = n;
    return `${prefix}_${n}`;
}
