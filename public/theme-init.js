/*
 * Sets the colour theme before the page is first painted, so it never flashes in the wrong theme.
 * A plain file (not inline) because the page's Content-Security-Policy allows no inline script.
 * The rules are the same as in src/ui/theme.js: the viewer's saved choice ("light" / "dark"), otherwise the operating
 * system's preference ("system", the default); dark when the system states no preference. Storage may be blocked.
 */
(function () {
    var pref = 'system';
    try {
        var raw = window.localStorage.getItem('voltloom.ui.theme');
        if (raw) pref = JSON.parse(raw);
    } catch (e) { /* no storage: follow the system */ }
    if (pref !== 'light' && pref !== 'dark') pref = 'system';
    var prefersLight = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    var theme = pref === 'system' ? (prefersLight ? 'light' : 'dark') : pref;
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-theme-pref', pref);
})();
