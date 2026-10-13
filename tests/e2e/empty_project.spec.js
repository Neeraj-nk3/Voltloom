import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { makeProject, shareUrl, gpio, cp, wire, LED, programOutput } from './helpers.js';

// "A resistor appears on an empty project." No code ever adds a part on its own; what the viewer saw was the previous
// session being restored from browser storage without any visible sign, and there was no way to start empty.
// These tests pin the behaviour down: a fresh start is empty, restoring says so, and New project really is empty
// (also after a reload, so nothing comes back).

const KEY = 'voltloom.project';
const parts = (page) => page.evaluate(() => window.__voltloom.bridge.canvasManager.components.map((c) => c.id));
const wires = (page) => page.evaluate(() => window.__voltloom.bridge.canvasManager.wires.length);
const ready = (page) => page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0).then(() => page.waitForTimeout(400));
const storeProject = (page, project, key = KEY) => page.addInitScript(([k, v]) => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('__seeded', '1'); } }, [key, JSON.stringify(project)]);

const WITH_RESISTOR = makeProject({
  code: 'print("old session")\n',
  components: [{ id: 'res_1', type: 'resistor', x: 50, y: 300, rotation: 0, value: 330, unit: 1 }, { ...LED, id: 'led_1' }],
  connections: [wire(gpio(20, 10, 10), cp('res_1', '1'))],
});

test.describe('an empty project stays empty', () => {
  test('a first visit opens the board with no parts, no wires, no notice, and the starter program', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    expect(await parts(page)).toEqual([]);
    expect(await wires(page)).toBe(0);
    await expect(page.locator('#canvas-notice')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('voltloom.project'))).toBeNull();     // nothing written either
    const code = await page.evaluate(() => window.monaco.editor.getModels()[0].getValue());
    expect(code).toContain('Pin("LED"');
    expect(code).not.toMatch(/GP0|PULL_UP/);                                                  // no button the board does not have
  });

  test('a stored empty project restores empty', async ({ page }) => {
    await storeProject(page, makeProject({ code: 'print(1)\n' }));
    await page.goto('/');
    await ready(page);
    expect(await parts(page)).toEqual([]);
  });

  test('a stored project with parts is restored, and the canvas says it was restored', async ({ page }) => {
    await storeProject(page, WITH_RESISTOR);
    await page.goto('/');
    await ready(page);
    expect((await parts(page)).sort()).toEqual(['led_1', 'res_1']);
    const notice = page.locator('#canvas-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Restored your last session');
    await expect(notice).toContainText('2 parts, 1 wire');
  });

  test('New project from the notice: confirm empties the canvas, and a reload stays empty', async ({ page }) => {
    await storeProject(page, WITH_RESISTOR);
    await page.goto('/');
    await ready(page);
    await page.click('#notice-new-btn');
    const dialog = page.locator('#new-project-modal');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('2 parts, 1 wire');
    await expect(page.locator('#new-project-cancel')).toBeFocused();                          // the safe choice is the default
    await page.click('#new-project-confirm');
    expect(await parts(page)).toEqual([]);
    expect(await wires(page)).toBe(0);
    await expect(page.locator('#canvas-notice')).toBeHidden();
    expect(JSON.parse(await page.evaluate((k) => localStorage.getItem(k), KEY)).components).toEqual([]);   // stored at once

    await page.reload();
    await ready(page);
    expect(await parts(page)).toEqual([]);
    await expect(page.locator('#canvas-notice')).toBeHidden();
  });

  test('Cancel and Escape change nothing', async ({ page }) => {
    await storeProject(page, WITH_RESISTOR);
    await page.goto('/');
    await ready(page);
    await page.click('#new-project-btn');
    await page.click('#new-project-cancel');
    await page.click('#new-project-btn');
    await page.keyboard.press('Escape');
    await expect(page.locator('#new-project-modal')).toBeHidden();
    expect((await parts(page)).sort()).toEqual(['led_1', 'res_1']);
  });

  test('a project kept under the old storage key does not come back after New project', async ({ page }) => {
    await storeProject(page, WITH_RESISTOR, 'circuitflow_project');
    await page.goto('/');
    await ready(page);
    expect((await parts(page)).length).toBe(2);
    await page.click('#new-project-btn');
    await page.click('#new-project-confirm');
    await page.reload();
    await ready(page);
    expect(await parts(page)).toEqual([]);
  });

  test('New project while a program runs stops it cleanly first', async ({ page }) => {
    await page.goto(shareUrl(makeProject({ code: 'import time\nwhile True:\n    print("tick")\n    time.sleep(0.2)\n', ...{ components: [{ ...LED, id: 'led_1' }] } })));
    await ready(page);
    await page.click('#run-btn');
    await expect.poll(async () => (await programOutput(page)).join('|')).toContain('tick');
    await page.click('#new-project-btn');
    await page.click('#new-project-confirm');
    await expect(page.locator('#run-status-text')).toHaveText('Ready');
    await expect(page.locator('#run-btn')).toBeEnabled();
    expect(await parts(page)).toEqual([]);
  });

  test('an example opened from a link keeps all its parts and says where it came from', async ({ page }) => {
    const example = JSON.parse(fs.readFileSync('examples/projects/python-button-led.project.json', 'utf8'));
    await page.goto(shareUrl(example));
    await ready(page);
    expect((await parts(page)).sort()).toEqual(example.components.map((c) => c.id).sort());
    expect(await wires(page)).toBe(example.connections.length);
    await expect(page.locator('#canvas-notice')).toContainText('Opened a shared project');
  });

  test('the notice goes away as soon as the viewer starts working', async ({ page }) => {
    await storeProject(page, WITH_RESISTOR);
    await page.goto('/');
    await ready(page);
    await expect(page.locator('#canvas-notice')).toBeVisible();
    await page.click('#add-component-btn');
    await expect(page.locator('#canvas-notice')).toBeHidden();
  });

  test('adding parts puts them beside the board and never on top of each other', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    for (const id of ['#add-led-btn', '#add-resistor-btn', '#add-pushbutton-btn', '#add-led-btn']) {
      await page.click('#add-component-btn');
      await page.click(id);
    }
    const layout = await page.evaluate(() => {
      const board = document.querySelector('#board-container > svg').getBoundingClientRect();
      const rects = [...document.querySelectorAll('#board-container > .part')].map((d) => d.getBoundingClientRect());
      const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return {
        onBoard: rects.filter((r) => hit(r, board)).length,
        overlapping: rects.flatMap((a, i) => rects.slice(i + 1).filter((b) => hit(a, b))).length,
        count: rects.length,
      };
    });
    expect(layout).toEqual({ onBoard: 0, overlapping: 0, count: 4 });
  });
});
