import { test, expect } from '@playwright/test';
import {
  makeProject, openProject, programOutput, gpio, cp, wire, LED, BUTTON, compilerReady,
} from './helpers.js';

// R3a — characterization tests.
//
// These pin down what the simulator does TODAY for every combination of LED, resistor, push button,
// GPIO and power rail, in Python and in C, so that the circuit-engine rewrite in phase R3 changes
// behaviour only deliberately. Tests in the "legacy" group describe behaviour that the new engine
// is EXPECTED to change (see docs/history/r3-design.md and docs/history/r3-spikes.md); when the engine is
// switched those tests are rewritten with the new expected values, never silently deleted.
//
// Physical pins: GP0=1, GP1=2, GP2=4, GP14=19, GP15=20, GND.1=3, GND.2=8, 3V3(OUT)=36, VSYS=39, VBUS=40.

const led = (id) => ({ ...LED, id });
const res = (id, value = 1, unit = 1000) => ({ id, type: 'resistor', x: 50, y: 300, rotation: 0, value, unit });
const btn = (id) => ({ ...BUTTON, id });
const P = 'from machine import Pin\nimport time\n';
const HIGH_FOR_A_WHILE = P + 'p = Pin(15, Pin.OUT)\np.high()\ntime.sleep(3)\n';


const litStates = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#board-container [id^=led_]')]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => !!d.querySelector('svg').style.filter));

async function run(page, project, { settle = 1500 } = {}) {
  await openProject(page, project);
  const before = await litStates(page);
  await page.click('#run-btn');
  await page.waitForTimeout(settle);
  return { before, running: await litStates(page) };
}

const python = (code, components, connections) => makeProject({ code, components, connections });
const cProg = (code, components, connections) => makeProject({ code, language: 'c', components, connections });

const C_GPIO15_HIGH = [
  '#include "pico/stdlib.h"',
  'int main() { gpio_init(15); gpio_set_dir(15, GPIO_OUT); gpio_put(15, 1); while (1) sleep_ms(100); }',
  '',
].join('\n');

const LED_VIA_RESISTOR = (r) => ({
  components: [led('led_1'), r],
  connections: [wire(gpio(20), cp(r.id, '1')), wire(cp(r.id, '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))],
});
const LED_DIRECT = { components: [led('led_1')], connections: [wire(gpio(20), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))] };
const LED_REVERSED = { components: [led('led_1')], connections: [wire(gpio(20), cp('led_1', 'C')), wire(gpio(3), cp('led_1', 'A'))] };
const LED_PARALLEL = {
  components: [led('led_1'), led('led_2')],
  connections: [wire(gpio(20), cp('led_1', 'A')), wire(gpio(20), cp('led_2', 'A')), wire(gpio(3), cp('led_1', 'C')), wire(gpio(8), cp('led_2', 'C'))],
};

test.describe('R3a — behaviour that must be PRESERVED (Python)', () => {
  test('LED on a GPIO follows the pin: lit when high, directly or through any resistor', async ({ page }) => {
    for (const circuit of [LED_DIRECT, LED_VIA_RESISTOR(res('res_1', 1, 1000))]) {
      const { before, running } = await run(page, python(HIGH_FOR_A_WHILE, circuit.components, circuit.connections));
      expect(before).toEqual([false]);
      expect(running).toEqual([true]);
      await page.click('#stop-btn');
      await page.waitForTimeout(300);
      expect(await litStates(page)).toEqual([false]);
    }
  });

  test('a reversed LED never lights', async ({ page }) => {
    const { running } = await run(page, python(HIGH_FOR_A_WHILE, LED_REVERSED.components, LED_REVERSED.connections));
    expect(running).toEqual([false]);
  });

  test('two LEDs in parallel on one GPIO both light', async ({ page }) => {
    const { running } = await run(page, python(HIGH_FOR_A_WHILE, LED_PARALLEL.components, LED_PARALLEL.connections));
    expect(running).toEqual([true, true]);
  });

  test('low GPIO keeps the LED off, toggling follows the program', async ({ page }) => {
    const code = P + 'p = Pin(15, Pin.OUT)\nfor i in range(40):\n    p.toggle()\n    time.sleep(0.1)\n';
    await openProject(page, python(code, LED_DIRECT.components, LED_DIRECT.connections));
    await page.click('#run-btn');
    const seen = new Set();
    for (let i = 0; i < 30; i++) { seen.add((await litStates(page))[0]); await page.waitForTimeout(100); }
    expect([...seen].sort()).toEqual([false, true]);
  });

  test('external 10k pull-up + button to GND (no internal pull): reads 1, 0 when pressed, 1 when released', async ({ page }) => {
    const code = P + 'b = Pin(0, Pin.IN)\nlast = -1\nfor i in range(80):\n    v = b.value()\n    if v != last:\n        print("v", v)\n        last = v\n    time.sleep(0.05)\n';
    await openProject(page, python(code, [btn('btn_1'), res('res_1', 10, 1000)], [
      wire(gpio(1), cp('btn_1', '1')), wire(gpio(3), cp('btn_1', '3')),
      wire(gpio(1), cp('res_1', '1')), wire(gpio(36), cp('res_1', '2')),
    ]));
    await page.click('#run-btn'); await page.waitForTimeout(800);
    await page.dispatchEvent('#btn-cap-group-btn_1', 'mousedown'); await page.waitForTimeout(700);
    await page.dispatchEvent('#btn-cap-group-btn_1', 'mouseup'); await page.waitForTimeout(700);
    expect((await programOutput(page)).filter((l) => /^v \d$/.test(l))).toEqual(['v 1', 'v 0', 'v 1']);
  });

  test('a button controls an LED through the program (button -> GPIO -> program -> LED)', async ({ page }) => {
    const code = P + 'b = Pin(0, Pin.IN, Pin.PULL_UP)\nled = Pin(15, Pin.OUT)\nfor i in range(120):\n    led.value(0 if b.value() else 1)\n    time.sleep(0.02)\n';
    await openProject(page, python(code, [btn('btn_1'), led('led_1')], [
      wire(gpio(1), cp('btn_1', '1')), wire(gpio(3), cp('btn_1', '3')),
      wire(gpio(20), cp('led_1', 'A')), wire(gpio(8), cp('led_1', 'C')),
    ]));
    await page.click('#run-btn'); await page.waitForTimeout(800);
    expect(await litStates(page)).toEqual([false]);
    await page.dispatchEvent('#btn-cap-group-btn_1', 'mousedown'); await page.waitForTimeout(500);
    expect(await litStates(page)).toEqual([true]);
    await page.dispatchEvent('#btn-cap-group-btn_1', 'mouseup'); await page.waitForTimeout(500);
    expect(await litStates(page)).toEqual([false]);
  });

  test('project with every part type saves, shares and reloads with the same wiring', async ({ page }) => {
    const parts = [led('led_1'), res('res_1', 4.7, 1000), btn('btn_1')];
    const wires = [wire(gpio(20), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C')), wire(gpio(1), cp('btn_1', '1'))];
    await openProject(page, python('print(1)', parts, wires));
    const shape = await page.evaluate(() => ({
      parts: [...document.querySelectorAll('#board-container [id^=led_],#board-container [id^=res_],#board-container [id^=btn_]')].map((d) => d.id).sort(),
      wires: document.querySelectorAll('#wire-layer path').length,
    }));
    expect(shape).toEqual({ parts: ['btn_1', 'led_1', 'res_1'], wires: 4 });
  });
});

test.describe('R3a — behaviour that must be PRESERVED (C)', () => {
  test.beforeEach(async () => { test.skip(!(await compilerReady()), 'compile service or Emscripten not available'); });

  test('C: LED on a GPIO is lit when high, directly or through a resistor; reversed LED stays off', async ({ page }) => {
    for (const [circuit, expected] of [[LED_DIRECT, true], [LED_VIA_RESISTOR(res('res_1', 1, 1000)), true], [LED_REVERSED, false]]) {
      await openProject(page, cProg(C_GPIO15_HIGH, circuit.components, circuit.connections));
      await page.click('#run-btn');
      await expect.poll(() => litStates(page), { timeout: 60_000 }).toEqual([expected]);
      if (expected) await page.waitForTimeout(500);
      expect(await litStates(page)).toEqual([expected]);
      await page.click('#stop-btn');
    }
  });

  test('C: two LEDs in parallel on one GPIO both light', async ({ page }) => {
    await openProject(page, cProg(C_GPIO15_HIGH, LED_PARALLEL.components, LED_PARALLEL.connections));
    await page.click('#run-btn');
    await expect.poll(() => litStates(page), { timeout: 60_000 }).toEqual([true, true]);
    await page.click('#stop-btn');
  });

  test('C: external pull-up + button reads 1, 0 when pressed, 1 when released', async ({ page }) => {
    const code = [
      '#include "pico/stdlib.h"',
      'int main() { stdio_init_all(); gpio_init(0); gpio_set_dir(0, GPIO_IN); int last = -1;',
      '  while (1) { int v = gpio_get(0); if (v != last) { printf("v=%d\\n", v); last = v; } sleep_ms(20); } }',
      '',
    ].join('\n');
    await openProject(page, cProg(code, [btn('btn_1'), res('res_1', 10, 1000)], [
      wire(gpio(1), cp('btn_1', '1')), wire(gpio(3), cp('btn_1', '3')),
      wire(gpio(1), cp('res_1', '1')), wire(gpio(36), cp('res_1', '2')),
    ]));
    await page.click('#run-btn');
    await expect.poll(async () => (await programOutput(page)).join('\n'), { timeout: 60_000 }).toMatch(/v=1/);
    await page.dispatchEvent('#btn-cap-group-btn_1', 'mousedown');
    await expect.poll(async () => (await programOutput(page)).join('\n'), { timeout: 10_000 }).toMatch(/v=1\s*\n?v=0/);
    await page.dispatchEvent('#btn-cap-group-btn_1', 'mouseup');
    await expect.poll(async () => (await programOutput(page)).join('\n'), { timeout: 10_000 }).toMatch(/v=1\s*\n?v=0\s*\n?v=1/);
    await page.click('#stop-btn');
  });
});

// ---------------------------------------------------------------------------------------------
// R3c-3: the former LEGACY tests, rewritten with the behaviour of the electrical engine (B1, B4, B5).
// The old expectations are kept in the test names so the change stays visible.
// ---------------------------------------------------------------------------------------------
const brightness = (page, id = 'led_1') =>
  page.evaluate((i) => { const s = document.querySelector('#' + i + ' svg'); return s && s.style.filter ? Number(s.style.opacity) : 0; }, id);

test.describe('R3c-3 — electrical behaviour (was LEGACY B1/B4/B5)', () => {
  test('B1 (was: dark): 3V3 -> 330 ohm -> LED -> GND is lit before Run, while running, and after Stop', async ({ page }) => {
    const r = res('res_1', 330, 1);
    await openProject(page, python(P + 'time.sleep(3)\n', [led('led_1'), r],
      [wire(gpio(36), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))]));
    await expect.poll(() => litStates(page)).toEqual([true]);          // before Run: the board is powered
    await page.click('#run-btn'); await page.waitForTimeout(1500);
    expect(await litStates(page)).toEqual([true]);
    await page.click('#stop-btn'); await page.waitForTimeout(300);
    expect(await litStates(page)).toEqual([true]);                     // still powered after Stop
  });

  test('B1/B6: an LED wired straight across 3V3 is lit and reported as destroyed (numbers in the console and the badge)', async ({ page }) => {
    await openProject(page, python(P + 'time.sleep(1)\n', [led('led_1')], [wire(gpio(36), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))]));
    await expect.poll(() => litStates(page)).toEqual([true]);
    await expect(page.locator('#circuit-status')).toBeVisible();
    await expect(page.locator('#circuit-status')).toHaveAttribute('data-severity', 'error');
    expect((await programOutput(page)).join('\n')).toMatch(/LED 1 carries \d+\.\d+ mA and would be destroyed\. Add a series resistor\./);
  });

  test('3V3 -> button -> LED -> GND is dark until the button is pressed, and dark again when released', async ({ page }) => {
    await openProject(page, python(P + 'time.sleep(5)\n', [btn('btn_1'), led('led_1'), res('res_1', 330, 1)], [
      wire(gpio(36), cp('btn_1', '1')), wire(cp('btn_1', '3'), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C')),
    ]));
    await page.click('#run-btn'); await page.waitForTimeout(1000);
    expect(await litStates(page)).toEqual([false]);
    await page.dispatchEvent('#btn-cap-group-btn_1', 'mousedown'); await page.waitForTimeout(400);
    expect(await litStates(page)).toEqual([true]);
    await page.dispatchEvent('#btn-cap-group-btn_1', 'mouseup'); await page.waitForTimeout(400);
    expect(await litStates(page)).toEqual([false]);
    await page.click('#stop-btn');
  });

  test('B4 (was: resistor ignored): 10 MOhm keeps the LED dark, 330 ohm lights it, brightness falls as resistance rises', async ({ page }) => {
    const levels = [];
    for (const [value, unit] of [[330, 1], [1, 1000], [10, 1000], [10, 1000000]]) {
      const { running } = await run(page, python(HIGH_FOR_A_WHILE, ...Object.values(LED_VIA_RESISTOR(res('res_1', value, unit)))));
      levels.push(running[0] ? await brightness(page) : 0);
      await page.click('#stop-btn');
    }
    expect(levels[0]).toBeGreaterThan(levels[1]);
    expect(levels[1]).toBeGreaterThan(levels[2]);
    expect(levels[2]).toBeGreaterThan(0);
    expect(levels[3]).toBe(0);                // 10 MOhm: dark
  });

  test('B5 (was: stop): an input GPIO wired to an output GPIO reads it, and the run is NOT stopped', async ({ page }) => {
    const code = P + 'o = Pin(14, Pin.OUT)\ni = Pin(15, Pin.IN, Pin.PULL_DOWN)\no.high()\ntime.sleep(0.5)\nprint("read", i.value())\no.low()\ntime.sleep(0.5)\nprint("read", i.value())\ntime.sleep(5)\n';
    await openProject(page, python(code, [], [wire(gpio(19), gpio(20))]));
    await page.click('#run-btn');
    await expect.poll(async () => (await programOutput(page)).join('\n'), { timeout: 15_000 }).toMatch(/read 1\s*\n?read 0/);
    await expect(page.locator('#stop-btn')).toBeEnabled();              // still running
    expect((await programOutput(page)).join('\n')).not.toMatch(/No button connected/);
    await page.click('#stop-btn');
  });

  test('B5 (was: stop): an output GPIO with nothing wired is a warning, not a stop', async ({ page }) => {
    await openProject(page, python(P + 'p = Pin(15, Pin.OUT)\np.high()\ntime.sleep(4)\nprint("alive")\n', [], []));
    await page.click('#run-btn');
    await expect.poll(async () => (await programOutput(page)).join('\n'), { timeout: 10_000 }).toMatch(/GP15 is set as an output but nothing is wired to it\./);
    await expect(page.locator('#stop-btn')).toBeEnabled();
    await expect.poll(async () => (await programOutput(page)).join('\n'), { timeout: 10_000 }).toMatch(/alive/);
    await page.click('#stop-btn');
  });
});
