import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { makeProject, openProject, press } from './helpers.js';

// R3b — characterization of everything the part registry refactor touches.
//
// tests/e2e/fixtures/parts_golden.json was recorded from the simulator BEFORE the component registry
// existed (phase R3a/R3b). The registry refactor must not change any of it. Cases covered: the
// diagram tab, wire endpoints for every part, the popup controls per part type, wire validity rules,
// circuit-validator warnings, the state inspector, palette defaults and numbering, edits (value,
// rotate, flip, colour) and deletion.

const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/parts_golden.json', import.meta.url), 'utf8'));

const g = (pin, x = 0, y = 0) => ({ nodeType: 'gpio', pin, x, y });
const c = (id, pin) => ({ nodeType: 'component_pin', componentId: id, pin });
const w = (a, b) => ({ start: a, end: b, color: '#15803d' });
const LEDp = { id: 'led_1', type: 'led', x: 100, y: 300, rotation: 0, color: '#3b82f6', flipped: false };
const RESp = { id: 'res_1', type: 'resistor', x: 400, y: 300, rotation: 90, value: 4.7, unit: 1000 };
const BTNp = { id: 'btn_1', type: 'button', x: 100, y: 600, rotation: 0 };
const IDLE = 'import time\ntime.sleep(3)\n';

const open = (page, components, connections) => openProject(page, makeProject({ code: IDLE, components, connections }));
const lines = (page) => page.evaluate(() => [...document.querySelectorAll('#output > div')].map((d) => d.innerText.replace(/\s+/g, ' ').trim()));

test.describe('parts registry characterization (recorded before the refactor)', () => {
  test('the diagram tab and the wire paths of a circuit with every part type', async ({ page }) => {
    await open(page, [LEDp, RESp, BTNp], [w(g(20, 5, 6), c('res_1', '1')), w(c('res_1', '2'), c('led_1', 'A')), w(g(3, 7, 8), c('led_1', 'C')), w(g(1, 9, 10), c('btn_1', '1'))]);
    await page.click('#tab-diagram');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => monaco.editor.getModels()[0].getValue())).toBe(golden.diagram);
    expect(await page.evaluate(() => [...document.querySelectorAll('#wire-layer path')].map((p) => p.getAttribute('d')))).toEqual(golden.wirePaths);
  });

  test('selecting each part type shows the right popup controls', async ({ page }) => {
    await open(page, [LEDp, RESp, BTNp], []);
    const seen = {};
    for (const [id, name] of [['led_1', 'led'], ['res_1', 'resistor'], ['btn_1', 'button']]) {
      await press(page, id);
      seen[name] = await page.evaluate(() => {
        const vis = (i) => { const e = document.getElementById(i); return !!e && !e.classList.contains('hidden'); };
        return {
          popup: vis('component-popup'), resistorControls: vis('resistor-controls'), ledControls: vis('led-controls'),
          flip: vis('popup-flip'), value: document.getElementById('popup-value').value, unit: document.getElementById('popup-unit').value,
        };
      });
    }
    expect(seen).toEqual(golden.popups);
  });

  test('wire validity rules per part and pin (polarity rules, passive parts connect to anything)', async ({ page }) => {
    await open(page, [LEDp, RESp, BTNp], []);
    const attempt = async (comp, pin, boardLabel) => {
      const before = await page.evaluate(() => document.querySelectorAll('#wire-layer path').length);
      await page.dispatchEvent('#' + comp + ' [data-pin="' + pin + '"]', 'mousedown');
      await page.dispatchEvent('#board-container [data-pin-label="' + boardLabel + '"]', 'click');
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => document.querySelectorAll('#wire-layer path').length);
      const invalid = (await lines(page)).filter((t) => /Invalid connection/.test(t)).length;
      await page.keyboard.press('Escape');
      return { created: after - before, invalidMessagesSoFar: invalid };
    };
    const seen = {
      'LED anode -> GND.1': await attempt('led_1', 'A', 'GND.1'),
      'LED anode -> 3V3(OUT)': await attempt('led_1', 'A', '3V3(OUT)'),
      'LED cathode -> VBUS': await attempt('led_1', 'C', 'VBUS'),
      'LED cathode -> GND.2': await attempt('led_1', 'C', 'GND.2'),
      'LED anode -> GP15': await attempt('led_1', 'A', 'GP15'),
      'resistor 1 -> GND.3': await attempt('res_1', '1', 'GND.3'),
      'resistor 2 -> VBUS': await attempt('res_1', '2', 'VBUS'),
      'button 1 -> GND.4': await attempt('btn_1', '1', 'GND.4'),
    };
    expect(seen).toEqual(golden.validity);
  });

  test('circuit-validator warnings and the state inspector list for a half-wired circuit', async ({ page }) => {
    await open(page, [LEDp, RESp, BTNp, { ...LEDp, id: 'led_2' }], [w(g(20), c('led_1', 'A')), w(g(3), c('led_2', 'C')), w(g(1), c('res_1', '1')), w(g(2), c('btn_1', '1'))]);
    await page.click('#run-btn');
    await page.waitForTimeout(1500);
    expect((await lines(page)).filter((t) => /Warning/.test(t))).toEqual(golden.warnings);
    await page.click('#inspector-toggle-btn');
    await page.waitForTimeout(600);
    const inspector = await page.evaluate(() => document.getElementById('state-inspector-panel').innerText.replace(/[ \t]+/g, ' ').split('\n').map((s) => s.trim()).filter(Boolean));
    expect(inspector).toEqual(golden.inspector);
  });

  test('palette defaults, labels and numbering, then value/rotate/flip/colour edits and deletion', async ({ page }) => {
    await open(page, [], []);
    const add = async (id) => { await page.click('#add-component-btn'); await page.click(id); await page.waitForTimeout(40); };
    await add('#add-led-btn'); await add('#add-led-btn'); await add('#add-resistor-btn'); await add('#add-pushbutton-btn'); await add('#add-pushbutton-btn');
    expect(await page.evaluate(() => [...document.querySelectorAll('#board-container > div[id]')].filter((d) => /^(led|res|btn)_/.test(d.id)).map((d) => ({
      prefix: d.id.split('_')[0], label: (d.querySelector('.led-label,.resistor-label,.pushbutton-label') || {}).textContent, left: d.style.left, top: d.style.top,
    })))).toEqual(golden.palette);

    const resId = await page.evaluate(() => document.querySelector('#board-container > div[id^=res_]').id);
    await press(page, resId);
    await page.fill('#popup-value', '220');
    await page.selectOption('#popup-unit', '1');
    await page.waitForTimeout(150);
    expect(await page.evaluate((id) => {
      const d = document.getElementById(id);
      return { label: d.querySelector('.resistor-label').textContent, bands: [1, 2, 3, 4].map((i) => document.getElementById('band' + i + '_' + id).getAttribute('fill')) };
    }, resId)).toEqual(golden.resistorEdit);
    await page.click('#popup-rotate');
    await page.waitForTimeout(100);
    expect(await page.evaluate((id) => document.getElementById(id).style.transform, resId)).toBe(golden.rotate);

    const ledId = await page.evaluate(() => document.querySelector('#board-container > div[id^=led_]').id);
    await press(page, ledId);
    await page.click('#led-controls [data-color="#22c55e"]');
    await page.click('#popup-flip');
    await page.waitForTimeout(100);
    expect(await page.evaluate((id) => {
      const d = document.getElementById(id);
      return {
        transform: d.style.transform,
        stops: [1, 2, 3].map((i) => document.getElementById('stop' + i + '-' + id).getAttribute('stop-color')),
        label: d.querySelector('.led-label').style.color,
      };
    }, ledId)).toEqual(golden.ledEdit);

    const before = await page.evaluate(() => document.querySelectorAll('#board-container > div[id]').length);
    await page.click('#popup-delete');
    await page.waitForTimeout(100);
    expect(before - (await page.evaluate(() => document.querySelectorAll('#board-container > div[id]').length))).toBe(golden.deleteRemoved);
  });
});
