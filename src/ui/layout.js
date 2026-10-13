/**
 * layout.js — behaviour of the page structure: the two splitters, the Code/Circuit switch on narrow windows,
 * and the console panel (collapse, count, auto-open on problems).
 *
 * Sizes are per viewer (see storage.js). Splitters work with the pointer and the keyboard.
 */

import { readPref, writePref } from './storage.js';
import { setIcon } from './icons.js';

const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));

// ───────── Splitters ─────────

/**
 * @param {HTMLElement} handle
 * @param {{axis:'x'|'y', get:()=>number, set:(px:number)=>void, min:()=>number, max:()=>number, label:(px:number)=>string, key:string, step?:number}} spec
 */
function makeSplitter(handle, { axis, get, set, min, max, key, step = 24, invert = false }) {
    // A separator reports its position as a percentage between its limits
    const syncAria = (value) => {
        const range = Math.max(1, max() - min());
        handle.setAttribute('aria-valuemin', '0');
        handle.setAttribute('aria-valuemax', '100');
        handle.setAttribute('aria-valuenow', String(Math.round(Math.max(0, Math.min(1, (value - min()) / range)) * 100)));
    };

    const apply = (px, { save = true } = {}) => {
        const value = Math.round(clamp(px, min(), max()));
        set(value);
        syncAria(value);
        if (save) writePref(key, value);
        return value;
    };

    handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        handle.classList.add('is-dragging');
        document.body.classList.add('is-resizing');
        document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
        const startPointer = axis === 'x' ? event.clientX : event.clientY;
        const startSize = get();

        const move = (e) => {
            const delta = (axis === 'x' ? e.clientX : e.clientY) - startPointer;
            apply(startSize + (invert ? -delta : delta), { save: false });
        };
        const up = () => {
            handle.releasePointerCapture(event.pointerId);
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            handle.classList.remove('is-dragging');
            document.body.classList.remove('is-resizing');
            document.body.style.cursor = '';
            writePref(key, get());
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    });

    handle.addEventListener('keydown', (event) => {
        const big = event.shiftKey ? 4 : 1;
        const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        const backward = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        const dir = invert ? -1 : 1;
        if (event.key === forward) apply(get() + dir * step * big);
        else if (event.key === backward) apply(get() - dir * step * big);
        else if (event.key === 'Home') apply(invert ? max() : min());
        else if (event.key === 'End') apply(invert ? min() : max());
        else return;
        event.preventDefault();
    });

    return { apply, syncAria: () => syncAria(get()), reclamp: () => apply(get(), { save: false }) };
}

export function initSplitters() {
    const root = document.documentElement;
    const workspace = document.getElementById('workspace');
    const codePane = document.getElementById('pane-code');
    const consolePanel = document.getElementById('console-panel');
    const benchMain = document.querySelector('.bench-main');

    const codeSplitter = makeSplitter(document.getElementById('splitter-code'), {
        axis: 'x',
        key: 'codeWidth',
        get: () => codePane.getBoundingClientRect().width,
        set: (px) => root.style.setProperty('--code-w', `${px}px`),
        min: () => 300,
        max: () => workspace.clientWidth - 360
    });

    const consoleSplitter = makeSplitter(document.getElementById('splitter-console'), {
        axis: 'y',
        key: 'consoleHeight',
        invert: true,                                  // dragging up makes the console taller
        step: 24,
        get: () => consolePanel.getBoundingClientRect().height,
        set: (px) => root.style.setProperty('--console-h', `${px}px`),
        min: () => 96,
        max: () => benchMain.clientHeight - 180
    });

    const savedWidth = readPref('codeWidth');
    if (typeof savedWidth === 'number') root.style.setProperty('--code-w', `${savedWidth}px`);
    const savedHeight = readPref('consoleHeight');
    if (typeof savedHeight === 'number') root.style.setProperty('--console-h', `${savedHeight}px`);

    // Only sizes the viewer chose are held in pixels (and kept inside the window); the defaults scale with the window.
    const refresh = () => {
        const splitterShown = getComputedStyle(document.getElementById('splitter-code')).display !== 'none';
        if (splitterShown && root.style.getPropertyValue('--code-w')) codeSplitter.reclamp();
        if (consolePanel.dataset.collapsed !== 'true' && root.style.getPropertyValue('--console-h')) consoleSplitter.reclamp();
        codeSplitter.syncAria();
        consoleSplitter.syncAria();
    };
    window.addEventListener('resize', refresh);
    refresh();
    return { refresh, consoleSplitter };
}

// ───────── Code / Circuit switch (narrow windows) ─────────

export function initPaneSwitch(onChange) {
    const app = document.getElementById('app');
    const codeBtn = document.getElementById('pane-code-btn');
    const circuitBtn = document.getElementById('pane-circuit-btn');
    const set = (pane, { save = true } = {}) => {
        app.dataset.pane = pane;
        codeBtn.setAttribute('aria-pressed', String(pane === 'code'));
        circuitBtn.setAttribute('aria-pressed', String(pane === 'circuit'));
        if (save) writePref('pane', pane);
        if (onChange) onChange(pane);
    };
    codeBtn.addEventListener('click', () => set('code'));
    circuitBtn.addEventListener('click', () => set('circuit'));
    set(readPref('pane') === 'circuit' ? 'circuit' : 'code', { save: false });
    return { show: set };
}

// ───────── Console ─────────

export function initConsole({ onClear } = {}) {
    const panel = document.getElementById('console-panel');
    const output = document.getElementById('output');
    const toggle = document.getElementById('console-toggle-btn');
    const clearBtn = document.getElementById('clear-console');
    const count = document.getElementById('console-count');
    const splitter = document.getElementById('splitter-console');
    let userCollapsed = false;

    function setCollapsed(collapsed) {
        panel.dataset.collapsed = String(collapsed);
        splitter.hidden = collapsed;
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.setAttribute('aria-label', collapsed ? 'Expand console' : 'Collapse console');
        toggle.dataset.tip = collapsed ? 'Expand the console' : 'Collapse the console';
        setIcon(toggle.querySelector('svg'), collapsed ? 'chevron-up' : 'chevron-down');
    }

    function expand() {
        if (panel.dataset.collapsed === 'true') setCollapsed(false);
        window.dispatchEvent(new Event('resize'));       // the canvas lost height: let it re-anchor floating UI
    }

    const flip = () => {
        const collapsing = panel.dataset.collapsed !== 'true';
        userCollapsed = collapsing;
        setCollapsed(collapsing);
        window.dispatchEvent(new Event('resize'));
    };
    toggle.addEventListener('click', flip);
    document.getElementById('console-title-btn')?.addEventListener('click', flip);     // the title is a bigger target for the same thing

    clearBtn.addEventListener('click', () => { if (onClear) onClear(); });

    // The header says how much is there, and whether any of it is an error, even while the console is closed
    const errors = document.getElementById('console-errors');
    const refreshCount = () => {
        const n = output.childElementCount;
        count.textContent = n === 0 ? '' : `${n} ${n === 1 ? 'line' : 'lines'}`;
        const e = output.querySelectorAll('.line--error').length;
        if (errors) {
            errors.hidden = e === 0;
            errors.textContent = e === 0 ? '' : `${e} ${e === 1 ? 'error' : 'errors'}`;
        }
    };

    // Errors and warnings open the console on their own (unless the user closed it); plain output waits for Run.
    new MutationObserver((records) => {
        refreshCount();
        if (userCollapsed) return;
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof Element && (node.classList.contains('line--error') || node.classList.contains('line--warning'))) {
                    expand();
                    return;
                }
            }
        }
    }).observe(output, { childList: true });

    setCollapsed(true);
    return { expand, refreshCount };
}
