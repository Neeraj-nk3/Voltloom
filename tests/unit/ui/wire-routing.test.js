import { describe, it, expect } from 'vitest';
import { routeWires, simplify } from '../../../src/ui/canvas/wire-router.js';
import {
  orthogonalThrough, routeFromPoints, moveSegment, moveBend, insertBend, cleanRoute, adaptRoute, crossesAny
} from '../../../src/ui/canvas/wire-edit.js';

// Wires are schematic-style: horizontal and vertical segments only, each wire in its own lane, around the board and
// the parts, and always ending exactly on its pins. Shapes the user draws or drags by hand keep those rules too.

const orthogonal = (pts) => pts.every((p, i) => i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y);
const segments = (pts) => pts.slice(1).map((p, i) => [pts[i], p]);
const insideRect = (p, r) => p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom;

const BOARD = { left: -4, top: -4, right: 404, bottom: 1004 };

describe('routeWires (automatic routing)', () => {
  const requests = [
    { id: 'a', start: { x: 388, y: 120, dir: 'right', stub: 34 }, end: { x: 600, y: 455, dir: 'down', stub: 69 } },
    { id: 'b', start: { x: 388, y: 168, dir: 'right', stub: 34 }, end: { x: 555, y: 450, dir: 'down', stub: 89 } },
    { id: 'c', start: { x: 12, y: 300, dir: 'left', stub: 34 }, end: { x: 760, y: 455, dir: 'down', stub: 69 } },
  ];
  const parts = [{ left: 514, top: 294, right: 626, bottom: 506 }, { left: 674, top: 294, right: 786, bottom: 506 }];
  const routes = routeWires(requests, [BOARD, ...parts]);

  it('routes every wire, starting and ending exactly on its pins', () => {
    for (const r of requests) {
      const pts = routes.get(r.id);
      expect(pts[0]).toEqual({ x: r.start.x, y: r.start.y });
      expect(pts[pts.length - 1]).toEqual({ x: r.end.x, y: r.end.y });
    }
  });

  it('uses only horizontal and vertical segments', () => {
    for (const pts of routes.values()) expect(orthogonal(pts)).toBe(true);
  });

  it('leaves each pin the way the pin points', () => {
    const a = routes.get('a');
    expect(a[1].y).toBe(a[0].y);
    expect(a[1].x).toBeGreaterThan(a[0].x);           // a right-header pin: out to the right
    const c = routes.get('c');
    expect(c[1].x).toBeLessThan(c[0].x);              // a left-header pin: out to the left
  });

  it('never runs through the board or a part between its stubs', () => {
    for (const pts of routes.values()) {
      for (const p of pts.slice(2, -2)) {
        expect(insideRect(p, BOARD)).toBe(false);
        for (const part of parts) expect(insideRect(p, part)).toBe(false);
      }
    }
  });

  it('no two wires share a segment', () => {
    const lines = [...routes.values()].flatMap((pts) => segments(pts).map(([p, q]) => ({ p, q })));
    const overlap = (s, t) => {
      if (s.p.y === s.q.y && t.p.y === t.q.y && s.p.y === t.p.y) {
        const [a1, a2] = [Math.min(s.p.x, s.q.x), Math.max(s.p.x, s.q.x)];
        const [b1, b2] = [Math.min(t.p.x, t.q.x), Math.max(t.p.x, t.q.x)];
        return Math.min(a2, b2) - Math.max(a1, b1) > 1;
      }
      if (s.p.x === s.q.x && t.p.x === t.q.x && s.p.x === t.p.x) {
        const [a1, a2] = [Math.min(s.p.y, s.q.y), Math.max(s.p.y, s.q.y)];
        const [b1, b2] = [Math.min(t.p.y, t.q.y), Math.max(t.p.y, t.q.y)];
        return Math.min(a2, b2) - Math.max(a1, b1) > 1;
      }
      return false;
    };
    const byWire = [...routes.entries()].map(([id, pts]) => ({ id, segs: segments(pts).map(([p, q]) => ({ p, q })) }));
    for (let i = 0; i < byWire.length; i++) {
      for (let j = i + 1; j < byWire.length; j++) {
        for (const s of byWire[i].segs) for (const t of byWire[j].segs) expect(overlap(s, t), `${byWire[i].id} / ${byWire[j].id}`).toBe(false);
      }
    }
    expect(lines.length).toBeGreaterThan(6);
  });

  it('keeps hand-routed wires exactly as given and routes the others around them', () => {
    const fixed = [{ id: 'manual', points: [{ x: 388, y: 216 }, { x: 460, y: 216 }, { x: 460, y: 700 }, { x: 600, y: 700 }] }];
    const out = routeWires(requests.slice(0, 1), [BOARD], { fixed });
    expect(out.get('manual')).toEqual(fixed[0].points);
    expect(orthogonal(out.get('a'))).toBe(true);
  });

  it('is deterministic', () => {
    expect(routeWires(requests, [BOARD, ...parts])).toEqual(routes);
  });

  it('simplify drops repeated points and points in the middle of a straight run', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }]))
      .toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }]);
  });
});

describe('drawing a wire through clicked corners (Wokwi style)', () => {
  it('adds one square corner between points that are not in line, leaving the pin the way it points', () => {
    const pts = orthogonalThrough([{ x: 0, y: 0 }, { x: 100, y: 60 }], 'right');
    expect(pts).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }]);
    const down = orthogonalThrough([{ x: 0, y: 0 }, { x: 100, y: 60 }], 'down');
    expect(down).toEqual([{ x: 0, y: 0 }, { x: 0, y: 60 }, { x: 100, y: 60 }]);
  });

  it('passes through every clicked corner and stays square', () => {
    const clicks = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: -200 }, { x: 300, y: -150 }];
    const pts = orthogonalThrough(clicks, 'right');
    for (const c of clicks) expect(pts).toContainEqual(c);
    expect(orthogonal(pts)).toBe(true);
  });
});

describe('editing a route by hand', () => {
  const base = routeFromPoints([{ x: 12, y: 100 }, { x: -22, y: 100 }, { x: -22, y: 400 }, { x: 600, y: 400 }, { x: 600, y: 330 }]);

  it('reads a router path into an editable route', () => {
    expect(base.orients).toEqual(['h', 'v', 'h', 'v']);
    expect(routeFromPoints([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBeNull();      // diagonal: not a route
  });

  it('dragging a segment moves it across itself; the pins stay put and nothing turns diagonal', () => {
    const r = moveSegment(base, 2, 40);
    expect(r.points[2].y).toBe(440);
    expect(r.points[3].y).toBe(440);
    expect(r.points[0]).toEqual(base.points[0]);
    expect(r.points[4]).toEqual(base.points[4]);
    expect(orthogonal(r.points)).toBe(true);
  });

  it('the segments touching the pins cannot be dragged off them', () => {
    expect(moveSegment(base, 0, 30)).toBeNull();
    expect(moveSegment(base, 3, 30)).toBeNull();
  });

  it('dragging a bend moves both segments that meet there', () => {
    const r = moveBend(base, 2, -20, 30);
    expect(r.points[2]).toEqual({ x: -42, y: 430 });
    expect(orthogonal(r.points)).toBe(true);
  });

  it('an inserted bend can be pulled out into a step, and tidying keeps it', () => {
    const withBend = insertBend(base, 2, { x: 300, y: 400 });
    const stepped = cleanRoute(moveBend(withBend, 4, 0, -50));
    expect(stepped.points).toContainEqual({ x: 300, y: 350 });
    expect(orthogonal(stepped.points)).toBe(true);
  });

  it('tidying removes a bend that was never pulled out', () => {
    const untouched = cleanRoute(insertBend(base, 2, { x: 300, y: 400 }));
    expect(untouched.points).toEqual(base.points);
  });

  it('when a part moves, the ends follow their pins and the shape is kept', () => {
    const r = adaptRoute(base, { x: 12, y: 100 }, { x: 640, y: 300 });
    expect(r.points[0]).toEqual({ x: 12, y: 100 });
    expect(r.points[r.points.length - 1]).toEqual({ x: 640, y: 300 });
    expect(r.points.length).toBe(base.points.length);
    expect(orthogonal(r.points)).toBe(true);
  });

  it('notices when a part now sits on the route (the wire then goes back to automatic routing)', () => {
    expect(crossesAny(base, [{ left: 100, top: 380, right: 200, bottom: 420 }])).toBe(true);
    expect(crossesAny(base, [{ left: 100, top: 500, right: 200, bottom: 600 }])).toBe(false);
  });
});
