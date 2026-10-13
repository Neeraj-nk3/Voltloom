/**
 * wire-router.js — schematic-style wire routing (no DOM, so it can be unit-tested).
 *
 * All wires are routed together, shortest first, on a sparse orthogonal grid:
 *   - every wire leaves each pin straight out (a "stub") in the direction the pin points, so it never runs along a
 *     part's body or the board's header;
 *   - between the stubs, an A* search finds a path of horizontal and vertical segments that avoids the board and the
 *     parts, prefers few bends, never shares a segment with an earlier wire, rarely crosses one, and keeps a lane of
 *     space from wires running alongside it.
 * The result is crisp 90° geometry with distinct, evenly spaced tracks. All values are in canvas ("local") units.
 */

const DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const H = 1;                    // axis of a horizontal move
const V = 2;                    // axis of a vertical move

const BEND = 30;                // a corner costs as much as 30 units of length
const OVERLAP = 1000;           // sharing a segment with another wire: practically forbidden
const CROSS = 20;               // crossing another wire: allowed, but avoided when cheap
const ALONGSIDE = 8;            // running right next to another wire: spread out instead

/** Smallest binary heap of [priority, value]. */
class Heap {
    constructor() { this.items = []; }
    get size() { return this.items.length; }
    push(priority, value) {
        const a = this.items;
        a.push([priority, value]);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p][0] <= a[i][0]) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }
    pop() {
        const a = this.items;
        const top = a[0];
        const last = a.pop();
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < a.length && a[l][0] < a[m][0]) m = l;
                if (r < a.length && a[r][0] < a[m][0]) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]];
                i = m;
            }
        }
        return top;
    }
}

const uniqueSorted = (values) => [...new Set(values.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);

/** Remove repeated points and points in the middle of a straight run. */
export function simplify(points) {
    const out = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (last && last.x === p.x && last.y === p.y) continue;
        out.push(p);
        while (out.length >= 3) {
            const [a, b, c] = out.slice(-3);
            if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) !== 0) break;
            out.splice(out.length - 2, 1);
        }
    }
    return out;
}

/**
 * @param {Array<{id:string, start:{x,y,dir,stub}, end:{x,y,dir,stub}}>} requests
 *        dir: 'left'|'right'|'up'|'down' (where the pin points); stub: how far to go straight out before turning
 * @param {Array<{left,top,right,bottom}>} obstacles   rectangles no wire may enter (board, parts, already with margin)
 * @param {{grid?:number, margin?:number, fixed?:Array<{id:string, points:Array<{x,y}>}>}} [options]
 *        fixed: wires the user routed by hand. They are kept exactly as given, and the other wires are routed around
 *        them as if they were earlier wires (no shared segments, few crossings).
 * @returns {Map<string, Array<{x:number,y:number}>>}  corner points of each wire, pin to pin
 */
export function routeWires(requests, obstacles, { grid = 20, margin = 160, fixed = [] } = {}) {
    const routes = new Map();
    for (const f of fixed) routes.set(f.id, f.points);
    if (requests.length === 0) return routes;

    const stubPoint = (end) => {
        const [dx, dy] = DIRS[end.dir] || [0, 0];
        return { x: end.x + dx * end.stub, y: end.y + dy * end.stub };
    };
    // every coordinate on the same 0.01 grid, so pins, stubs and grid lines meet exactly
    const r2 = (v) => Math.round(v * 100) / 100;
    const snapEnd = (e) => ({ ...e, x: r2(e.x), y: r2(e.y) });
    const jobs = requests.map((r) => {
        const start = snapEnd(r.start), end = snapEnd(r.end);
        const s1 = stubPoint(start), e1 = stubPoint(end);
        return { ...r, start, end, s1: { x: r2(s1.x), y: r2(s1.y) }, e1: { x: r2(e1.x), y: r2(e1.y) } };
    });

    // ── the grid: regular lines, plus a line through every stub point (so routes meet stubs without a jog) ──
    const fixedPts = fixed.flatMap((f) => f.points);
    const allX = jobs.flatMap((j) => [j.s1.x, j.e1.x, j.start.x, j.end.x]).concat(obstacles.flatMap((o) => [o.left, o.right]), fixedPts.map((p) => p.x));
    const allY = jobs.flatMap((j) => [j.s1.y, j.e1.y, j.start.y, j.end.y]).concat(obstacles.flatMap((o) => [o.top, o.bottom]), fixedPts.map((p) => p.y));
    const minX = Math.floor((Math.min(...allX) - margin) / grid) * grid;
    const maxX = Math.ceil((Math.max(...allX) + margin) / grid) * grid;
    const minY = Math.floor((Math.min(...allY) - margin) / grid) * grid;
    const maxY = Math.ceil((Math.max(...allY) + margin) / grid) * grid;
    const regular = (from, to) => { const out = []; for (let v = from; v <= to; v += grid) out.push(v); return out; };
    const xs = uniqueSorted(regular(minX, maxX).concat(jobs.flatMap((j) => [j.s1.x, j.e1.x]), fixedPts.map((p) => p.x)));
    const ys = uniqueSorted(regular(minY, maxY).concat(jobs.flatMap((j) => [j.s1.y, j.e1.y]), fixedPts.map((p) => p.y)));
    const nx = xs.length, ny = ys.length;
    const id = (i, k) => i * ny + k;

    const within = (o, x, y) => x > o.left && x < o.right && y > o.top && y < o.bottom;
    // Obstacles that hold one of a wire's own stub points (a part placed on top of the board, say) cannot be avoided
    // by that wire, so they are ignored for it; everything else stays blocked.
    const blockedFor = (job) => {
        const active = obstacles.filter((o) => !within(o, job.s1.x, job.s1.y) && !within(o, job.e1.x, job.e1.y));
        const inside = (x, y) => active.some((o) => within(o, x, y));
        const blocked = new Uint8Array(nx * ny);
        for (let i = 0; i < nx; i++) for (let k = 0; k < ny; k++) blocked[id(i, k)] = inside(xs[i], ys[k]) ? 1 : 0;
        return { blocked, inside };
    };

    const indexOf = (arr, v) => arr.indexOf(Math.round(v * 100) / 100);

    // ── what earlier wires occupy ──
    const usedEdges = new Map();      // "a|b" -> count   (a < b, node ids)
    const nodeAxes = new Map();       // node -> bitmask of axes used through it (H | V)
    const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

    // Hand-routed wires occupy their grid edges first, so automatic wires keep out of their way.
    for (const f of fixed) {
        for (let n = 1; n < f.points.length; n++) {
            const a = f.points[n - 1], b = f.points[n];
            const horizontal = a.y === b.y;
            const fixedIdx = horizontal ? indexOf(ys, a.y) : indexOf(xs, a.x);
            const from = horizontal ? indexOf(xs, Math.min(a.x, b.x)) : indexOf(ys, Math.min(a.y, b.y));
            const to = horizontal ? indexOf(xs, Math.max(a.x, b.x)) : indexOf(ys, Math.max(a.y, b.y));
            if (fixedIdx < 0 || from < 0 || to < 0) continue;
            for (let t = from; t < to; t++) {
                const u = horizontal ? id(t, fixedIdx) : id(fixedIdx, t);
                const v = horizontal ? id(t + 1, fixedIdx) : id(fixedIdx, t + 1);
                usedEdges.set(edgeKey(u, v), (usedEdges.get(edgeKey(u, v)) || 0) + 1);
                nodeAxes.set(u, (nodeAxes.get(u) || 0) | (horizontal ? H : V));
                nodeAxes.set(v, (nodeAxes.get(v) || 0) | (horizontal ? H : V));
            }
        }
    }

    const stepCost = (from, to, axis) => {
        let cost = Math.abs(xs[Math.floor(to / ny)] - xs[Math.floor(from / ny)]) + Math.abs(ys[to % ny] - ys[from % ny]);
        if (usedEdges.has(edgeKey(from, to))) cost += OVERLAP;
        const axes = nodeAxes.get(to) || 0;
        if (axes & (axis === H ? V : H)) cost += CROSS;
        // a wire one line over, running the same way, is too close: prefer a free lane
        const fi = Math.floor(from / ny), fk = from % ny, ti = Math.floor(to / ny), tk = to % ny;
        const sides = axis === H ? [[0, -1], [0, 1]] : [[-1, 0], [1, 0]];
        for (const [di, dk] of sides) {
            const a = fi + di, b = fk + dk, c = ti + di, d = tk + dk;
            if (a < 0 || c < 0 || a >= nx || c >= nx || b < 0 || d < 0 || b >= ny || d >= ny) continue;
            if (usedEdges.has(edgeKey(id(a, b), id(c, d)))) cost += ALONGSIDE;
        }
        return cost;
    };

    const axisOf = (dir) => (dir === 'left' || dir === 'right' ? H : V);

    function search(job) {
        const { blocked, inside } = blockedFor(job);
        const si = indexOf(xs, job.s1.x), sk = indexOf(ys, job.s1.y);
        const ei = indexOf(xs, job.e1.x), ek = indexOf(ys, job.e1.y);
        if (si < 0 || sk < 0 || ei < 0 || ek < 0) return null;
        const start = id(si, sk), goal = id(ei, ek);
        const startAxis = axisOf(job.start.dir);
        const goalAxis = axisOf(job.end.dir);          // arriving along the end stub's axis needs no extra corner

        const N = nx * ny;
        const best = new Float64Array(N * 3).fill(Infinity);
        const prev = new Int32Array(N * 3).fill(-1);
        const heap = new Heap();
        const h = (n) => Math.abs(xs[Math.floor(n / ny)] - xs[ei]) + Math.abs(ys[n % ny] - ys[ek]);
        const state = (n, axis) => n * 3 + axis;
        best[state(start, startAxis)] = 0;
        heap.push(h(start), state(start, startAxis));

        while (heap.size) {
            const [, s] = heap.pop();
            const n = Math.floor(s / 3), axis = s % 3;
            const g = best[s];
            if (n === goal) {
                const pts = [];
                for (let cur = s; cur !== -1; cur = prev[cur]) {
                    const node = Math.floor(cur / 3);
                    pts.push({ x: xs[Math.floor(node / ny)], y: ys[node % ny] });
                }
                return { points: pts.reverse(), nodes: (() => { const ns = []; for (let cur = s; cur !== -1; cur = prev[cur]) ns.push(Math.floor(cur / 3)); return ns.reverse(); })() };
            }
            const i = Math.floor(n / ny), k = n % ny;
            for (const [di, dk, moveAxis] of [[1, 0, H], [-1, 0, H], [0, 1, V], [0, -1, V]]) {
                const a = i + di, b = k + dk;
                if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
                const m = id(a, b);
                if (blocked[m] && m !== goal) continue;
                // an edge whose middle lies inside an obstacle would cut through it
                if (inside((xs[i] + xs[a]) / 2, (ys[k] + ys[b]) / 2)) continue;
                let cost = g + stepCost(n, m, moveAxis);
                if (axis !== moveAxis) cost += BEND;
                if (m === goal && moveAxis !== goalAxis) cost += BEND;
                const t = state(m, moveAxis);
                if (cost < best[t]) {
                    best[t] = cost;
                    prev[t] = s;
                    heap.push(cost + h(m), t);
                }
            }
        }
        return null;
    }

    // shortest first: short local hops stay compact; long runs take the free outer lanes
    const order = [...jobs].sort((a, b) => {
        const la = Math.abs(a.s1.x - a.e1.x) + Math.abs(a.s1.y - a.e1.y);
        const lb = Math.abs(b.s1.x - b.e1.x) + Math.abs(b.s1.y - b.e1.y);
        return la - lb || String(a.id).localeCompare(String(b.id));
    });

    for (const job of order) {
        const found = search(job);
        let middle;
        if (found) {
            middle = found.points;
            for (let n = 1; n < found.nodes.length; n++) {
                const a = found.nodes[n - 1], b = found.nodes[n];
                usedEdges.set(edgeKey(a, b), (usedEdges.get(edgeKey(a, b)) || 0) + 1);
                const axis = Math.floor(a / ny) === Math.floor(b / ny) ? V : H;
                nodeAxes.set(a, (nodeAxes.get(a) || 0) | axis);
                nodeAxes.set(b, (nodeAxes.get(b) || 0) | axis);
            }
        } else {
            middle = [job.s1, { x: job.e1.x, y: job.s1.y }, job.e1];          // no way round: a plain right angle
        }
        routes.set(job.id, simplify([{ x: job.start.x, y: job.start.y }, ...middle, { x: job.end.x, y: job.end.y }]));
    }
    return routes;
}
