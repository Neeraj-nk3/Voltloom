/**
 * project-schema.js — validation and sanitising of imported projects
 *
 * A project reaches the app from untrusted places: a share link (?p=...) anyone can craft,
 * or browser storage. Nothing from it may be used until it has passed validateProject().
 *
 * validateProject() never mutates its input. On success it returns a NEW object that contains
 * only the known, type-checked fields, so unknown keys (including __proto__ tricks) are dropped.
 * On failure it returns every problem found so the user can be told why the project was rejected.
 *
 * This module is pure (no DOM, no storage) so it can be unit-tested in Node.
 */

import { isSafeComponentId, isSafeWireId } from '../shared/ids.js';
import { migrateProject, CURRENT_VERSION } from './project-migrations.js';
import { getPartType, partTypeOfId } from '../circuit/part-types.js';

export const PROJECT_VERSION = CURRENT_VERSION;   // see project-migrations.js for what each version changed

export const LIMITS = Object.freeze({
    maxEncodedChars: 400_000,   // size of the ?p= parameter we are willing to decode
    maxCodeChars: 200_000,      // matches the compile server's request cap
    maxComponents: 100,
    maxWires: 500,
    maxCoordinate: 100_000,     // canvas units
    maxRoutePoints: 64          // bends in one hand-routed wire
});

const LANGUAGES = ['python', 'c'];
const BOARDS = ['pico_w', 'pico'];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const ROTATIONS = [0, 90, 180, 270];
const DEFAULT_WIRE_COLOR = '#15803d';

export { isSafeComponentId };

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCoordinate = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= LIMITS.maxCoordinate;

function validateComponent(raw, index, errors) {
    const where = `components[${index}]`;
    if (!isPlainObject(raw)) { errors.push(`${where}: must be an object`); return null; }
    if (!isSafeComponentId(raw.id)) { errors.push(`${where}: invalid id`); return null; }

    // Per-type rules (fields, pins) come from the part registry; isSafeComponentId guarantees a descriptor.
    const descriptor = partTypeOfId(raw.id);
    const type = descriptor.type;
    if (raw.type !== type) { errors.push(`${where}: type must be "${type}" for id ${raw.id}`); return null; }
    if (!isCoordinate(raw.x) || !isCoordinate(raw.y)) { errors.push(`${where}: x/y must be finite numbers within ±${LIMITS.maxCoordinate}`); return null; }

    const rotation = raw.rotation === undefined ? 0 : raw.rotation;
    if (!ROTATIONS.includes(rotation)) { errors.push(`${where}: rotation must be 0, 90, 180 or 270`); return null; }

    const out = { id: raw.id, type, x: raw.x, y: raw.y, rotation };

    const fields = descriptor.validateFields(raw, where, errors);
    if (!fields) return null;
    return Object.assign(out, fields);
}

function validateNode(raw, where, componentsById, errors) {
    if (!isPlainObject(raw)) { errors.push(`${where}: must be an object`); return null; }

    if (raw.nodeType === 'gpio') {
        // Physical pin number on the 40-pin Pico header.
        if (!Number.isInteger(raw.pin) || raw.pin < 1 || raw.pin > 40) { errors.push(`${where}: gpio pin must be an integer 1..40`); return null; }
        const node = { nodeType: 'gpio', pin: raw.pin };
        // Board-space coordinates used to draw the wire; optional in old projects.
        if (raw.x !== undefined || raw.y !== undefined) {
            if (!isCoordinate(raw.x) || !isCoordinate(raw.y)) { errors.push(`${where}: x/y must be finite numbers`); return null; }
            node.x = raw.x; node.y = raw.y;
        }
        if (raw.gpNum !== undefined && raw.gpNum !== null) {
            const gp = typeof raw.gpNum === 'string' && /^\d{1,2}$/.test(raw.gpNum) ? Number(raw.gpNum) : raw.gpNum;
            if (!Number.isInteger(gp) || gp < 0 || gp > 29) { errors.push(`${where}: gpNum must be 0..29`); return null; }
            node.gpNum = String(gp);
        }
        return node;
    }

    if (raw.nodeType === 'component_pin') {
        if (!isSafeComponentId(raw.componentId) || !componentsById.has(raw.componentId)) { errors.push(`${where}: refers to an unknown component`); return null; }
        const type = componentsById.get(raw.componentId);
        if (typeof raw.pin !== 'string' || !getPartType(type).pins.includes(raw.pin)) { errors.push(`${where}: invalid pin for ${type}`); return null; }
        return { nodeType: 'component_pin', componentId: raw.componentId, pin: raw.pin };
    }

    errors.push(`${where}: nodeType must be "gpio" or "component_pin"`);
    return null;
}

const endpointKey = (n) => (n.nodeType === 'gpio' ? `gpio:${n.pin}` : `comp:${n.componentId}:${n.pin}`);

/** meta.savedAt must be a plain ISO-style timestamp; anything else is dropped. */
function validateMeta(raw) {
    const meta = { app: 'voltloom' };
    if (isPlainObject(raw) && typeof raw.savedAt === 'string' && raw.savedAt.length <= 40 && !Number.isNaN(Date.parse(raw.savedAt))) {
        meta.savedAt = raw.savedAt;
    }
    return meta;
}

/**
 * Validates a project of ANY supported version: it is first migrated to the current version (project-migrations.js),
 * then checked field by field.
 *
 * @param {unknown} rawInput — parsed JSON from a share link or storage
 * @returns {{ok: true, project: object, notes: string[]} | {ok: false, errors: string[]}}
 *   notes: things the user may want to know (upgraded from an older version, duplicate wires removed)
 */
export function validateProject(rawInput) {
    const errors = [];
    const migrated = migrateProject(rawInput);
    if (!migrated.ok) return migrated;
    const raw = migrated.project;
    const notes = [...migrated.notes];

    const language = raw.language === undefined ? 'python' : raw.language;
    if (!LANGUAGES.includes(language)) errors.push('language must be "python" or "c"');

    const board = raw.board === undefined ? 'pico_w' : raw.board;
    if (!BOARDS.includes(board)) errors.push('unknown board');

    const code = raw.code === undefined ? '' : raw.code;
    if (typeof code !== 'string') errors.push('code must be a string');
    else if (code.length > LIMITS.maxCodeChars) errors.push(`code is longer than ${LIMITS.maxCodeChars} characters`);

    const rawComponents = raw.components === undefined ? [] : raw.components;
    const rawWires = raw.connections === undefined ? [] : raw.connections;
    if (!Array.isArray(rawComponents)) errors.push('components must be an array');
    else if (rawComponents.length > LIMITS.maxComponents) errors.push(`more than ${LIMITS.maxComponents} components`);
    if (!Array.isArray(rawWires)) errors.push('connections must be an array');
    else if (rawWires.length > LIMITS.maxWires) errors.push(`more than ${LIMITS.maxWires} connections`);

    if (errors.length) return { ok: false, errors };

    const components = [];
    const componentsById = new Map();
    rawComponents.forEach((c, i) => {
        const v = validateComponent(c, i, errors);
        if (!v) return;
        if (componentsById.has(v.id)) { errors.push(`components[${i}]: duplicate id ${v.id}`); return; }
        componentsById.set(v.id, v.type);
        components.push(v);
    });

    const connections = [];
    const usedWireIds = new Set();
    const seenWires = new Set();
    let droppedDuplicates = 0;
    let droppedSelf = 0;
    const needId = [];
    rawWires.forEach((w, i) => {
        const where = `connections[${i}]`;
        if (!isPlainObject(w)) { errors.push(`${where}: must be an object`); return; }
        const start = validateNode(w.start, `${where}.start`, componentsById, errors);
        const end = validateNode(w.end, `${where}.end`, componentsById, errors);
        const color = w.color === undefined ? DEFAULT_WIRE_COLOR : w.color;
        if (typeof color !== 'string' || !HEX_COLOR.test(color)) { errors.push(`${where}: color must be #rrggbb`); return; }
        if (w.id !== undefined && !isSafeWireId(w.id)) { errors.push(`${where}: invalid wire id`); return; }
        if (w.id !== undefined && usedWireIds.has(w.id)) { errors.push(`${where}: duplicate wire id ${w.id}`); return; }
        if (!start || !end) return;

        // A wire from a pin to itself, or the same two pins joined twice (either way round), does nothing: drop it.
        const a = endpointKey(start); const b = endpointKey(end);
        if (a === b) { droppedSelf++; return; }
        const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seenWires.has(pair)) { droppedDuplicates++; return; }
        seenWires.add(pair);

        const wire = { start, end, color: color.toLowerCase() };
        // Optional hand-made route: a list of [x, y] bends. Anything malformed is ignored (the wire is then routed
        // automatically); it never makes the whole project invalid.
        if (Array.isArray(w.route) && w.route.length > 0 && w.route.length <= LIMITS.maxRoutePoints
            && w.route.every((p) => Array.isArray(p) && p.length === 2 && isCoordinate(p[0]) && isCoordinate(p[1]))) {
            wire.route = w.route.map(([x, y]) => [x, y]);
        }
        if (w.id !== undefined) { wire.id = w.id; usedWireIds.add(w.id); } else needId.push(wire);
        connections.push(wire);
    });

    if (errors.length) return { ok: false, errors };

    // Wires without an id (a hand-edited file) get the lowest free wire_<n>, in file order, so the result is repeatable.
    let next = 1;
    for (const wire of needId) {
        while (usedWireIds.has(`wire_${next}`)) next++;
        wire.id = `wire_${next}`; usedWireIds.add(wire.id);
    }
    if (droppedDuplicates) notes.push(`${droppedDuplicates} duplicate connection${droppedDuplicates === 1 ? '' : 's'} removed`);
    if (droppedSelf) notes.push(`${droppedSelf} connection${droppedSelf === 1 ? '' : 's'} from a pin to itself removed`);

    return {
        ok: true,
        project: { version: PROJECT_VERSION, language, code, board, components, connections, meta: validateMeta(raw.meta) },
        notes
    };
}
