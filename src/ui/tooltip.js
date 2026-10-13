/**
 * tooltip.js — one tooltip for the whole interface.
 *
 * Any element with data-tip="text" gets it, on hover (after a short delay) and on keyboard focus, so it works without
 * a mouse. Optional attributes: data-kbd="Ctrl+Enter" shows key caps; data-tip-disabled="why" replaces the text while the
 * element is disabled, so a greyed-out control says why. The canvas calls showTip() directly for pins.
 */

import { placeFloating } from './canvas/geometry.js';

const HOVER_DELAY_MS = 450;
let tip = null;
let timer = null;
let owner = null;

function ensure() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.id = 'tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
}

function describe(target) {
    const text = target.disabled && target.dataset.tipDisabled ? target.dataset.tipDisabled : target.dataset.tip;
    return text ? { text, keys: target.disabled ? '' : target.dataset.kbd || '' } : null;
}

/**
 * Show the tooltip next to a rectangle (viewport pixels).
 * @param {{left:number,top:number,right:number,bottom:number}} anchor
 * @param {string} text
 * @param {{keys?: string, meta?: string, mono?: boolean, prefer?: 'above'|'below'}} [options]
 */
export function showTip(anchor, text, { keys = '', meta = '', mono = false, prefer = 'below', side = null } = {}) {
    const el = ensure();
    el.replaceChildren();
    el.classList.toggle('tip--mono', mono);
    el.append(document.createTextNode(text));
    if (meta) {
        const m = document.createElement('div');
        m.className = 'tip__meta';
        m.textContent = meta;
        el.append(m);
    }
    if (keys) {
        for (const key of keys.split('+')) {
            const k = document.createElement('kbd');
            k.textContent = key;
            el.append(k);
        }
    }
    el.hidden = false;
    el.style.left = '0px';
    el.style.top = '0px';
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const bounds = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
    let pos;
    if (side) {                      // beside the anchor (board pins: outward, so the neighbouring pins stay visible)
        const middle = (anchor.top + anchor.bottom) / 2 - size.height / 2;
        const left = side === 'right' ? anchor.right + 10 : anchor.left - 10 - size.width;
        pos = {
            left: Math.max(6, Math.min(left, bounds.right - 6 - size.width)),
            top: Math.max(6, Math.min(middle, bounds.bottom - 6 - size.height))
        };
    } else {
        pos = placeFloating(anchor, size, bounds, { gap: 8, gutter: 6, prefer });
    }
    el.style.left = `${Math.round(pos.left)}px`;
    el.style.top = `${Math.round(pos.top)}px`;
}

export function hideTip() {
    clearTimeout(timer);
    timer = null;
    owner = null;
    if (tip) tip.hidden = true;
}

function targetOf(event) {
    return event.target instanceof Element ? event.target.closest('[data-tip]') : null;
}

function present(target) {
    const info = describe(target);
    if (!info) return;
    owner = target;
    showTip(target.getBoundingClientRect(), info.text, { keys: info.keys });
}

export function initTooltips() {
    ensure();
    document.addEventListener('pointerover', (event) => {
        if (event.pointerType === 'touch') return;
        const target = targetOf(event);
        if (!target || target === owner) return;
        hideTip();
        timer = setTimeout(() => present(target), HOVER_DELAY_MS);
    });
    document.addEventListener('pointerout', (event) => {
        const target = targetOf(event);
        if (target && !target.contains(event.relatedTarget)) hideTip();
    });
    document.addEventListener('focusin', (event) => {
        const target = targetOf(event);
        if (target && target.matches(':focus-visible')) { hideTip(); present(target); }
    });
    document.addEventListener('focusout', hideTip);
    document.addEventListener('pointerdown', hideTip, true);
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideTip(); }, true);
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('blur', hideTip);
}
