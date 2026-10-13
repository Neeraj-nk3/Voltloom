/**
 * This file handles how wires look.
 * It calculates the path a wire follows and creates the line you see on the screen.
 *
 * Every wire is drawn with a thin dark outline (the "casing", an SVG filter defined in the wire layer) and a dot at
 * each end (SVG markers), so it stays visible on the green board, on either canvas theme and where wires cross,
 * and the exact point where it meets a pin is always marked. The wire's own colour is the project's and is never
 * changed.
 */

export function getOrthogonalPath(x1, y1, x2, y2, flipped = false) {
    const r = 16; // Smoother radius

    // Check if points are aligned (straight line)
    if (x1 === x2 || y1 === y2) {
        return `M ${x1} ${y1} L ${x2} ${y2}`;
    }

    if (!flipped) {
        // Vertical first (move y), then Horizontal (move x)
        // Corner at (x1, y2)
        const dx = x2 - x1;
        const dy = y2 - y1;

        // Effective radius cannot exceed segment lengths
        const rx = Math.min(r, Math.abs(dx));
        const ry = Math.min(r, Math.abs(dy));
        const R = Math.min(rx, ry);

        const sy = dy > 0 ? 1 : -1;
        const sx = dx > 0 ? 1 : -1;

        // Start (x1, y1) -> Line to (x1, y2 - sy*R) -> Curve to (x1 + sx*R, y2) -> Line to (x2, y2)
        return `M ${x1} ${y1} L ${x1} ${y2 - sy * R} Q ${x1} ${y2} ${x1 + sx * R} ${y2} L ${x2} ${y2}`;
    } else {
        // Horizontal first (move x), then Vertical (move y)
        // Corner at (x2, y1)
        const dx = x2 - x1;
        const dy = y2 - y1;

        const rx = Math.min(r, Math.abs(dx));
        const ry = Math.min(r, Math.abs(dy));
        const R = Math.min(rx, ry);

        const sx = dx > 0 ? 1 : -1;
        const sy = dy > 0 ? 1 : -1;

        // Start (x1, y1) -> Line to (x2 - sx*R, y1) -> Curve to (x2, y1 + sy*R) -> Line to (x2, y2)
        return `M ${x1} ${y1} L ${x2 - sx * R} ${y1} Q ${x2} ${y1} ${x2} ${y1 + sy * R} L ${x2} ${y2}`;
    }
}

const fmt = (n) => Math.round(n * 100) / 100;

/** A wire through the given corner points: straight segments only, so every bend is a crisp right angle. */
export function pathFromPoints(points) {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${fmt(p.x)} ${fmt(p.y)}`).join(' ');
}

export function createWireElement(wire, wireLayer) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

    path.setAttribute("fill", "none");
    path.setAttribute("stroke", wire.color);
    path.setAttribute("stroke-width", "4");             // thin, like Wokwi (WIRE_WIDTH in wire-interaction-manager.js)
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("marker-start", "url(#wire-end)");
    path.setAttribute("marker-end", "url(#wire-end)");
    path.setAttribute("class", "wire");
    path.setAttribute("style", "pointer-events:stroke; cursor:pointer");

    wireLayer.appendChild(path);
    wire.pathElement = path;

    return path;
}

/** The outline filter and the end-dot marker every wire uses. Colours come from CSS (theme tokens). */
export function addWireDefs(svg) {
    const ns = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(ns, "defs");
    // userSpaceOnUse with a huge region: a perfectly straight wire has a zero-height box, and a filter sized to the box
    // would make it disappear.
    defs.innerHTML = `
        <filter id="wire-casing" filterUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000">
            <feMorphology in="SourceAlpha" operator="dilate" radius="1.6" result="grown"/>
            <feFlood class="wire-casing-color" result="ink"/>
            <feComposite in="ink" in2="grown" operator="in" result="outline"/>
            <feMerge><feMergeNode in="outline"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="wire-casing-selected" filterUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000">
            <feMorphology in="SourceAlpha" operator="dilate" radius="3.2" result="grown"/>
            <feFlood class="wire-casing-selected-color" result="ink"/>
            <feComposite in="ink" in2="grown" operator="in" result="outline"/>
            <feMerge><feMergeNode in="outline"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <marker id="wire-end" viewBox="-10 -10 20 20" markerWidth="2.2" markerHeight="2.2" markerUnits="strokeWidth" refX="0" refY="0" overflow="visible">
            <circle class="wire-joint" r="7"/>
        </marker>`;
    svg.appendChild(defs);
}
