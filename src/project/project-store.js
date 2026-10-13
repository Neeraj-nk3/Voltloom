/**
 * Project Save & Share
 * 
 * Handles project persistence (localStorage when it works, else sessionStorage; see autosave.js for how saves are
 * made and reported) and shareable links (base64 URL).
 * 
 * This module is pure data — no DOM manipulation, no UI changes.
 * It serializes/deserializes project state: code, language, components,
 * wires (connections), and board type.
 * 
 * Data flow:
 *   save(project) → storage
 *   load() → project | null (the newest saved copy)
 *   shareProject(project) → URL string
 *   loadFromURL() → project | null
 */

import { validateProject, PROJECT_VERSION, LIMITS } from './project-schema.js';
import { partTypeOf } from '../circuit/part-types.js';
import { isSafeWireId } from '../shared/ids.js';
import { chooseStorage, createAutosave, DEFAULT_KEY, LEGACY_KEYS } from './autosave.js';

export { chooseStorage, createAutosave };

// ─── Constants ───────────────────────────────────────────────────────

const STORAGE_KEY = DEFAULT_KEY;
const URL_PARAM = 'p';

// ─── Project Creation ────────────────────────────────────────────────

/**
 * Creates a versioned project object from current app state.
 * 
 * @param {string} code — editor source code
 * @param {string} language — 'python' or 'c'
 * @param {Array} components — CanvasManager.components array
 * @param {Array} wires — CanvasManager.wires array
 * @param {string} board — board identifier (default: 'pico_w')
 * @returns {object} serializable project object
 */
export function createProject(code, language, components, wires, board = 'pico_w', { savedAt } = {}) {
    return {
        version: PROJECT_VERSION,
        language,
        code,
        board,
        components: serializeComponents(components),
        connections: serializeWires(wires),
        meta: savedAt ? { app: 'voltloom', savedAt } : { app: 'voltloom' }
    };
}

// ─── Serialization Helpers ───────────────────────────────────────────

/**
 * Extracts serializable data from component objects.
 * Strips DOM references (div, pathElement) and runtime-only state (isPressed).
 */
export function serializeComponents(components) {
    return components.map(c => {
        const descriptor = partTypeOf(c);
        const base = {
            id: c.id,
            type: descriptor ? descriptor.type : 'unknown',
            x: c.x,
            y: c.y,
            rotation: c.rotation || 0
        };

        // Type-specific saved fields come from the part registry (a button saves none: pressed is runtime-only)
        return descriptor ? Object.assign(base, descriptor.serializeFields(c)) : base;
    });
}

/**
 * Extracts serializable data from wire objects.
 * Preserves endpoint node data needed for wiring restoration.
 */
export function serializeWires(wires) {
    return wires.map(w => {
        const out = {
            start: serializeNode(w.start),
            end: serializeNode(w.end),
            color: w.color || '#15803d'
        };
        if (isSafeWireId(w.id)) out.id = w.id;
        // A route the user shaped by hand: its bends (not the pins, which come from the connection itself)
        if (w.route && Array.isArray(w.route.points) && w.route.points.length > 2) {
            out.route = w.route.points.slice(1, -1).map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
        }
        return out;
    });
}

/**
 * Serializes a wire endpoint node.
 * GPIO nodes: { nodeType, pin, x, y } — coords needed for wire rendering
 * Component pins: { nodeType, componentId, pin } — coords recalculated from component position
 */
function serializeNode(node) {
    const result = { nodeType: node.nodeType, pin: node.pin };
    if (node.nodeType === 'component_pin') {
        result.componentId = node.componentId;
    }
    if (node.gpNum !== undefined && node.gpNum !== null) {
        result.gpNum = node.gpNum;
    }
    // Save coordinates for GPIO nodes (needed for wire path rendering on restore)
    if (node.nodeType === 'gpio' && node.x !== undefined && node.y !== undefined) {
        result.x = node.x;
        result.y = node.y;
    }
    return result;
}

// ─── Import validation ───────────────────────────────────────────────

/** Why the most recent import (share link or stored project) was rejected, or null. */
let lastImportError = null;
/** What the most recent accepted import changed or upgraded (e.g. "project upgraded from version 1 to 2"). */
let lastImportNotes = [];

export function getLastImportError() {
    return lastImportError;
}

export function getLastImportNotes() {
    return lastImportNotes;
}

/**
 * Validates untrusted project data. Returns the sanitised project, or null and records
 * the reason (see getLastImportError). Nothing from a rejected project is ever used.
 */
function acceptImportedProject(raw) {
    const result = validateProject(raw);
    if (result.ok) {
        lastImportError = null;
        lastImportNotes = result.notes || [];
        return result.project;
    }
    const shown = result.errors.slice(0, 3).join('; ') + (result.errors.length > 3 ? ` (+${result.errors.length - 3} more)` : '');
    lastImportError = shown;
    console.warn('[ProjectStore] Rejected project:', result.errors);
    return null;
}

// ─── Browser storage persistence ─────────────────────────────────────

/**
 * Saves a project to the best storage that works. Returns what happened, so callers never have to guess:
 * { ok, kind: 'local'|'session'|'none', error? }.
 *
 * @param {object} project — project object from createProject()
 */
export function save(project, store = chooseStorage()) {
    if (!store.storage) return { ok: false, kind: 'none', error: new Error('no usable browser storage') };
    try {
        const json = JSON.stringify(project);
        store.storage.setItem(STORAGE_KEY, json);
        if (store.storage.getItem(STORAGE_KEY) !== json) throw new Error('the stored copy does not match');
        return { ok: true, kind: store.kind };
    } catch (error) {
        console.warn('[ProjectStore] Failed to save project:', error.message);
        return { ok: false, kind: store.kind, error };
    }
}

function readStored(storage) {
    try {
        // the current key first; a copy saved under a key from an earlier build is read (never rewritten or deleted) if there is none
        let json = storage && storage.getItem(STORAGE_KEY);
        for (const legacyKey of LEGACY_KEYS) {
            if (json) break;
            json = storage && storage.getItem(legacyKey);
        }
        if (!json) return null;
        return acceptImportedProject(JSON.parse(json));
    } catch (err) {
        console.warn('[ProjectStore] Failed to load project:', err.message);
        return null;
    }
}

/** Where the project returned by the last load() came from: 'local', 'session' or null. */
let lastLoadedFrom = null;
export function getLastLoadedFrom() {
    return lastLoadedFrom;
}

/**
 * Loads the newest saved project (localStorage, or a copy left in sessionStorage by an older version of the app or by
 * a browser where localStorage is unavailable). Everything read is validated and migrated first.
 *
 * @returns {object|null} validated project, or null if nothing saved / invalid
 */
export function load(host = globalThis) {
    lastLoadedFrom = null;
    const candidates = [];
    for (const [kind, getter] of [['local', () => host.localStorage], ['session', () => host.sessionStorage]]) {
        let storage = null;
        try { storage = getter(); } catch { storage = null; }
        const project = readStored(storage);
        if (project) candidates.push({ kind, project });
    }
    if (candidates.length === 0) return null;
    // newest first; a copy without a timestamp (saved by the old version) loses to one with a timestamp, ties go to localStorage
    const stamp = (c) => (c.project.meta && c.project.meta.savedAt ? Date.parse(c.project.meta.savedAt) : 0);
    candidates.sort((x, y) => stamp(y) - stamp(x));
    lastLoadedFrom = candidates[0].kind;
    return candidates[0].project;
}

// ─── URL Sharing ─────────────────────────────────────────────────────

/**
 * Encodes a project object to a base64 string.
 * Uses encodeURIComponent for Unicode safety before btoa.
 * 
 * @param {object} project — project object
 * @returns {string} base64-encoded string
 */
export function encodeProject(project) {
    const json = JSON.stringify(project);
    // Handle Unicode: encode to percent-escaped ASCII, then btoa
    return btoa(encodeURIComponent(json));
}

/**
 * Decodes a base64 string back to a project object.
 * 
 * The result is validated: a project that does not pass project-schema is rejected (null)
 * and the reason is available from getLastImportError().
 * 
 * @param {string} encoded — base64 string
 * @returns {object|null} validated project object, or null on failure
 */
export function decodeProject(encoded) {
    try {
        if (typeof encoded !== 'string' || encoded.length > LIMITS.maxEncodedChars) {
            lastImportError = 'link is too large';
            return null;
        }
        const json = decodeURIComponent(atob(encoded));
        return acceptImportedProject(JSON.parse(json));
    } catch (err) {
        lastImportError = 'link could not be decoded';
        console.warn('[ProjectStore] Failed to decode project:', err.message);
        return null;
    }
}

/**
 * Generates a shareable URL containing the full project state.
 * 
 * @param {object} project — project object
 * @returns {string} full URL with ?p= parameter
 */
export function shareProject(project) {
    const encoded = encodeProject(project);
    const url = new URL(window.location.href);
    url.searchParams.set(URL_PARAM, encoded);
    // Remove hash if present
    url.hash = '';
    return url.toString();
}

/**
 * Checks the current URL for a shared project parameter.
 * If found, decodes and returns the project, then cleans the URL.
 * 
 * @returns {object|null} project object from URL, or null
 */
export function loadFromURL() {
    try {
        const url = new URL(window.location.href);
        const encoded = url.searchParams.get(URL_PARAM);
        if (!encoded) return null;

        const project = decodeProject(encoded);
        // Clean the URL (remove ?p= param) without page reload, whether or not it was accepted,
        // so a rejected link is not re-processed on every refresh.
        url.searchParams.delete(URL_PARAM);
        window.history.replaceState({}, '', url.toString());
        if (project) console.log('[ProjectStore] Loaded project from shared URL');
        return project;
    } catch (err) {
        console.warn('[ProjectStore] Failed to load from URL:', err.message);
        return null;
    }
}
