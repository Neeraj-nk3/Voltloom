/**
 * theme.js — light and dark themes.
 *
 * The viewer chooses System, Light or Dark. "System" (the default) follows the operating system and changes with it.
 * The choice is a per-viewer preference (storage.js), never part of a project. public/theme-init.js applies the same
 * rules before first paint; this module keeps them up to date afterwards. Switching only changes <html data-theme>:
 * nothing reloads, so the editor, the circuit and a running program are untouched.
 */

import { readPref, writePref } from './storage.js';

export const THEME_PREFS = ['system', 'light', 'dark'];
const THEME_COLOR = { dark: '#16181b', light: '#f6f5f2' };

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
const listeners = new Set();
let chosen = null;              // the choice made in this page (kept even if storage refuses to save it)

/** 'system' | 'light' | 'dark' */
export function getThemePref() {
    const pref = chosen ?? readPref('theme', 'system');
    return THEME_PREFS.includes(pref) ? pref : 'system';
}

/** The theme actually shown: 'light' | 'dark'. With no system preference stated, dark. */
export function resolveTheme(pref = getThemePref()) {
    if (pref === 'light' || pref === 'dark') return pref;
    return media && media.matches ? 'light' : 'dark';
}

function apply() {
    const pref = getThemePref();
    const theme = resolveTheme(pref);
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.themePref = pref;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
    for (const listener of listeners) listener(theme, pref);
}

export function setThemePref(pref) {
    if (!THEME_PREFS.includes(pref)) return;
    chosen = pref;
    writePref('theme', pref);          // may fail (blocked storage): the choice still holds for this page
    apply();
}

/** Call cb(theme, pref) now and on every change. */
export function onThemeChange(cb) {
    listeners.add(cb);
    cb(resolveTheme(), getThemePref());
    return () => listeners.delete(cb);
}

export function initTheme() {
    apply();
    if (media) {
        const follow = () => { if (getThemePref() === 'system') apply(); };
        if (media.addEventListener) media.addEventListener('change', follow); else media.addListener(follow);
    }
}
