import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { makeProject, shareUrl, LED } from './helpers.js';

// The canvas in both themes: a plain surface (grid only on request), wires that stay visible on the board and on either
// canvas and that leave board pins sideways instead of covering the header, pin states while wiring, and pins that
// can be found and clicked at any zoom.

const example = JSON.parse(fs.readFileSync('examples/projects/python-button-led.project.json', 'utf8'));
const open = async (page, project = example) => {
  await page.goto(shareUrl(project));
  await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
  await page.waitForTimeout(400);
};
const centre = (page, selector) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, selector);

for (const scheme of ['light', 'dark']) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    test('the canvas is a plain surface; the grid is optional, remembered, and off by default', async ({ page }) => {
      await open(page);
      const look = () => page.evaluate(() => getComputedStyle(document.getElementById('simulation-area')).backgroundImage);
      expect(await look()).toBe('none');
      // one solid colour: the editor's in the dark theme, a calm mid-grey in the light theme
      const colour = await page.evaluate(() => getComputedStyle(document.getElementById('simulation-area')).backgroundColor);
      expect(colour).toBe(scheme === 'light' ? 'rgb(220, 218, 213)' : 'rgb(20, 22, 26)');
      await page.click('#grid-toggle-btn');
      await expect(page.locator('#grid-toggle-btn')).toHaveAttribute('aria-pressed', 'true');
      expect(await look()).toMatch(/radial-gradient/);
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
      expect(await look()).toMatch(/radial-gradient/);
      await page.click('#grid-toggle-btn');
      expect(await look()).toBe('none');
    });

    test('every wire is a thin plain line (Wokwi style) with an end dot at each pin, in the theme\'s colours', async ({ page }) => {
      await open(page);
      const wires = await page.evaluate(() => [...document.querySelectorAll('#wire-layer path.wire')].map((p) => ({
        filter: getComputedStyle(p).filter, width: p.getAttribute('stroke-width'), start: p.getAttribute('marker-start'), end: p.getAttribute('marker-end'),
      })));
      expect(wires.length).toBe(example.connections.length);
      for (const w of wires) {
        expect(w.filter).toBe('none');
        expect(w.width).toBe('4');
        expect(w.start).toBe('url(#wire-end)');
        expect(w.end).toBe('url(#wire-end)');
      }
      const joint = await page.evaluate(() => getComputedStyle(document.querySelector('#wire-end circle')).fill);
      expect(joint).toBe(scheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(241, 239, 236)');
    });

    test('part artwork keeps a visible outline on this canvas (white leads, light legs)', async ({ page }) => {
      await open(page);
      const filter = await page.evaluate(() => getComputedStyle(document.querySelector('.part > svg')).filter);
      expect(filter).toMatch(/drop-shadow/);
    });
  });
}

test.describe('wires and pins', () => {
  test('wires that touch a board pin leave sideways and never run over another pin of the header', async ({ page }) => {
    // The usual layout: parts beside the board. (A part placed ON the board can only be reached by crossing it.)
    const gp = (pin) => ({ nodeType: 'gpio', pin });
    const cp = (componentId, pin) => ({ nodeType: 'component_pin', componentId, pin });
    await open(page, makeProject({ code: '#', components: [
      { ...LED, id: 'led_1', x: 560, y: 120 }, { ...LED, id: 'led_2', x: 720, y: 120 }, { ...LED, id: 'led_3', x: 560, y: 560 },
    ], connections: [
      { start: gp(21), end: cp('led_1', 'A'), color: '#ef4444' }, { start: gp(23), end: cp('led_1', 'C'), color: '#111111' },
      { start: gp(22), end: cp('led_2', 'A'), color: '#f97316' }, { start: gp(28), end: cp('led_2', 'C'), color: '#111111' },
      { start: gp(20), end: cp('led_3', 'A'), color: '#3b82f6' }, { start: gp(18), end: cp('led_3', 'C'), color: '#111111' },
    ] }));
    const crossings = await page.evaluate(() => {
      const cm = window.__voltloom.bridge.canvasManager;
      const pads = Object.entries(cm.pinClusters).map(([pin, els]) => {
        const r = els[0].getBoundingClientRect();
        const a = cm.getLocalCoords(r.left, r.top), b = cm.getLocalCoords(r.right, r.bottom);
        return { pin: Number(pin), left: a.x, top: a.y, right: b.x, bottom: b.y };
      });
      const problems = [];
      for (const wire of cm.wires) {
        const ends = [wire.start, wire.end].filter((n) => n.nodeType === 'gpio').map((n) => n.pin);
        if (ends.length === 0) continue;
        const path = wire.pathElement;
        const total = path.getTotalLength();
        let prev = path.getPointAtLength(0);
        for (let len = 2; len <= total; len += 2) {
          const p = path.getPointAtLength(len);
          const vertical = Math.abs(p.y - prev.y) > Math.abs(p.x - prev.x);
          prev = p;
          if (!vertical) continue;
          const hit = pads.find((pad) => !ends.includes(pad.pin) && p.x > pad.left + 1 && p.x < pad.right - 1 && p.y > pad.top + 1 && p.y < pad.bottom - 1);
          if (hit) { problems.push(`wire ${wire.id} runs down over pin ${hit.pin}`); break; }
        }
      }
      return problems;
    });
    // Running vertically over the header is what covered every pin below a wire's start; a wire crossing the board
    // horizontally to reach a part on the other side is allowed (it passes at most the pad at its own height).
    expect(crossings).toEqual([]);
    const sideways = await page.evaluate(() => {
      const cm = window.__voltloom.bridge.canvasManager;
      return cm.wires.filter((w) => w.start.nodeType === 'gpio').map((w) => {
        const start = w.pathElement.getPointAtLength(0);
        const next = w.pathElement.getPointAtLength(6);
        return { pin: w.start.pin, horizontal: Math.abs(next.y - start.y) < 0.5, outward: w.start.pin <= 20 ? next.x < start.x : next.x > start.x };
      });
    });
    expect(sideways.length).toBeGreaterThan(0);
    for (const s of sideways) expect(s, `pin ${s.pin}`).toEqual({ pin: s.pin, horizontal: true, outward: true });
  });

  test('while wiring: the source pin is marked, a valid target turns green, an invalid one red, and Esc clears it', async ({ page }) => {
    await open(page, makeProject({ code: '#', components: [{ ...LED, id: 'led_1', x: 520, y: 300 }], connections: [] }));
    await page.dispatchEvent('#led_1 [data-pin="A"]', 'mousedown');
    await expect(page.locator('#led_1 [data-pin="A"]')).toHaveClass(/pin--source/);
    const valid = await centre(page, '#board-container [data-pin-label="GP16"]');
    await page.mouse.move(valid.x, valid.y);
    await expect(page.locator('#board-container [data-pin-label="GP16"]').first()).toHaveClass(/pin--valid/);
    await expect(page.locator('#tip')).toContainText('Click to connect');
    const invalid = await centre(page, '#board-container [data-pin-label="GND.8"]');
    await page.mouse.move(invalid.x, invalid.y);
    await expect(page.locator('#board-container [data-pin-label="GND.8"]').first()).toHaveClass(/pin--invalid/);
    await expect(page.locator('#tip')).toContainText('Cannot connect here');
    await expect(page.locator('#board-container [data-pin-label="GP16"]').first()).not.toHaveClass(/pin--valid/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#led_1 [data-pin="A"]')).not.toHaveClass(/pin--source/);
  });

  for (const scale of [0.4, 1, 2.2]) {
    test(`at ${Math.round(scale * 100)}% zoom a pin can be clicked and the wire ends exactly on it`, async ({ page }) => {
      await open(page, makeProject({ code: '#', components: [{ ...LED, id: 'led_1', x: 470, y: 120 }], connections: [] }));
      // zoom about the GP2 pad so it stays on screen
      await page.evaluate((s) => {
        const cm = window.__voltloom.bridge.canvasManager;
        const r = document.querySelector('#board-container [data-pin-label="GP2"]').getBoundingClientRect();
        const area = cm.simulationArea.getBoundingClientRect();
        const anchor = { x: r.left + r.width / 2 - area.left, y: r.top + r.height / 2 - area.top };
        const local = { x: (anchor.x - cm.view.x) / cm.view.scale, y: (anchor.y - cm.view.y) / cm.view.scale };
        cm.setView({ scale: s, x: area.width * 0.35 - local.x * s, y: area.height * 0.4 - local.y * s });
      }, scale);
      const pad = await centre(page, '#board-container [data-pin-label="GP2"]');
      await page.mouse.click(pad.x, pad.y);
      await page.dispatchEvent('#led_1 [data-pin="A"]', 'mousedown');
      await expect.poll(() => page.evaluate(() => window.__voltloom.bridge.canvasManager.wires.length)).toBe(1);
      const start = await page.evaluate(() => {
        const p = window.__voltloom.bridge.canvasManager.wires[0].pathElement;
        const m = p.getScreenCTM(); const q = p.getPointAtLength(0);
        return { x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f };
      });
      expect(Math.abs(start.x - pad.x)).toBeLessThan(1.5);
      expect(Math.abs(start.y - pad.y)).toBeLessThan(1.5);
    });
  }

  test('switching theme moves nothing: wires keep their exact paths and the view is unchanged', async ({ page }) => {
    await open(page);
    const snapshot = () => page.evaluate(() => ({
      paths: [...document.querySelectorAll('#wire-layer path.wire')].map((p) => p.getAttribute('d')),
      view: { ...window.__voltloom.bridge.canvasManager.view },
      board: document.querySelector('#board-container > svg').getBoundingClientRect().toJSON(),
    }));
    const before = await snapshot();
    for (const choice of ['light', 'dark', 'system']) {
      await page.click('#theme-btn');
      await page.click(`#theme-menu [data-theme-choice="${choice}"]`);
      expect(await snapshot()).toEqual(before);
    }
  });

  test('new wires default to a colour that reads on the board and on both canvases', async ({ page }) => {
    await open(page, makeProject({ code: '#', components: [{ ...LED, id: 'led_1', x: 470, y: 120 }], connections: [] }));
    await page.dispatchEvent('#board-container [data-pin-label="GP2"]', 'click');
    await page.dispatchEvent('#led_1 [data-pin="A"]', 'mousedown');
    expect(await page.evaluate(() => window.__voltloom.bridge.canvasManager.wires[0].color)).toBe('#3b82f6');
  });
});
