/**
 * popover.js — a small detail card that opens from a status pill (circuit warnings, limited mode).
 * One at a time; closes on Escape, on a click elsewhere, and when the pill is pressed again.
 * Content is built from text nodes, never parsed as HTML (warning messages contain part names from the project).
 */

import { placeFloating } from './canvas/geometry.js';
import { icon } from './icons.js';

let card = null;
let anchorEl = null;

export function closePopover() {
    if (card) { card.remove(); card = null; }
    if (anchorEl) { anchorEl.setAttribute('aria-expanded', 'false'); anchorEl = null; }
}

/**
 * @param {HTMLElement} anchor
 * @param {{title: string, iconName?: string, lines?: string[], paragraphs?: string[]}} content
 */
export function togglePopover(anchor, { title, iconName = 'info', lines = [], paragraphs = [] }) {
    if (anchorEl === anchor) { closePopover(); return; }
    closePopover();

    card = document.createElement('div');
    card.className = 'popover';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', title);

    const heading = document.createElement('div');
    heading.className = 'popover__title';
    heading.insertAdjacentHTML('beforeend', icon(iconName));
    heading.append(document.createTextNode(title));
    card.append(heading);

    for (const text of paragraphs) {
        const p = document.createElement('p');
        p.textContent = text;
        card.append(p);
    }
    if (lines.length) {
        const ul = document.createElement('ul');
        for (const text of lines) {
            const li = document.createElement('li');
            li.textContent = text;
            ul.append(li);
        }
        card.append(ul);
    }

    document.body.append(card);
    anchorEl = anchor;
    anchor.setAttribute('aria-expanded', 'true');

    const rect = anchor.getBoundingClientRect();
    const bounds = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
    const pos = placeFloating(rect, { width: card.offsetWidth, height: card.offsetHeight }, bounds, { prefer: 'below', gap: 8 });
    card.style.left = `${Math.round(pos.left)}px`;
    card.style.top = `${Math.round(pos.top)}px`;
}

export function initPopovers() {
    document.addEventListener('pointerdown', (event) => {
        if (!card) return;
        if (card.contains(event.target) || (anchorEl && anchorEl.contains(event.target))) return;
        closePopover();
    }, true);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && card) {
            const back = anchorEl;
            closePopover();
            if (back) back.focus();
            event.stopPropagation();
        }
    }, true);
    window.addEventListener('resize', closePopover);
}
