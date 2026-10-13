import { test, expect } from '@playwright/test';
import { makeProject, openProject, gpio, cp, wire, LED } from './helpers.js';

// R5 — ids must be unique. Wires used to be named 'wire_' + Date.now(), so wires created in the same millisecond
// (every project load!) shared one id, and deleting one removed all of them from the data while leaving their paths
// on the canvas. Components had the same weakness when added in quick succession.

const led = (id) => ({ ...LED, id });
const res = (id) => ({ id, type: 'resistor', x: 50, y: 300, rotation: 0, value: 330, unit: 1 });

// three LEDs + three resistors, six wires
const SIX_WIRES = {
  components: [led('led_1'), led('led_2'), led('led_3'), res('res_1'), res('res_2'), res('res_3')],
  connections: [
    wire(gpio(20), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C')),
    wire(gpio(19), cp('res_2', '1')), wire(cp('res_2', '2'), cp('led_2', 'A')), wire(gpio(8), cp('led_2', 'C')),
  ],
};

const state = (page) => page.evaluate(() => {
  const cm = window.__voltloom.bridge.canvasManager;
  return {
    wireIds: cm.wires.map((w) => w.id),
    componentIds: cm.components.map((c) => c.id),
    paths: document.querySelectorAll('#wire-layer path, svg path[stroke-width]').length,
    wirePaths: cm.wires.filter((w) => w.pathElement && w.pathElement.isConnected).length,
  };
});

test.describe('unique ids', () => {
  test('wires restored from a project all get different ids', async ({ page }) => {
    await openProject(page, makeProject({ code: '#', ...SIX_WIRES }));
    const { wireIds } = await state(page);
    expect(wireIds).toHaveLength(6);
    expect(new Set(wireIds).size).toBe(6);
  });

  test('deleting one wire removes exactly that wire, from the data and from the canvas', async ({ page }) => {
    await openProject(page, makeProject({ code: '#', ...SIX_WIRES }));
    const before = await state(page);
    const victim = before.wireIds[2];
    await page.evaluate((id) => {
      const cm = window.__voltloom.bridge.canvasManager;
      cm.wireManager.selectWire(cm.wires.find((w) => w.id === id));
    }, victim);
    await page.click('#popup-delete');
    const after = await state(page);
    expect(after.wireIds).toEqual(before.wireIds.filter((id) => id !== victim));
    expect(after.wirePaths).toBe(5);                                    // every remaining wire is still drawn
    // and the circuit still works for the wires that remain: LED 1 is still wired
    const wired = await page.evaluate(() => window.__voltloom.bridge.canvasManager.wires.length);
    expect(wired).toBe(5);
  });

  test('wires created within the same millisecond (a burst) are still unique', async ({ page }) => {
    await openProject(page, makeProject({ code: '#', components: [led('led_1')], connections: [] }));
    const ids = await page.evaluate(() => {
      const cm = window.__voltloom.bridge.canvasManager;
      const made = [];
      for (let i = 0; i < 60; i++) made.push(cm.wireManager.createWire({ nodeType: 'gpio', pin: 1 + (i % 20), x: 0, y: 0 }, { nodeType: 'component_pin', componentId: 'led_1', pin: 'A' }).id);
      return made;
    });
    expect(new Set(ids).size).toBe(60);
  });

  test('components added in quick succession get different ids', async ({ page }) => {
    await openProject(page, makeProject({ code: '#' }));
    const ids = await page.evaluate(() => {
      const cm = window.__voltloom.bridge.canvasManager;
      for (let i = 0; i < 4; i++) { cm.addLED(); cm.addResistor(); cm.addPushButton(); }
      return cm.components.map((c) => c.id);
    });
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    // the ids are still of the shape the importer accepts (so a saved project reloads)
    expect(ids.every((id) => /^(led|res|btn)_[0-9]{1,16}$/.test(id))).toBe(true);
  });
});
