/**
 * storage.js — per-viewer interface preferences (pane sizes, canvas viewport, ...).
 *
 * Kept apart from the project: these are never part of a saved or shared project. Browser storage can be missing,
 * full or blocked (private windows, site settings), so every access is guarded and the interface works without it.
 */

const PREFIX = 'voltloom.ui.';

export function readPref(key, fallback = null) {
    try {
        const raw = window.localStorage.getItem(PREFIX + key);
        return raw === null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export function writePref(key, value) {
    try {
        window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}
