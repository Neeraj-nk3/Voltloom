/**
 * icons.js — markup for icons that script adds to the page.
 * The shapes are defined once, in the <symbol> sprite at the top of index.html (ids "i-<name>").
 * tests/unit/ui/icons.test.js checks that every icon used here and in the HTML exists in the sprite.
 */

/** @param {string} name  icon name, e.g. 'play'  @param {string} [extra]  extra classes, e.g. 'icon--sm' */
export function icon(name, extra = '') {
    return `<svg class="icon ${extra}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;
}

/** Point an existing <svg><use> at another icon (used by toggles such as the console chevron). */
export function setIcon(svg, name) {
    const use = svg && svg.querySelector('use');
    if (use) use.setAttribute('href', `#i-${name}`);
}
