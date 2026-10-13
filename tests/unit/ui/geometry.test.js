import { describe, it, expect } from 'vitest';
import {
  MIN_SCALE, MAX_SCALE, clampScale, wheelDeltaPx, wheelZoomFactor, zoomAt, toViewport, fitView, isVisible,
  unionBounds, transformPortOffset, partBounds, placeFloating, spawnPosition
} from '../../../src/ui/canvas/geometry.js';

const close = (a, b, digits = 6) => expect(a).toBeCloseTo(b, digits);

describe('zoom', () => {
  it('clamps the scale', () => {
    expect(clampScale(0.001)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
  });

  it('keeps the local point under the anchor fixed, at any scale and pan', () => {
    for (const view of [{ scale: 0.3, x: 10, y: 20 }, { scale: 1, x: -400, y: 55 }, { scale: 2.5, x: 123, y: -77 }]) {
      const anchor = { x: 321, y: 234 };
      const local = { x: (anchor.x - view.x) / view.scale, y: (anchor.y - view.y) / view.scale };
      for (const next of [0.1, 0.5, 1, 3, 5]) {
        const zoomed = zoomAt(view, next, anchor);
        const on = toViewport(zoomed, local);
        close(on.x, anchor.x);
        close(on.y, anchor.y);
      }
    }
  });

  it('does not move the view when the scale is already at the limit', () => {
    const view = { scale: MAX_SCALE, x: 50, y: 60 };
    expect(zoomAt(view, 50, { x: 10, y: 10 })).toEqual(view);
  });

  it('normalises wheel units and limits one event to one notch', () => {
    expect(wheelDeltaPx({ deltaY: 100, deltaMode: 0 })).toBe(100);
    expect(wheelDeltaPx({ deltaY: 3, deltaMode: 1 })).toBe(48);            // three lines
    expect(wheelDeltaPx({ deltaY: 1, deltaMode: 2 })).toBe(120);           // one page, limited
    expect(wheelDeltaPx({ deltaY: -5000, deltaMode: 0 })).toBe(-120);
  });

  it('wheel zoom is multiplicative: in then out returns to the start', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    close(wheelZoomFactor(-100) * wheelZoomFactor(100), 1);
  });
});

describe('fit and visibility', () => {
  const size = { width: 800, height: 600 };

  it('centres the content and never zooms in past the cap', () => {
    const view = fitView({ left: 0, top: 0, right: 100, bottom: 50 }, size, { padding: 0, maxScale: 1 });
    expect(view.scale).toBe(1);
    close(view.x, 350);
    close(view.y, 275);
  });

  it('shrinks large content to fit with padding', () => {
    const bounds = { left: -200, top: -100, right: 1800, bottom: 1400 };
    const view = fitView(bounds, size, { padding: 40 });
    const a = toViewport(view, { x: bounds.left, y: bounds.top });
    const b = toViewport(view, { x: bounds.right, y: bounds.bottom });
    expect(a.x).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(a.y).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(b.x).toBeLessThanOrEqual(760 + 1e-6);
    expect(b.y).toBeLessThanOrEqual(560 + 1e-6);
    close((a.x + b.x) / 2, 400);
    close((a.y + b.y) / 2, 300);
  });

  it('knows whether any content is on screen', () => {
    const bounds = { left: 0, top: 0, right: 100, bottom: 100 };
    expect(isVisible({ scale: 1, x: 10, y: 10 }, bounds, size)).toBe(true);
    expect(isVisible({ scale: 1, x: 5000, y: 10 }, bounds, size)).toBe(false);
    expect(isVisible({ scale: 1, x: -150, y: 10 }, bounds, size)).toBe(false);
  });

  it('unions rectangles and ignores missing ones', () => {
    expect(unionBounds([])).toBeNull();
    expect(unionBounds([null, { left: 0, top: 0, right: 5, bottom: 5 }, { left: -2, top: 3, right: 9, bottom: 4 }]))
      .toEqual({ left: -2, top: 0, right: 9, bottom: 5 });
  });
});

describe('transformPortOffset (matches CSS rotate() then scaleX about the centre)', () => {
  const size = [220, 40];
  const pin2 = [220, 20];

  it('is the identity for an unrotated, unflipped part', () => {
    expect(transformPortOffset(pin2, size, 0, false)).toEqual(pin2);
  });

  it('rotates a horizontal resistor clockwise', () => {
    // centre (110, 20): pin 2 is 110 right of the centre; a clockwise quarter turn puts it 110 below
    expect(transformPortOffset(pin2, size, 90)).toEqual([110, 130]);
    expect(transformPortOffset(pin2, size, 180)).toEqual([0, 20]);
    expect(transformPortOffset(pin2, size, 270)).toEqual([110, -90]);
    expect(transformPortOffset(pin2, size, 360)).toEqual(pin2);
  });

  it('flips left-right about the centre, before rotating', () => {
    const led = [100, 200];
    expect(transformPortOffset([80, 155], led, 0, true)).toEqual([20, 155]);
    // flip then rotate 90: (80,155) -> relative (30,55) -> flipped (-30,55) -> rotated (-55,-30)
    expect(transformPortOffset([80, 155], led, 90, true)).toEqual([-5, 70]);
  });

  it('four quarter turns return to the start for any pin', () => {
    for (const pin of [[11, 50], [195, 107], [0, 0]]) {
      let p = pin;
      for (let i = 0; i < 4; i++) p = transformPortOffset(p, [200, 130], 90);
      p.forEach((v, i) => close(v, pin[i]));
    }
  });

  it('computes the bounding box of a rotated part', () => {
    expect(partBounds(400, 300, [220, 40], 0)).toEqual({ left: 400, top: 300, right: 620, bottom: 340 });
    expect(partBounds(400, 300, [220, 40], 90)).toEqual({ left: 490, top: 210, right: 530, bottom: 430 });
  });
});

describe('spawnPosition (where a new part goes)', () => {
  const viewport = { width: 800, height: 600 };
  const board = { left: 0, top: 0, right: 400, bottom: 1000 };
  const view = { scale: 0.5, x: 100, y: 20 };                       // board fills the left half of the screen
  const overlapsRect = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const box = (p, [w, h]) => ({ left: p.x, top: p.y, right: p.x + w, bottom: p.y + h });
  const visibleLocal = { left: -200, top: -40, right: 1400, bottom: 1160 };
  const inside = (r) => r.left >= visibleLocal.left && r.top >= visibleLocal.top && r.right <= visibleLocal.right && r.bottom <= visibleLocal.bottom;

  it('puts the first part beside the board, on screen, not on its pins', () => {
    const p = spawnPosition(view, viewport, [100, 200], [board], { board });
    const r = box(p, [100, 200]);
    expect(overlapsRect(r, board)).toBe(false);
    expect(r.left).toBeGreaterThanOrEqual(board.right);
    expect(inside(r)).toBe(true);
  });

  it('never stacks parts: each new one finds a free spot', () => {
    const occupied = [board];
    for (let i = 0; i < 8; i++) {
      const size = i % 2 ? [220, 40] : [100, 200];
      const r = box(spawnPosition(view, viewport, size, occupied, { board }), size);
      for (const o of occupied) expect(overlapsRect(r, o)).toBe(false);
      occupied.push(r);
    }
  });

  it('uses the middle of the view when the board is off screen', () => {
    const far = { scale: 1, x: -5000, y: -5000 };
    const p = spawnPosition(far, viewport, [100, 200], [board], { board });
    expect(p.x).toBe(5000 + 400 - 50);
    expect(p.y).toBe(5000 + 300 - 100);
  });

  it('returns whole numbers (positions are saved in projects)', () => {
    const p = spawnPosition({ scale: 0.37, x: 13.3, y: 7.7 }, viewport, [200, 130], [board], { board });
    expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
  });
});

describe('placeFloating', () => {
  const bounds = { left: 0, top: 0, right: 800, bottom: 600 };
  const box = { width: 200, height: 100 };

  it('sits above the anchor when there is room', () => {
    const pos = placeFloating({ left: 300, top: 300, right: 400, bottom: 340 }, box, bounds);
    expect(pos.placement).toBe('above');
    expect(pos.left).toBe(250);
    expect(pos.top).toBe(300 - 10 - 100);
  });

  it('flips below when the anchor is near the top edge', () => {
    const pos = placeFloating({ left: 300, top: 20, right: 400, bottom: 60 }, box, bounds);
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(70);
  });

  it('can prefer below, and falls back to above when there is no room underneath', () => {
    const roomy = placeFloating({ left: 300, top: 100, right: 400, bottom: 140 }, box, bounds, { prefer: 'below' });
    expect(roomy.placement).toBe('below');
    expect(roomy.top).toBe(150);
    const cramped = placeFloating({ left: 300, top: 400, right: 400, bottom: 590 }, box, bounds, { prefer: 'below' });
    expect(cramped.placement).toBe('above');
  });

  it('stays inside the bounds on every side', () => {
    for (const anchor of [
      { left: -50, top: 250, right: -10, bottom: 280 },
      { left: 790, top: 250, right: 830, bottom: 280 },
      { left: 100, top: 590, right: 140, bottom: 640 },
      { left: 100, top: -80, right: 140, bottom: -20 }
    ]) {
      const pos = placeFloating(anchor, box, bounds);
      expect(pos.left).toBeGreaterThanOrEqual(8);
      expect(pos.left + box.width).toBeLessThanOrEqual(792);
      expect(pos.top).toBeGreaterThanOrEqual(8);
      expect(pos.top + box.height).toBeLessThanOrEqual(592);
    }
  });

  it('pins to the gutter when the box is larger than the area', () => {
    const pos = placeFloating({ left: 10, top: 10, right: 20, bottom: 20 }, { width: 900, height: 700 }, bounds);
    expect(pos.left).toBe(8);
    expect(pos.top).toBe(8);
  });
});
