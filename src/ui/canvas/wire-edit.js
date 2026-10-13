/**
 * wire-edit.js — manual changes to a wire's route (no DOM).
 *
 * A manual route is the wire's full path, pin to pin, plus the orientation of every segment:
 *     { points: [{x,y}, ...], orients: ['h' | 'v', ...] }        (orients[i] is the segment points[i] -> points[i+1])
 * Orientations are kept explicitly so a segment that is momentarily zero-length (a bend just inserted) still knows
 * which way it runs. Every operation keeps every segment horizontal or vertical, never moves the two pins, and returns
 * null instead of a broken route when a change is not possible.
 */

const KEY = { h: 'y', v: 'x' };             // the coordinate a segment's two ends share
const MIN_STUB = 12;                        // a wire leaves its pin at least this far before it may turn
const clone = (route) => ({ points: route.points.map((p) => ({ x: p.x, y: p.y })), orients: [...route.orients] });

/** Orientations of a path whose segments are already horizontal or vertical (zero-length: perpendicular to the previous). */
export function orientsOf(points) {
    const orients = [];
    const same = (u, v) => Math.abs(u - v) < 0.05;          // sub-pixel differences are rounding, not a slant
    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        const sx = same(a.x, b.x), sy = same(a.y, b.y);
        if (sy && !sx) orients.push('h');
        else if (sx && !sy) orients.push('v');
        else if (sx && sy) orients.push(orients.length && orients[orients.length - 1] === 'h' ? 'v' : 'h');
        else return null;                                     // a diagonal: not a route this module can keep
    }
    return orients;
}

/**
 * A square path through the given points (a pin, the corners the user clicked, the pointer or the other pin): between
 * two points that are not in line, one corner is added. The first stretch leaves the start pin the way it points
 * (`startDir`); after that the stretches alternate, which is how Wokwi draws a wire while you place its corners.
 */
export function orthogonalThrough(points, startDir = 'right') {
    const out = [{ x: points[0].x, y: points[0].y }];
    let axis = startDir === 'up' || startDir === 'down' ? 'v' : 'h';
    for (let i = 1; i < points.length; i++) {
        const a = out[out.length - 1], b = points[i];
        if (Math.abs(a.x - b.x) < 0.05 || Math.abs(a.y - b.y) < 0.05) {
            out.push({ x: b.x, y: b.y });
            axis = Math.abs(a.y - b.y) < 0.05 ? 'v' : 'h';            // next stretch turns
            continue;
        }
        out.push(axis === 'h' ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
        out.push({ x: b.x, y: b.y });
        // the stretch into b ran along the other axis; the next one turns again
    }
    return out;
}

/** A route from a path (the router's output, or a saved list of points), or null if it is not orthogonal. */
export function routeFromPoints(points) {
    const orients = orientsOf(points);
    if (!orients) return null;
    // make every segment exactly straight (each point takes the shared coordinate of the segment before it; the last
    // segment takes it from the end pin, which never moves)
    const out = points.map((p) => ({ x: p.x, y: p.y }));
    const last = out.length - 1;
    for (let i = 0; i < orients.length; i++) {
        const key = KEY[orients[i]];
        if (i + 1 === last) out[i][key] = out[last][key]; else out[i + 1][key] = out[i][key];
    }
    return { points: out, orients };
}

/**
 * Restore alignment after points[from] changed: walk outward (step +1 or -1) and give each next point the coordinate
 * its segment must share, until nothing more needs to change. Fails (false) if a pin would have to move.
 */
function propagate(route, from, step) {
    const { points, orients } = route;
    const last = points.length - 1;
    for (let i = from; step > 0 ? i < last : i > 0; i += step) {
        const seg = step > 0 ? i : i - 1;
        const key = KEY[orients[seg]];
        const next = i + step;
        if (Math.abs(points[next][key] - points[i][key]) < 0.05) {      // aligned (allowing for rounding)
            if (next !== 0 && next !== last) points[next][key] = points[i][key];
            return true;
        }
        if (next === 0 || next === last) return false;
        points[next][key] = points[i][key];
    }
    return true;
}

const DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/** Both ends still leave their pins the way the pins point, by at least MIN_STUB. */
function stubsOk(route, startDir, endDir) {
    const p = route.points;
    const check = (pin, next, dir) => {
        const [dx, dy] = DIRS[dir] || [0, 0];
        return ((next.x - pin.x) * dx + (next.y - pin.y) * dy) >= MIN_STUB - 0.05
            && Math.abs(dx === 0 ? next.x - pin.x : next.y - pin.y) < 0.05;
    };
    return check(p[0], p[1], startDir) && check(p[p.length - 1], p[p.length - 2], endDir);
}

/** A segment (index) the user may drag: not the first or the last (they are fixed to the pins). */
export const segmentMovable = (route, index) => index > 0 && index < route.orients.length - 1;

/**
 * Drag segment `index` by `delta` across itself (a horizontal segment moves up/down, a vertical one left/right). The
 * neighbouring segments stretch; nothing becomes diagonal; the pins stay put.
 */
export function moveSegment(route, index, delta, { startDir, endDir } = {}) {
    if (!segmentMovable(route, index)) return null;
    const r = clone(route);
    const key = KEY[r.orients[index]];
    r.points[index][key] += delta;
    r.points[index + 1][key] += delta;
    if (!propagate(r, index, -1) || !propagate(r, index + 1, +1)) return null;
    if (startDir && endDir && !stubsOk(r, startDir, endDir)) return null;
    return r;
}

/**
 * Drag a bend (point `index`, never a pin) by (dx, dy): the segment before it moves across by the matching part of
 * the drag, the one after it likewise. A segment fixed to a pin does not move; then the bend slides along it.
 */
export function moveBend(route, index, dx, dy, dirs = {}) {
    if (index <= 0 || index >= route.points.length - 1) return null;
    let r = route;
    for (const seg of [index - 1, index]) {
        if (!segmentMovable(r, seg)) continue;
        const delta = r.orients[seg] === 'h' ? dy : dx;
        if (delta === 0) continue;
        const moved = moveSegment(r, seg, delta, dirs);
        if (moved) r = moved;
    }
    return r === route ? null : r;
}

/** Split segment `index` at `at` with a new bend that can then be dragged out into a step. */
export function insertBend(route, index, at) {
    const r = clone(route);
    const o = r.orients[index];
    const a = r.points[index];
    const q = o === 'h' ? { x: at.x, y: a.y } : { x: a.x, y: at.y };
    r.points.splice(index + 1, 0, { ...q }, { ...q });
    r.orients.splice(index, 1, o, o === 'h' ? 'v' : 'h', o);
    return r;
}

/** Remove zero-length steps and merge straight runs, keeping the pins and every remaining bend. */
export function cleanRoute(route) {
    let r = clone(route);
    let changed = true;
    while (changed) {
        changed = false;
        const { points, orients } = r;
        for (let i = 0; i < orients.length; i++) {
            const a = points[i], b = points[i + 1];
            const zero = a.x === b.x && a.y === b.y;
            if (zero && i > 0 && i + 1 < points.length - 1) {
                if (orients[i - 1] === orients[i + 1]) {
                    // a step of no height between two parallel segments: they are one straight line again
                    points.splice(i, 2);
                    orients.splice(i - 1, 3, orients[i - 1]);
                } else {
                    // a zero stretch at a bend: drop one of its two (identical) points
                    points.splice(i + 1, 1);
                    orients.splice(i, 1);
                }
                changed = true;
                break;
            }
            if (i + 1 < orients.length && orients[i] === orients[i + 1] && i + 1 < points.length - 1) {
                points.splice(i + 1, 1);
                orients.splice(i + 1, 1);
                changed = true;
                break;
            }
        }
        if (changed) r = repairJoins(r);           // safety: every segment's ends share their coordinate again
    }
    return r;
}

/** After a merge, make consecutive points meet again on the shared coordinate of each segment. */
function repairJoins(route) {
    const r = clone(route);
    for (let i = 0; i < r.orients.length; i++) {
        const key = KEY[r.orients[i]];
        if (r.points[i][key] !== r.points[i + 1][key]) {
            if (i + 1 === r.points.length - 1) r.points[i][key] = r.points[i + 1][key];
            else r.points[i + 1][key] = r.points[i][key];
        }
    }
    return r;
}

/**
 * The pins moved (a part was dragged or rotated): keep the route's shape, re-attach both ends, and keep each end's
 * first stretch leaving its pin the right way. Returns null if the shape cannot be kept (the caller then routes the
 * wire automatically again).
 */
export function adaptRoute(route, start, end, startDir, endDir) {
    const r = clone(route);
    const last = r.points.length - 1;
    if (r.points.length < 3) return null;
    const moveEnd = (pinIdx, nextIdx, to, dir, step) => {
        const dx = to.x - r.points[pinIdx].x, dy = to.y - r.points[pinIdx].y;
        r.points[pinIdx] = { x: to.x, y: to.y };
        // the first bend moves with its pin, so the short stretch out of the pin keeps its length and direction
        if (nextIdx !== 0 && nextIdx !== last) { r.points[nextIdx].x += dx; r.points[nextIdx].y += dy; }
        return propagate(r, nextIdx, step);
    };
    if (!moveEnd(0, 1, start, startDir, +1)) return null;
    if (!moveEnd(last, last - 1, end, endDir, -1)) return null;
    if (!propagate(r, 1, -1) || !propagate(r, last - 1, +1)) return null;
    if (orientsOf(r.points) === null) return null;
    return startDir && endDir && !stubsOk(r, startDir, endDir) ? null : r;
}

/** True if any segment except the two at the pins runs through one of the rectangles. */
export function crossesAny(route, rects) {
    const p = route.points;
    for (let i = 1; i < p.length - 2; i++) {
        const a = p[i], b = p[i + 1];
        const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x), top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
        if (rects.some((o) => left < o.right && right > o.left && top < o.bottom && bottom > o.top)) return true;
    }
    return false;
}
