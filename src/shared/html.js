/**
 * html.js — escaping for the few places that still build HTML strings.
 * Prefer textContent / createElement; use this only when a string template is unavoidable.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}
