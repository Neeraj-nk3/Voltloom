import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { makeProject, openProject, shareUrl, gpio, cp, wire, LED, programOutput } from './helpers.js';
import { transformPortOffset } from '../../src/ui/canvas/geometry.js';

// The interface itself: layout at different window sizes and browser zoom levels, canvas zoom and pointer accuracy,
// floating cards, panels, dialogs, keyboard use, and what the page does when the editor cannot load.
// (Python/C execution, wiring rules, the debugger, autosave and sharing are covered by the other specs, which run
// against this same interface.)

const RES = { id: 'res_1', type: 'resistor', x: 50, y: 300, rotation: 0, value: 330, unit: 1 };
const WIRED = makeProject({
  code: 'print("hello")\n',
  components: [RES, { ...LED, id: 'led_1', x: 300, y: 300 }],
  connections: [wire(gpio(20), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))],
});

const open = (page, project = WIRED) => openProject(page, project);

/** Centre of an element on screen. */
const centreOf = (page, selector) => page.evaluate((sel) => {
  const r = document.querySelector(sel).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, selector);

const view = (page) => page.evaluate(() => ({ ...window.__voltloom.bridge.canvasManager.view }));

test.describe('layout holds at different window sizes and browser zoom levels', () => {
  // A browser zoom of N% shows the page in a viewport N% smaller (in CSS pixels) at N% more device pixels per CSS pixel.
  const cases = [
    { name: '1920x1080', width: 1920, height: 1080, dsf: 1 },
    { name: '1440x900', width: 1440, height: 900, dsf: 1 },
    { name: '1280x720', width: 1280, height: 720, dsf: 1 },
    { name: '1024x768', width: 1024, height: 768, dsf: 1 },
    { name: '1440x900 at 125% zoom', width: 1152, height: 720, dsf: 1.25 },
    { name: '1440x900 at 150% zoom', width: 960, height: 600, dsf: 1.5 },
    { name: '1440x900 at 200% zoom', width: 720, height: 450, dsf: 2 },
    { name: '1920x1080 at 80% zoom', width: 2400, height: 1350, dsf: 0.8 },
    { name: 'tablet portrait', width: 820, height: 1180, dsf: 2 },
  ];

  for (const c of cases) {
    test(`${c.name}: nothing is clipped, covered or scrolling the page`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: c.dsf });
      const page = await context.newPage();
      await open(page);

      const report = await page.evaluate(() => {
        const problems = [];
        const doc = document.documentElement;
        if (doc.scrollWidth > doc.clientWidth + 1) problems.push(`page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth})`);
        if (doc.scrollHeight > doc.clientHeight + 1) problems.push(`page scrolls vertically (${doc.scrollHeight} > ${doc.clientHeight})`);
        const controls = [...document.querySelectorAll('.titlebar button, .toolbar button, .tabs button, .console__head button, .statusbar')];
        let checked = 0;
        for (const el of controls) {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (style.visibility === 'hidden' || style.display === 'none' || rect.width === 0 || el.closest('.hidden')) continue;
          checked++;
          const name = el.id || el.className;
          if (rect.left < -0.5 || rect.top < -0.5 || rect.right > doc.clientWidth + 0.5 || rect.bottom > doc.clientHeight + 0.5) {
            problems.push(`${name} is outside the window (${Math.round(rect.left)},${Math.round(rect.top)} to ${Math.round(rect.right)},${Math.round(rect.bottom)})`);
            continue;
          }
          if (el.matches('button')) {
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            if (!hit || !(el === hit || el.contains(hit))) problems.push(`${name} is covered by ${hit && (hit.id || hit.className)}`);
            if (rect.width < 24 || rect.height < 24) problems.push(`${name} is smaller than 24px (${Math.round(rect.width)}x${Math.round(rect.height)})`);
            if (el.scrollWidth > el.clientWidth + 1) problems.push(`${name} clips its own content`);
          }
        }
        return { problems, checked };
      });
      expect(report.checked).toBeGreaterThan(8);
      expect(report.problems).toEqual([]);

      // The circuit is framed on first open: the whole board is inside the canvas
      const framed = await page.evaluate(() => {
        const wide = window.matchMedia('(max-width: 900px)').matches;
        const pane = document.getElementById('simulation-area').getBoundingClientRect();
        const board = document.querySelector('#board-container > svg').getBoundingClientRect();
        return { wide, inside: board.left >= pane.left - 1 && board.right <= pane.right + 1 && board.top >= pane.top - 1 && board.bottom <= pane.bottom + 1 };
      });
      expect(framed.inside).toBe(true);
      await context.close();
    });
  }
});

test.describe('canvas zoom and pointer accuracy', () => {
  test('the wheel zooms about the pointer: the pin under it stays under it', async ({ page }) => {
    await open(page);
    const pin = await centreOf(page, '#board-container [data-pin-label="GP15"]');
    await page.mouse.move(pin.x, pin.y);
    for (const delta of [-240, -240, 120, -120]) {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(60);
      const now = await centreOf(page, '#board-container [data-pin-label="GP15"]');
      expect(Math.abs(now.x - pin.x)).toBeLessThan(1.5);
      expect(Math.abs(now.y - pin.y)).toBeLessThan(1.5);
    }
    expect((await view(page)).scale).not.toBeCloseTo(1, 3);
  });

  test('zoom is multiplicative and bounded, and the readout follows', async ({ page }) => {
    await open(page);
    for (let i = 0; i < 40; i++) await page.click('#zoom-in-btn');
    expect((await view(page)).scale).toBe(5);
    await expect(page.locator('#zoom-level-lbl')).toHaveText('500%');
    for (let i = 0; i < 60; i++) await page.click('#zoom-out-btn');
    expect((await view(page)).scale).toBeCloseTo(0.1, 5);
    await page.click('#zoom-level-lbl');
    expect((await view(page)).scale).toBe(1);
    await expect(page.locator('#zoom-level-lbl')).toHaveText('100%');
  });

  test('a wire drawn with the mouse after zooming and panning starts exactly on the pin it was started from', async ({ page }) => {
    await open(page, makeProject({ code: '#', components: [RES], connections: [] }));
    await page.mouse.move(700, 400);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(100);
    // pan by dragging the background
    const area = await page.locator('#simulation-area').boundingBox();
    await page.mouse.move(area.x + 40, area.y + area.height - 60);
    await page.mouse.down();
    await page.mouse.move(area.x + 90, area.y + area.height - 90, { steps: 4 });
    await page.mouse.up();

    const pad = await centreOf(page, '#board-container [data-pin-label="GP15"]');
    await page.mouse.click(pad.x, pad.y);
    const term = await centreOf(page, '#res_1 [data-pin="1"]');
    await page.mouse.move(term.x, term.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => window.__voltloom.bridge.canvasManager.wires.length)).toBe(1);

    const ends = await page.evaluate(() => {
      const wirePath = window.__voltloom.bridge.canvasManager.wires[0].pathElement;
      const m = wirePath.getScreenCTM();
      const at = (len) => { const p = wirePath.getPointAtLength(len); return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }; };
      return { start: at(0) };
    });
    expect(Math.abs(ends.start.x - pad.x)).toBeLessThan(2);
    expect(Math.abs(ends.start.y - pad.y)).toBeLessThan(2);
  });

  for (const [rotation, flipped] of [[0, false], [90, false], [180, false], [270, true]]) {
    test(`a part rotated ${rotation}°${flipped ? ' and flipped' : ''}: its wire ends on the pin, not where the pin used to be`, async ({ page }) => {
      const led = { ...LED, id: 'led_1', x: 200, y: 250, rotation, flipped };
      await open(page, makeProject({ code: '#', components: [led], connections: [wire(gpio(20, 10, 10), cp('led_1', 'A'))] }));
      const actual = await page.evaluate(() => {
        const cm = window.__voltloom.bridge.canvasManager;
        const w = cm.wires[0].pathElement;
        const end = w.getPointAtLength(w.getTotalLength());
        return { end: { x: end.x, y: end.y }, scale: cm.view.scale };
      });
      const [px, py] = transformPortOffset([80, 155], [100, 200], rotation, flipped);
      expect(actual.end.x).toBeCloseTo(200 + px, 3);
      expect(actual.end.y).toBeCloseTo(250 + py, 3);

      // and that point is the visible end of the leg: the leg's own box on screen contains it
      const onScreen = await page.evaluate(({ x, y }) => {
        const cm = window.__voltloom.bridge.canvasManager;
        const area = cm.simulationArea.getBoundingClientRect();
        const leg = document.querySelector('#led_1 [data-pin="A"]').getBoundingClientRect();
        const sx = area.left + cm.view.x + cm.view.scale * x;
        const sy = area.top + cm.view.y + cm.view.scale * y;
        const tol = 6 * cm.view.scale + 3;
        return sx >= leg.left - tol && sx <= leg.right + tol && sy >= leg.top - tol && sy <= leg.bottom + tol;
      }, actual.end);
      expect(onScreen).toBe(true);
    });
  }

  test('wires in example projects (GPIO ends saved without coordinates) are drawn from the board pin', async ({ page }) => {
    const project = JSON.parse(fs.readFileSync('examples/projects/python-blink.project.json', 'utf8'));
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(shareUrl(project), { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
    await page.waitForTimeout(500);
    const paths = await page.evaluate(() => [...document.querySelectorAll('#wire-layer path')].map((p) => p.getAttribute('d')));
    expect(paths).toHaveLength(3);
    expect(paths.every((d) => !/undefined|NaN/.test(d))).toBe(true);
    expect(errors.filter((e) => /attribute d/.test(e))).toEqual([]);
    // GP15 (pin 20) wire starts on the pad
    const startsOnPad = await page.evaluate(() => {
      const cm = window.__voltloom.bridge.canvasManager;
      const w = cm.wires.find((x) => x.start.pin === 20).pathElement;
      const m = w.getScreenCTM();
      const p = w.getPointAtLength(0);
      const sx = m.a * p.x + m.c * p.y + m.e, sy = m.b * p.x + m.d * p.y + m.f;
      const pad = document.querySelector('#board-container [data-pin-label="GP15"]').getBoundingClientRect();
      return Math.abs(sx - (pad.left + pad.width / 2)) < 12 * cm.view.scale + 2 && Math.abs(sy - (pad.top + pad.height / 2)) < 12 * cm.view.scale + 2;
    });
    expect(startsOnPad).toBe(true);
  });

  test('the viewer\'s zoom and pan survive a reload; a first visit is framed automatically', async ({ page }) => {
    await open(page);
    const first = await view(page);
    expect(first.scale).toBeGreaterThan(0.2);                                // framed, not the old fixed 30%
    await page.mouse.move(800, 450);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(500);                                          // the saved copy is written after a short pause
    const chosen = await view(page);
    expect(chosen.scale).not.toBeCloseTo(first.scale, 2);
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
    await page.waitForTimeout(300);
    const after = await view(page);
    expect(after.scale).toBeCloseTo(chosen.scale, 5);
    expect(after.x).toBeCloseTo(chosen.x, 3);
    expect(after.y).toBeCloseTo(chosen.y, 3);
    // Fit is explicit
    await page.click('#zoom-fit-btn');
    expect((await view(page)).scale).toBeCloseTo(first.scale, 1);
  });

  test('a saved viewport that would leave nothing on screen is replaced by a framed one', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('voltloom.ui.viewport', JSON.stringify({ scale: 1, x: 99999, y: 99999 })));
    await open(page);
    const v = await view(page);
    expect(Math.abs(v.x)).toBeLessThan(2000);
  });
});

test.describe('floating cards and tooltips', () => {
  test('the properties card stays inside the canvas even when its part is dragged to the edge', async ({ page }) => {
    await open(page);
    for (const [x, y] of [[-200, -200], [3000, -200], [-200, 3000], [3000, 3000], [150, 140]]) {
      await page.evaluate(({ x, y }) => {
        const cm = window.__voltloom.bridge.canvasManager;
        const comp = cm.components.find((c) => c.id === 'led_1');
        comp.x = x; comp.y = y; comp.div.style.left = `${x}px`; comp.div.style.top = `${y}px`;
        cm.selectComponent('led_1');
      }, { x, y });
      const fits = await page.evaluate(() => {
        const area = document.getElementById('simulation-area').getBoundingClientRect();
        const card = document.getElementById('component-popup').getBoundingClientRect();
        return card.left >= area.left - 0.5 && card.top >= area.top - 0.5 && card.right <= area.right + 0.5 && card.bottom <= area.bottom + 0.5;
      });
      expect(fits, `part at ${x},${y}`).toBe(true);
    }
  });

  test('the card follows its part while the canvas is panned and zoomed', async ({ page }) => {
    await open(page);
    await page.dispatchEvent('#led_1', 'mousedown');
    await page.dispatchEvent('#led_1', 'mouseup');
    const before = await centreOf(page, '#component-popup');
    await page.click('#zoom-in-btn');
    await page.waitForTimeout(100);
    const after = await centreOf(page, '#component-popup');
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(1);       // it moved with the part
    const led = await centreOf(page, '#led_1');
    expect(Math.abs(after.x - led.x)).toBeLessThan(200);
  });

  test('part labels stay upright and readable on rotated parts and at any zoom', async ({ page }) => {
    await open(page, makeProject({ code: '#', components: [{ ...RES, rotation: 90 }], connections: [] }));
    await page.dispatchEvent('#res_1', 'mousedown');
    await page.dispatchEvent('#res_1', 'mouseup');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('#res_1 .part-label')).opacity)).toBe('1');
    const label = await page.evaluate(() => {
      const r = document.querySelector('#res_1 .part-label').getBoundingClientRect();
      return { height: r.height };
    });
    expect(label.height).toBeGreaterThan(14);          // about 13px text plus padding on screen, whatever the zoom
    const upright = await page.evaluate(() => {
      const el = document.querySelector('#res_1 .part-label');
      const r = el.getBoundingClientRect();
      return r.width > r.height;                        // text runs left to right
    });
    expect(upright).toBe(true);
  });

  test('Backspace and Delete in the resistor value field edit the number, not the circuit', async ({ page }) => {
    await open(page);
    await page.dispatchEvent('#res_1', 'mousedown');
    await page.dispatchEvent('#res_1', 'mouseup');
    await page.click('#popup-value');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('470');
    await page.keyboard.press('Delete');
    expect(await page.evaluate(() => window.__voltloom.bridge.canvasManager.components.length)).toBe(2);
    await expect(page.locator('#popup-value')).toHaveValue('470');
  });

  test('Delete removes the selected part after a click on it, even if the editor had focus', async ({ page }) => {
    await open(page);
    await page.click('.monaco-editor');                               // focus in the editor
    await page.mouse.click(...(await (async () => { const c = await centreOf(page, '#led_1 svg'); return [c.x, c.y - 10]; })()));
    await page.keyboard.press('Delete');
    await expect.poll(() => page.evaluate(() => window.__voltloom.bridge.canvasManager.components.map((c) => c.id))).toEqual(['res_1']);
  });

  test('the pin tooltip names the pin and stays inside the window', async ({ page }) => {
    await open(page);
    const pad = await centreOf(page, '#board-container [data-pin-label="GP15"]');
    await page.mouse.move(pad.x, pad.y);
    const tip = page.locator('#tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('GP15');
    await expect(tip).toContainText('Pin 20');
    const box = await tip.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
  });

  test('toolbar buttons show a tooltip on keyboard focus, and a disabled one says why', async ({ page }) => {
    await open(page);
    await page.focus('#add-component-btn');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(page.locator('#tip')).toContainText('Add a part');
    await page.mouse.move(600, 23);
    await page.hover('#step-btn');
    await expect(page.locator('#tip')).toContainText('Available while the program is paused', { timeout: 3000 });
  });
});

test.describe('panels', () => {
  test('the console is there before any run, and says what it is for', async ({ page }) => {
    await open(page);
    await expect(page.locator('#console-panel')).toBeVisible();
    await expect(page.locator('#console-toggle-btn')).toHaveAttribute('aria-expanded', 'false');
    await page.click('#console-toggle-btn');
    await expect(page.locator('#console-panel .empty')).toContainText('No output yet');
    await expect(page.locator('#console-toggle-btn')).toHaveAttribute('aria-expanded', 'true');
  });

  test('output replaces the empty state, the header counts lines, and Clear brings the empty state back', async ({ page }) => {
    await open(page, makeProject({ code: 'print("one")\nprint("two")\nimport time\ntime.sleep(3)\n' }));
    await page.click('#run-btn');
    await expect.poll(async () => (await programOutput(page)).join('|')).toContain('two');
    await expect(page.locator('#console-panel .empty')).toBeHidden();
    await expect(page.locator('#console-count')).toHaveText(/\d+ lines?/);
    await page.click('#clear-console');
    await expect(page.locator('#console-panel .empty')).toBeVisible();
    await expect(page.locator('#console-count')).toHaveText('');
    await page.click('#stop-btn');
  });

  test('an error opens the console by itself, and a viewer who closed it is not interrupted again', async ({ page }) => {
    await open(page, makeProject({ code: 'import time\ntime.sleep(2)\n' }));
    // an invalid connection is refused with a message
    await page.dispatchEvent('#board-container [data-pin-label="GND.1"]', 'click');
    await page.evaluate(() => window.__voltloom.bridge.canvasManager.wireManager.cancelWire());
    await page.evaluate(() => { const m = document.getElementById('output'); const d = document.createElement('div'); d.className = 'line line--error'; d.innerHTML = '<span class="line__tag">[Error]</span><span class="line__text">boom</span>'; m.appendChild(d); });
    await expect(page.locator('#console-toggle-btn')).toHaveAttribute('aria-expanded', 'true');
    await page.click('#console-toggle-btn');
    await expect(page.locator('#console-toggle-btn')).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() => { const m = document.getElementById('output'); const d = document.createElement('div'); d.className = 'line line--error'; d.textContent = 'again'; m.appendChild(d); });
    await page.waitForTimeout(200);
    await expect(page.locator('#console-toggle-btn')).toHaveAttribute('aria-expanded', 'false');
  });

  test('the transport status follows the run: Ready, Running, Paused at a line, Stopped', async ({ page }) => {
    await open(page, makeProject({ code: 'import time\nwhile True:\n    time.sleep(0.1)\n' }));
    const status = page.locator('#run-status-text');
    await expect(status).toHaveText('Ready');
    await expect(page.locator('#stop-btn')).toBeDisabled();
    await expect(page.locator('#pause-btn')).toBeDisabled();
    await page.click('#run-btn');
    await expect(status).toHaveText('Running · Python');
    await expect(page.locator('#run-btn')).toBeDisabled();
    await expect(page.locator('#stop-btn')).toBeEnabled();
    await page.click('#pause-btn');
    await expect(status).toHaveText(/^Paused/, { timeout: 5000 });
    await expect(page.locator('#resume-btn')).toBeVisible();
    await expect(page.locator('#pause-btn')).toBeHidden();
    await expect(page.locator('#step-btn')).toBeEnabled();
    await page.click('#stop-btn');
    await expect(status).toHaveText('Stopped');
    await expect(page.locator('#step-btn')).toBeDisabled();
  });

  test('the inspector docks beside the canvas instead of covering it, and the toggle shows its state', async ({ page }) => {
    await open(page, makeProject({ code: 'import time\ntime.sleep(5)\n' }));
    await expect(page.locator('#inspector-toggle-btn')).toBeDisabled();
    await page.click('#run-btn');
    await page.click('#inspector-toggle-btn');
    await expect(page.locator('#inspector-toggle-btn')).toHaveAttribute('aria-pressed', 'true');
    const overlap = await page.evaluate(() => {
      const a = document.getElementById('simulation-area').getBoundingClientRect();
      const i = document.getElementById('state-inspector-panel').getBoundingClientRect();
      return a.right > i.left + 1;
    });
    expect(overlap).toBe(false);
    await page.click('#inspector-close-btn');
    await expect(page.locator('#inspector-toggle-btn')).toHaveAttribute('aria-pressed', 'false');
    await page.click('#stop-btn');
  });

  test('the splitter resizes the code pane with the pointer and the keyboard, and the size is remembered', async ({ page }) => {
    await open(page);
    const width = () => page.evaluate(() => document.getElementById('pane-code').getBoundingClientRect().width);
    const start = await width();
    const handle = await page.locator('#splitter-code').boundingBox();
    await page.mouse.move(handle.x + 1, handle.y + 200);
    await page.mouse.down();
    await page.mouse.move(handle.x + 121, handle.y + 200, { steps: 5 });
    await page.mouse.up();
    const dragged = await width();
    expect(dragged).toBeGreaterThan(start + 100);
    await page.focus('#splitter-code');
    await page.keyboard.press('ArrowLeft');
    expect(await width()).toBeLessThan(dragged - 10);
    await page.keyboard.press('Home');
    expect(await width()).toBe(300);
    await page.keyboard.press('End');
    const widest = await width();
    expect(widest).toBeLessThanOrEqual(1280 - 360 + 1);
    await page.keyboard.press('Home');
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
    expect(await width()).toBe(300);
  });

  test('the console can be resized and is kept clear of the canvas minimum', async ({ page }) => {
    await open(page);
    await page.click('#console-toggle-btn');
    const height = () => page.evaluate(() => document.getElementById('console-panel').getBoundingClientRect().height);
    const start = await height();
    await page.focus('#splitter-console');
    await page.keyboard.press('ArrowUp');
    expect(await height()).toBeGreaterThan(start + 10);
    // Window-splitter keys follow the first pane (the canvas): Home = smallest canvas = tallest console, End = the reverse
    await page.keyboard.press('Home');
    const tallest = await height();
    expect(tallest).toBeGreaterThan(start);
    const canvasHeight = await page.evaluate(() => document.getElementById('simulation-area').getBoundingClientRect().height);
    expect(canvasHeight).toBeGreaterThanOrEqual(150);
    await page.keyboard.press('End');
    expect(await height()).toBeLessThan(start);
  });
});

test.describe('dialogs, menus and keyboard', () => {
  test('Share opens a real dialog, Esc closes it and focus returns to the button; the link can be copied', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await open(page);
    await page.focus('#share-project-btn');
    await page.keyboard.press('Enter');
    const dialog = page.locator('#share-modal');
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('share-modal').matches(':modal'))).toBe(true);
    await expect(page.locator('#share-modal-input')).toHaveValue(/\?p=/);
    await page.click('#share-modal-copy-btn');
    await expect(page.locator('#share-modal-copy-text')).toHaveText('Copied');
    const link = await page.evaluate(() => document.getElementById('share-modal-input').value);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#share-project-btn')).toBeFocused();
  });

  test('the Add part menu works from the keyboard and returns focus', async ({ page }) => {
    await open(page, makeProject({ code: '#' }));
    await page.focus('#add-component-btn');
    await page.keyboard.press('Enter');
    await expect(page.locator('#component-dropdown')).toBeVisible();
    await expect(page.locator('#add-component-btn')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#add-resistor-btn')).toBeFocused();       // opening from the keyboard moves into the menu
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#add-led-btn')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__voltloom.bridge.canvasManager.components.map((c) => c.id.split('_')[0]))).toEqual(['led']);
    await expect(page.locator('#component-dropdown')).toBeHidden();
    await expect(page.locator('#add-component-btn')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(page.locator('#component-dropdown')).toBeHidden();
  });

  test('shortcuts: R rotates the selected part, F frames the circuit, 0 resets zoom, Ctrl+Enter runs', async ({ page }) => {
    await open(page);
    await page.dispatchEvent('#res_1', 'mousedown');
    await page.dispatchEvent('#res_1', 'mouseup');
    await page.keyboard.press('r');
    expect(await page.evaluate(() => window.__voltloom.bridge.canvasManager.components.find((c) => c.id === 'res_1').rotation)).toBe(90);
    await page.keyboard.press('0');
    expect((await view(page)).scale).toBe(1);
    await page.keyboard.press('f');
    expect((await view(page)).scale).toBeLessThan(1);
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('#run-status-text')).toHaveText('Running · Python');
    await page.click('#stop-btn');
  });

  test('the circuit warning pill opens its list, and Esc closes it', async ({ page }) => {
    const led = { ...LED, id: 'led_1', x: 300, y: 300 };
    await open(page, makeProject({ code: '#', components: [led], connections: [wire(gpio(36), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))] }));
    await page.click('#circuit-status');
    await expect(page.locator('.popover')).toContainText('would be destroyed');
    await page.keyboard.press('Escape');
    await expect(page.locator('.popover')).toHaveCount(0);
  });

  test('a refused connection is explained on the canvas, not only in the console', async ({ page }) => {
    await open(page, makeProject({ code: '#', components: [{ ...LED, id: 'led_1', x: 300, y: 300 }], connections: [] }));
    await page.dispatchEvent('#led_1 [data-pin="A"]', 'mousedown');
    await page.dispatchEvent('#board-container [data-pin-label="GND.1"]', 'click');
    await expect(page.locator('#canvas-hint')).toContainText('cannot be connected');
    await expect(page.locator('#canvas-hint')).toHaveAttribute('data-tone', 'error');
  });

  test('the hint line guides a first-time user and follows what is selected', async ({ page }) => {
    await open(page, makeProject({ code: '#' }));
    await expect(page.locator('#canvas-hint')).toContainText('Add a part');
    await page.click('#add-component-btn');
    await page.click('#add-resistor-btn');
    await expect(page.locator('#canvas-hint')).toContainText('Resistor 1 selected');
    await page.keyboard.press('Escape');
    await expect(page.locator('#canvas-hint')).toContainText('Click a pin to start a wire');
  });
});

test.describe('the editor and its tabs', () => {
  test('running and downloading on the diagram tab use the program, not the generated JSON', async ({ page }) => {
    await open(page, makeProject({ code: 'print("from the program")\n' }));
    await page.click('#tab-diagram');
    await expect(page.locator('#status-note')).toContainText('Read-only');
    await page.click('#run-btn');
    await expect.poll(async () => (await programOutput(page)).join('|')).toContain('from the program');
    await page.click('#stop-btn');
    const download = page.waitForEvent('download');
    await page.click('#save-code-btn');
    const file = await download;
    expect(fs.readFileSync(await file.path(), 'utf8')).toBe('print("from the program")\n');
    // and the saved project keeps the code
    const link = await page.evaluate(() => window.__voltloom.shareProject());
    const project = JSON.parse(decodeURIComponent(Buffer.from(decodeURIComponent(link.split('?p=')[1]), 'base64').toString()));
    expect(project.code).toBe('print("from the program")\n');
  });

  test('switching tabs is not an edit, and the cursor of the code tab is kept', async ({ page }) => {
    await open(page, makeProject({ code: 'line1\nline2\nline3\n' }));
    await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved', { timeout: 8000 });
    await page.evaluate(() => { const e = window.monaco.editor.getEditors()[0]; e.setPosition({ lineNumber: 3, column: 3 }); });
    await page.click('#tab-diagram');
    await page.click('#tab-main');
    await page.waitForTimeout(1500);
    await expect(page.locator('#save-status')).toHaveAttribute('data-state', 'saved');
    expect(await page.evaluate(() => { const p = window.monaco.editor.getEditors()[0].getPosition(); return [p.lineNumber, p.column]; })).toEqual([3, 3]);
    await expect(page.locator('#status-pos')).toHaveText('Ln 3, Col 3');
  });

  test('the highlighting and file name follow the language of the code', async ({ page }) => {
    await open(page, makeProject({ code: 'print(1)\n' }));
    await expect(page.locator('#tab-main-name')).toHaveText('main.py');
    await expect(page.locator('#status-lang')).toHaveText('Python');
    await page.evaluate(() => window.monaco.editor.getModels()[0].setValue('#include "pico/stdlib.h"\nint main() { return 0; }\n'));
    await expect(page.locator('#status-lang')).toHaveText('C', { timeout: 3000 });
    await expect(page.locator('#tab-main-name')).toHaveText('main.c');
    expect(await page.evaluate(() => window.monaco.editor.getModels()[0].getLanguageId())).toBe('c');
  });

  test('a C project opened before the editor is ready is still highlighted as C', async ({ page }) => {
    await page.route('**/monaco-editor/**', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
    await openProject(page, makeProject({ code: '#include "pico/stdlib.h"\nint main() { return 0; }\n', language: 'c' }));
    await page.waitForFunction(() => window.monaco && window.monaco.editor.getModels().length > 0, null, { timeout: 20000 });
    expect(await page.evaluate(() => window.monaco.editor.getModels()[0].getLanguageId())).toBe('c');
  });

  test('when the editor cannot be loaded the page says so, the circuit still works, and Run still runs the program', async ({ page }) => {
    await page.route('https://cdnjs.cloudflare.com/**', (route) => route.abort());
    await page.goto(shareUrl(makeProject({ code: 'print("no editor needed")\n' })), { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
    await expect(page.locator('#editor-state')).toContainText('could not be loaded');
    await expect(page.locator('#canvas-state')).toBeHidden();
    await page.click('#run-btn');
    await expect.poll(async () => (await programOutput(page)).join('|')).toContain('no editor needed');
    await page.click('#stop-btn');
  });

  test('the board drawing failing to load is explained', async ({ page }) => {
    // the drawing file only (the dev server also serves it as a JS module under ?import, which must keep working)
    await page.route(/pico-board.*\.svg/, (route) => (route.request().url().includes('import') ? route.continue() : route.fulfill({ status: 500, body: 'nope' })));
    await page.goto('/', { waitUntil: 'load' });
    await expect(page.locator('#canvas-state')).toContainText('board drawing could not be loaded');
  });
});

test.describe('narrow windows: one pane at a time', () => {
  test.use({ viewport: { width: 760, height: 900 } });

  test('the Code / Circuit switch is there, labelled, and switching keeps the editor and the circuit as they were', async ({ page }) => {
    await open(page);
    const switchGroup = page.locator('.pane-switch');
    await expect(switchGroup).toBeVisible();
    await expect(page.locator('#pane-code-btn')).toHaveText('Code');
    await expect(page.locator('#pane-circuit-btn')).toHaveText('Circuit');
    await expect(page.locator('#pane-code-btn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#editor-container')).toBeVisible();
    await expect(page.locator('#simulation-area')).toBeHidden();

    // type in the editor, move the cursor
    await page.evaluate(() => { const e = window.monaco.editor.getEditors()[0]; e.executeEdits('t', [{ range: e.getModel().getFullModelRange(), text: 'a = 1\nb = 2\n' }]); e.setPosition({ lineNumber: 2, column: 4 }); });

    await page.click('#pane-circuit-btn');
    await expect(page.locator('#simulation-area')).toBeVisible();
    await expect(page.locator('#editor-container')).toBeHidden();
    await expect(page.locator('#pane-circuit-btn')).toHaveAttribute('aria-pressed', 'true');
    // the circuit is framed in the full-width canvas and a part can be selected
    const framed = await page.evaluate(() => {
      const pane = document.getElementById('simulation-area').getBoundingClientRect();
      const board = document.querySelector('#board-container > svg').getBoundingClientRect();
      return pane.width > 600 && board.left >= pane.left - 1 && board.right <= pane.right + 1;
    });
    expect(framed).toBe(true);
    await page.dispatchEvent('#led_1', 'mousedown');
    await page.dispatchEvent('#led_1', 'mouseup');
    await expect(page.locator('#component-popup')).toBeVisible();

    await page.click('#pane-code-btn');
    await expect(page.locator('#editor-container')).toBeVisible();
    expect(await page.evaluate(() => window.monaco.editor.getEditors()[0].getValue())).toBe('a = 1\nb = 2\n');
    await expect(page.locator('#status-pos')).toHaveText('Ln 2, Col 4');
    await page.click('#pane-circuit-btn');
    expect(await page.evaluate(() => window.__voltloom.bridge.canvasManager.selectedComponentId)).toBe('led_1');
  });

  test('the running state is visible from either pane', async ({ page }) => {
    await open(page, makeProject({ code: 'import time\ntime.sleep(5)\n' }));
    await page.click('#run-btn');
    await expect(page.locator('#run-status-text')).toHaveText('Running · Python');
    await page.click('#pane-circuit-btn');
    await expect(page.locator('#run-status-text')).toBeVisible();
    await expect(page.locator('#stop-btn')).toBeVisible();
    await page.click('#stop-btn');
  });

  test('the first visit frames the circuit even though the canvas pane started hidden', async ({ page }) => {
    await open(page);
    const v = await view(page);
    await page.click('#pane-circuit-btn');
    expect((await view(page)).scale).toBeCloseTo(v.scale, 5);
    const inside = await page.evaluate(() => {
      const pane = document.getElementById('simulation-area').getBoundingClientRect();
      const board = document.querySelector('#board-container > svg').getBoundingClientRect();
      return board.top >= pane.top - 1 && board.bottom <= pane.bottom + 1;
    });
    expect(inside).toBe(true);
  });
});
