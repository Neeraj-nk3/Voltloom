import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { makeProject, openProject, shareUrl, programOutput, gpio, cp, wire, LED } from './helpers.js';

// R5 — autosave tells the truth, projects survive a reload, and old (version 1) projects and links still open.

const KEY = 'voltloom.project';
const status = (page) => page.evaluate(() => { const el = document.getElementById('save-status'); return { text: el.textContent, state: el.dataset.state, storage: el.dataset.storage, title: el.title, hidden: el.classList.contains('hidden') }; });
const consoleText = async (page) => (await programOutput(page)).join('\n');
const stored = (page) => page.evaluate((k) => localStorage.getItem(k), KEY);
const led = { ...LED, id: 'led_1' };
const res = { id: 'res_1', type: 'resistor', x: 50, y: 300, rotation: 0, value: 330, unit: 1 };
const WIRED = { components: [led, res], connections: [wire(gpio(20), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))] };

async function bare(page, init) {
  if (init) await page.addInitScript(init);
  await page.goto('/', { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
  await page.waitForTimeout(300);
}

test.describe('autosave status', () => {
  test('a change shows "Unsaved changes", then "Saved" with the time and where, and the stored copy is a version-2 project', async ({ page }) => {
    await bare(page);
    expect((await status(page)).hidden).toBe(true);                       // nothing changed yet: nothing claimed
    await page.evaluate(() => window.__voltloom.bridge.canvasManager.addLED());
    expect((await status(page))).toMatchObject({ text: 'Unsaved changes', state: 'unsaved' });
    expect(await stored(page)).toBeNull();                                // and indeed nothing is stored yet
    await expect.poll(async () => (await status(page)).state, { timeout: 5000 }).toBe('saved');
    const s = await status(page);
    expect(s.text).toMatch(/^Saved \d{1,2}:\d\d/);
    expect(s.storage).toBe('local');
    expect(s.title).toBe('Saved in this browser');
    const project = JSON.parse(await stored(page));
    expect(project.version).toBe(2);
    expect(project.components).toHaveLength(1);
    expect(project.meta.app).toBe('voltloom');
    expect(Number.isNaN(Date.parse(project.meta.savedAt))).toBe(false);
  });

  test('editing the code is also an unsaved change', async ({ page }) => {
    await bare(page);
    const changed = await page.evaluate(() => { const m = window.monaco; if (!m) return false; m.editor.getModels()[0].setValue('print("hello")'); return true; });
    expect(changed).toBe(true);
    expect((await status(page)).state).toBe('unsaved');
    await expect.poll(async () => (await status(page)).state, { timeout: 5000 }).toBe('saved');
    expect(JSON.parse(await stored(page)).code).toBe('print("hello")');
  });

  test('closing the tab inside the 1 s delay still saves (pagehide flushes)', async ({ page }) => {
    await bare(page);
    await page.evaluate(() => window.__voltloom.bridge.canvasManager.addResistor());
    expect(await stored(page)).toBeNull();
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    expect((await status(page)).state).toBe('saved');
    expect(JSON.parse(await stored(page)).components).toHaveLength(1);
  });

  test('reload restores the circuit, wires keep their ids, the page says it restored a saved session, and the status is "saved"', async ({ page }) => {
    await openProject(page, makeProject({ code: 'print(1)', ...WIRED }));
    await page.evaluate(() => window.__voltloom.bridge.canvasManager.addPart('button'));     // a change, so it is stored
    await expect.poll(async () => (await status(page)).state, { timeout: 5000 }).toBe('saved');
    const before = await page.evaluate(() => { const cm = window.__voltloom.bridge.canvasManager; return { wires: cm.wires.map((w) => w.id), components: cm.components.map((c) => c.id) }; });
    expect(before.components).toHaveLength(3);

    await page.goto('/', { waitUntil: 'load' });                                              // no ?p=: only autosave can bring it back
    await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => { const cm = window.__voltloom.bridge.canvasManager; return { wires: cm.wires.map((w) => w.id), components: cm.components.map((c) => c.id) }; });
    expect(after).toEqual(before);                                                            // same parts, same wires, same ids
    expect(await consoleText(page)).toMatch(/Restored your last session \(saved in this browser\)\./);
    expect(await status(page)).toMatchObject({ state: 'saved', storage: 'local' });           // adopting the stored copy is not a new change
    await page.waitForTimeout(1500);
    expect((await status(page)).state).toBe('saved');                                         // and nothing was re-written or flagged unsaved
  });
});

test.describe('autosave failures are visible, never hidden', () => {
  test('storage that refuses writes (full): the header says "Not saved" and why, and clears when it works again', async ({ page }) => {
    await bare(page, () => {
      const real = Storage.prototype.setItem;
      window.__quota = true;
      Storage.prototype.setItem = function (k, v) {
        if (window.__quota && k === 'voltloom.project') throw new DOMException('full', 'QuotaExceededError');
        return real.call(this, k, v);
      };
    });
    await page.evaluate(() => window.__voltloom.bridge.canvasManager.addLED());
    await expect.poll(async () => (await status(page)).state, { timeout: 5000 }).toBe('failed');
    const s = await status(page);
    expect(s.text).toBe('Not saved');
    expect(s.title).toBe('Not saved: browser storage is full. Use Share to keep your work.');
    expect(await stored(page)).toBeNull();
    await page.evaluate(() => { window.__quota = false; window.__voltloom.bridge.canvasManager.addResistor(); });
    await expect.poll(async () => (await status(page)).state, { timeout: 5000 }).toBe('saved');
  });

  test('storage that silently drops writes is not reported as saved', async ({ page }) => {
    await bare(page, () => {
      const real = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) { if (k === 'voltloom.project') return; return real.call(this, k, v); };
    });
    await page.evaluate(() => window.__voltloom.bridge.canvasManager.addLED());
    await expect.poll(async () => (await status(page)).state, { timeout: 5000 }).toBe('failed');
  });

  test('no browser storage at all: "Autosave off" from the start, with the reason; Share still works', async ({ page }) => {
    await bare(page, () => {
      for (const name of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(window, name, { get() { throw new DOMException('blocked', 'SecurityError'); } });
      }
    });
    const s = await status(page);
    expect(s).toMatchObject({ text: 'Autosave off', state: 'unavailable', hidden: false });
    expect(s.title).toMatch(/Use Share to keep your work/);
    await page.evaluate(() => window.__voltloom.bridge.canvasManager.addLED());
    await page.waitForTimeout(1500);
    expect((await status(page)).state).toBe('unavailable');
    const link = await page.evaluate(() => window.__voltloom.shareProject());
    expect(link).toMatch(/\?p=/);
  });

  test('only sessionStorage works: saved, and honest that it is for this tab only', async ({ page }) => {
    await bare(page, () => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    await page.evaluate(() => window.__voltloom.bridge.canvasManager.addLED());
    await expect.poll(async () => (await status(page)).state, { timeout: 5000 }).toBe('saved');
    const s = await status(page);
    expect(s.storage).toBe('session');
    expect(s.title).toBe('Saved in this tab only (cleared when the tab is closed)');
  });
});

test.describe('older and newer projects', () => {
  const v1 = JSON.parse(fs.readFileSync('tests/fixtures/project_v1_full.json', 'utf8'));
  const v1Link = fs.readFileSync('tests/fixtures/project_v1_full.link.txt', 'utf8');

  test('a version-1 share link made before this change still opens, with its wires, and says it was upgraded', async ({ page }) => {
    await page.goto('/?p=' + encodeURIComponent(v1Link), { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
    await page.waitForTimeout(400);
    const result = await page.evaluate(() => { const cm = window.__voltloom.bridge.canvasManager; return { components: cm.components.length, wires: cm.wires.map((w) => w.id) }; });
    expect(result.components).toBe(3);
    expect(result.wires).toHaveLength(5);
    expect(new Set(result.wires).size).toBe(5);
    expect(await consoleText(page)).toMatch(/Project: project upgraded from version 1 to 2\./);
    await expect.poll(async () => (await status(page)).state, { timeout: 5000 }).toBe('saved');     // a link is stored by autosave
    expect(JSON.parse(await stored(page)).version).toBe(2);
  });

  test('a version-1 project stored under the previous storage key (circuitflow_project) is still found, upgraded on load, and left in place', async ({ page }) => {
    await bare(page, `window.localStorage.setItem('circuitflow_project', ${JSON.stringify(JSON.stringify(v1))});`);
    const result = await page.evaluate(() => window.__voltloom.bridge.canvasManager.components.length);
    expect(result).toBe(3);
    expect(await consoleText(page)).toMatch(/Project: project upgraded from version 1 to 2\./);
  });

  test('a project from a newer version of the app is refused with a clear message and nothing is half-loaded', async ({ page }) => {
    const future = { ...v1, version: 7 };
    await page.goto(shareUrl(future), { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
    await page.waitForTimeout(400);
    expect(await consoleText(page)).toMatch(/Project link rejected: this project was saved by a newer version of Voltloom \(project version 7/);
    expect(await page.evaluate(() => window.__voltloom.bridge.canvasManager.components.length)).toBe(0);
  });

  test('a link containing duplicate wires opens with the duplicates removed and says so', async ({ page }) => {
    const dup = { ...v1, version: 1, connections: [...v1.connections, v1.connections[0]] };
    await page.goto(shareUrl(dup), { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__voltloom.bridge.canvasManager.wires.length)).toBe(5);
    expect(await consoleText(page)).toMatch(/1 duplicate connection removed/);
  });
});
