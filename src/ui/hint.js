/**
 * hint.js — the one-line guidance strip at the bottom of the canvas ("Click a pin to start a wire").
 * Text only plus key caps; the canvas decides what to say (see CanvasManager.refreshHint).
 */

import { icon } from './icons.js';

/**
 * @param {HTMLElement} element   #canvas-hint
 * @param {{text: string, tone?: 'idle'|'active'|'error', keys?: Array<[string, string]>} | null} hint
 */
export function renderHint(element, hint) {
    if (!element) return;
    element.replaceChildren();
    if (!hint) { delete element.dataset.tone; return; }
    element.dataset.tone = hint.tone || 'idle';
    element.insertAdjacentHTML('beforeend', icon(hint.tone === 'error' ? 'alert-circle' : 'info', 'icon--sm'));
    const text = document.createElement('span');
    text.textContent = hint.text;
    element.append(text);
    for (const [key, label] of hint.keys || []) {
        const wrap = document.createElement('span');
        const k = document.createElement('kbd');
        k.textContent = key;
        wrap.append(k, document.createTextNode(` ${label}`));
        element.append(wrap);
    }
}
