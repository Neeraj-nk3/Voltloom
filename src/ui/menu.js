/**
 * menu.js — behaviour of a button that opens a menu (the "Add part" menu): open/close, arrow keys, Escape, focus return.
 */

export function initMenu(button, menu) {
    const items = () => Array.from(menu.querySelectorAll('[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])'));

    function open({ focusFirst = false } = {}) {
        menu.classList.add('is-open');
        button.setAttribute('aria-expanded', 'true');
        // a radio menu starts on the checked item, a plain menu on the first one
        if (focusFirst) (menu.querySelector('[aria-checked="true"]') || items()[0])?.focus();
    }

    function close({ returnFocus = false } = {}) {
        if (!menu.classList.contains('is-open')) return;
        menu.classList.remove('is-open');
        button.setAttribute('aria-expanded', 'false');
        if (returnFocus) button.focus();
    }

    button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (menu.classList.contains('is-open')) close();
        else open({ focusFirst: event.detail === 0 });        // detail 0: opened from the keyboard, so move into the menu
    });

    button.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open({ focusFirst: true }); }
        else if (event.key === 'Escape' && menu.classList.contains('is-open')) { event.stopPropagation(); close(); }
    });

    menu.addEventListener('keydown', (event) => {
        const list = items();
        const index = list.indexOf(document.activeElement);
        if (event.key === 'ArrowDown') { event.preventDefault(); list[(index + 1) % list.length]?.focus(); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); list[(index - 1 + list.length) % list.length]?.focus(); }
        else if (event.key === 'Home') { event.preventDefault(); list[0]?.focus(); }
        else if (event.key === 'End') { event.preventDefault(); list[list.length - 1]?.focus(); }
        else if (event.key === 'Escape') { event.stopPropagation(); close({ returnFocus: true }); }
        else if (event.key === 'Tab') close();
    });

    // Choosing an item closes the menu; the item's own handler does the work.
    menu.addEventListener('click', () => close({ returnFocus: true }));

    document.addEventListener('pointerdown', (event) => {
        if (!menu.contains(event.target) && !button.contains(event.target)) close();
    }, true);

    return { open, close };
}
