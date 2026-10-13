/**
 * geometry.js — the arithmetic behind the circuit canvas (no DOM, so it can be unit-tested).
 *
 * The canvas draws everything inside one element (#board-container) that is moved with
 *     transform: translate(x px, y px) scale(s)      (transform-origin: 0 0)
 * so a point p in the container's own coordinates ("local" units) appears on screen at
 *     viewport = (x, y) + s * p
 * where "viewport" means pixels from the top-left corner of the canvas area. Every function here works in
 * one of those two spaces and says which.
 */

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 5;

export function clampScale(scale) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

// ---------- Wheel zoom ----------

const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 800;
const MAX_WHEEL_STEP_PX = 120;      // a single event never zooms more than one mouse-wheel notch
const WHEEL_ZOOM_RATE = 0.0015;     // exp(-120 * 0.0015) ≈ 0.84 per notch

/** The vertical wheel movement of an event in pixels, whatever unit the device reports (pixels, lines or pages). */
export function wheelDeltaPx(event) {
    const unit = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? PAGE_HEIGHT_PX : 1;
    const px = event.deltaY * unit;
    return Math.max(-MAX_WHEEL_STEP_PX, Math.min(MAX_WHEEL_STEP_PX, px));
}

/** Multiplier for the zoom scale: wheel up (negative delta) zooms in. Multiplicative, so every step feels the same size. */
export function wheelZoomFactor(deltaPx) {
    return Math.exp(-deltaPx * WHEEL_ZOOM_RATE);
}

// ---------- View (pan + zoom) ----------

/**
 * Change the scale while the local point under `anchor` (viewport pixels) stays under it.
 * @param {{scale:number,x:number,y:number}} view
 * @param {number} nextScale
 * @param {{x:number,y:number}} anchor
 */
export function zoomAt(view, nextScale, anchor) {
    const scale = clampScale(nextScale);
    const localX = (anchor.x - view.x) / view.scale;
    const localY = (anchor.y - view.y) / view.scale;
    return { scale, x: anchor.x - localX * scale, y: anchor.y - localY * scale };
}

/** Local point -> viewport pixels. */
export function toViewport(view, point) {
    return { x: view.x + view.scale * point.x, y: view.y + view.scale * point.y };
}

/**
 * The view that shows `bounds` (local units) fully inside a viewport of `size` pixels, centred, never zoomed in past `maxScale`.
 * @param {{left:number,top:number,right:number,bottom:number}} bounds
 * @param {{width:number,height:number}} size
 */
export function fitView(bounds, size, { padding = 32, maxScale = 1 } = {}) {
    const width = Math.max(1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    const availableW = Math.max(1, size.width - 2 * padding);
    const availableH = Math.max(1, size.height - 2 * padding);
    const scale = clampScale(Math.min(availableW / width, availableH / height, maxScale));
    return {
        scale,
        x: (size.width - width * scale) / 2 - bounds.left * scale,
        y: (size.height - height * scale) / 2 - bounds.top * scale
    };
}

/** True when any part of `bounds` (local units) is inside the viewport under `view`, with `margin` pixels of tolerance. */
export function isVisible(view, bounds, size, margin = 0) {
    const left = view.x + view.scale * bounds.left;
    const right = view.x + view.scale * bounds.right;
    const top = view.y + view.scale * bounds.top;
    const bottom = view.y + view.scale * bounds.bottom;
    return right > margin && bottom > margin && left < size.width - margin && top < size.height - margin;
}

/** Smallest rectangle containing all the given rectangles, or null for none. */
export function unionBounds(list) {
    const rects = list.filter(Boolean);
    if (rects.length === 0) return null;
    return {
        left: Math.min(...rects.map((r) => r.left)),
        top: Math.min(...rects.map((r) => r.top)),
        right: Math.max(...rects.map((r) => r.right)),
        bottom: Math.max(...rects.map((r) => r.bottom))
    };
}

// ---------- Parts: rotation and flip ----------

/**
 * Where a pin lands after the part is flipped and rotated. The page draws a part with
 *     transform: rotate(<rotation>deg) scaleX(<-1 if flipped>)       (transform-origin: centre of the part)
 * so the flip is applied first, then the rotation, both about the centre of the unrotated box.
 *
 * @param {[number, number]} offset    pin position inside the unrotated part (local units, from its top-left corner)
 * @param {[number, number]} size      [width, height] of the unrotated part
 * @param {number} rotation            degrees clockwise (multiples of 90 in practice)
 * @param {boolean} flipped            mirrored left-right before rotating
 * @returns {[number, number]}         position relative to the part's unrotated top-left corner
 */
export function transformPortOffset(offset, size, rotation = 0, flipped = false) {
    const cx = size[0] / 2;
    const cy = size[1] / 2;
    let x = offset[0] - cx;
    let y = offset[1] - cy;
    if (flipped) x = -x;
    const turns = ((Math.round(rotation / 90) % 4) + 4) % 4;      // exact for quarter turns: no floating-point noise in wire paths
    for (let i = 0; i < turns; i++) { const nx = -y; y = x; x = nx; }
    return [cx + x, cy + y];
}

/** Bounding box (local units) of a part placed at (x, y) with the given size and rotation. */
export function partBounds(x, y, size, rotation = 0) {
    const corners = [[0, 0], [size[0], 0], [0, size[1]], [size[0], size[1]]].map((c) => transformPortOffset(c, size, rotation, false));
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    return { left: x + Math.min(...xs), top: y + Math.min(...ys), right: x + Math.max(...xs), bottom: y + Math.max(...ys) };
}

// ---------- Where a new part goes ----------

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * A free spot (local units, top-left corner) for a new part: beside the board when the board is on screen, otherwise in
 * the middle of what the viewer is looking at. Spots already taken by the board or another part are skipped, so parts
 * never land on the board's pins or on top of each other.
 *
 * @param {{scale:number,x:number,y:number}} view
 * @param {{width:number,height:number}} viewport     canvas size in pixels
 * @param {[number, number]} partSize                 [width, height] of the new part
 * @param {Array<{left:number,top:number,right:number,bottom:number}>} occupied   board and existing parts
 * @param {{board?: object, gap?: number}} [options]  board: its rectangle, used to place parts next to it
 * @returns {{x:number, y:number}}
 */
export function spawnPosition(view, viewport, partSize, occupied, { board = null, gap = 64 } = {}) {
    const s = view.scale;
    const visible = { left: -view.x / s, top: -view.y / s, right: (viewport.width - view.x) / s, bottom: (viewport.height - view.y) / s };
    const [w, h] = partSize;
    const pad = 16 / s;                                  // keep clear of the canvas edge
    const middleY = (visible.top + visible.bottom) / 2 - h / 2;

    const starts = [];
    if (board && overlaps(board, visible)) {
        const y = Math.max(visible.top + pad, Math.min(middleY, visible.bottom - pad - h));
        starts.push({ x: board.right + gap, y });            // right of the board, then left of it
        starts.push({ x: board.left - gap - w, y });
    }
    starts.push({ x: (visible.left + visible.right) / 2 - w / 2, y: middleY });

    const rectAt = (x, y) => ({ left: x, top: y, right: x + w, bottom: y + h });
    const inside = (r) => r.left >= visible.left && r.top >= visible.top && r.right <= visible.right && r.bottom <= visible.bottom;
    const free = (r) => !occupied.some((o) => overlaps(r, { left: o.left - 8, top: o.top - 8, right: o.right + 8, bottom: o.bottom + 8 }));

    // Try each start, then the spots below and beside it on a grid the size of the part, nearest first.
    let fallback = null;
    for (const start of starts) {
        const spots = [];
        for (let col = 0; col < 6; col++) {
            for (let row = -4; row <= 4; row++) spots.push({ col, row, d: col * col + row * row });
        }
        spots.sort((a, b) => a.d - b.d);
        for (const { col, row } of spots) {
            const dir = start === starts[1] && starts.length === 3 ? -1 : 1;    // left of the board grows leftwards
            const x = start.x + dir * col * (w + 24);
            const y = start.y + row * (h + 24);
            const r = rectAt(x, y);
            if (!free(r)) continue;
            if (inside(r)) return { x: Math.round(x), y: Math.round(y) };
            if (!fallback) fallback = { x: Math.round(x), y: Math.round(y) };
        }
    }
    return fallback || { x: Math.round(starts[starts.length - 1].x), y: Math.round(starts[starts.length - 1].y) };
}

// ---------- Floating UI (popover, tooltip) ----------

/**
 * Place a floating box next to an anchor and keep it fully inside `bounds`.
 * Uses the preferred side (above by default) when the box fits there, otherwise the other side, otherwise whichever side
 * has more room; centred on the anchor horizontally. All values share one coordinate space (for example viewport pixels).
 *
 * @param {{left:number,top:number,right:number,bottom:number}} anchor
 * @param {{width:number,height:number}} size       measured size of the floating box
 * @param {{left:number,top:number,right:number,bottom:number}} bounds
 * @param {{gap?:number, gutter?:number, prefer?:'above'|'below'}} [options]
 * @returns {{left:number, top:number, placement:'above'|'below'}}
 */
export function placeFloating(anchor, size, bounds, { gap = 10, gutter = 8, prefer = 'above' } = {}) {
    const room = {
        above: anchor.top - bounds.top - gutter,
        below: bounds.bottom - anchor.bottom - gutter
    };
    const need = size.height + gap;
    const other = prefer === 'above' ? 'below' : 'above';
    let placement = prefer;
    if (room[prefer] < need && (room[other] >= need || room[other] > room[prefer])) placement = other;

    const rawTop = placement === 'above' ? anchor.top - gap - size.height : anchor.bottom + gap;
    const rawLeft = (anchor.left + anchor.right) / 2 - size.width / 2;

    const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
    return {
        left: clamp(rawLeft, bounds.left + gutter, bounds.right - gutter - size.width),
        top: clamp(rawTop, bounds.top + gutter, bounds.bottom - gutter - size.height),
        placement
    };
}
