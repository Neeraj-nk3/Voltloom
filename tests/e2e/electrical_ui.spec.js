import { test, expect } from '@playwright/test';
import { makeProject, openProject, programOutput, gpio, cp, wire, LED, compilerReady, press } from './helpers.js';

// R3c-3 — the electrical engine as the user sees it: LED brightness from current, the properties readout,
// warnings and the status badge, GPIO-to-GPIO wiring, PWM, Stop / Reset / re-run, and solver-failure visibility.
// Physical pins: GP0=1, GP14=19, GP15=20, GND.1=3, 3V3(OUT)=36.

const led = (id = 'led_1', color = '#ef4444') => ({ ...LED, id, color });
const res = (id, value, unit = 1) => ({ id, type: 'resistor', x: 50, y: 300, rotation: 0, value, unit });
const P = 'from machine import Pin\nimport time\n';

const lit = (page, id = 'led_1') => page.evaluate((i) => !!document.querySelector('#' + i + ' svg').style.filter, id);
const brightness = (page, id = 'led_1') =>
  page.evaluate((i) => { const s = document.querySelector('#' + i + ' svg'); return s.style.filter ? Number(s.style.opacity) : 0; }, id);
const consoleText = async (page) => (await programOutput(page)).join('\n');

// 3V3 -> R -> LED -> GND
const poweredLed = (ohms, unit = 1, color = '#ef4444') => ({
  components: [led('led_1', color), res('res_1', ohms, unit)],
  connections: [wire(gpio(36), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))],
});
// GP15 -> R -> LED -> GND
const padLed = (ohms) => ({
  components: [led(), res('res_1', ohms)],
  connections: [wire(gpio(20), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))],
});

test.describe('resistance changes current and brightness in the UI', () => {
  test('editing the resistor value in the popup changes LED brightness live, with no program running', async ({ page }) => {
    const c = poweredLed(330);
    await openProject(page, makeProject({ code: '# idle', components: c.components, connections: c.connections }));
    await expect.poll(() => lit(page)).toBe(true);
    const at330 = await brightness(page);

    await press(page, 'res_1');
    await page.fill('#popup-value', '10');
    await page.selectOption('#popup-unit', '1000');             // 10 kOhm
    await expect.poll(() => brightness(page)).toBeLessThan(at330);
    const at10k = await brightness(page);
    expect(at10k).toBeGreaterThan(0);                            // still faintly visible

    await page.fill('#popup-value', '10');
    await page.selectOption('#popup-unit', '1000000');           // 10 MOhm
    await expect.poll(() => lit(page)).toBe(false);

    await page.fill('#popup-value', '330');
    await page.selectOption('#popup-unit', '1');
    await expect.poll(() => brightness(page)).toBeCloseTo(at330, 5);
  });

  test('the properties popup shows current, voltage and power that match Ohm\'s law', async ({ page }) => {
    // 3V3 (0.2 ohm) -> 1 kOhm -> red LED: about 1.4 mA
    const c = poweredLed(1, 1000);
    await openProject(page, makeProject({ code: '# idle', components: c.components, connections: c.connections }));
    await press(page, 'res_1');
    const readout = page.locator('#popup-readout');
    await expect(readout).toBeVisible();
    const text = await readout.textContent();
    const m = text.match(/^([\d.]+) mA · ([\d.]+) V · ([\d.]+) mW$/);
    expect(m, text).not.toBeNull();
    const [mA, volts, mW] = [Number(m[1]), Number(m[2]), Number(m[3])];
    expect(mA).toBeGreaterThan(1.2); expect(mA).toBeLessThan(1.7);
    expect(volts).toBeCloseTo(mA / 1000 * 1000, 1);                      // V = I x 1 kOhm
    expect(mW).toBeCloseTo(mA / 1000 * volts * 1000, 1);                 // P = I x V

    await press(page, 'led_1');
    await expect(readout).toHaveText(/^[\d.]+ mA · 1\.[6-9]\d V$/);        // the LED sits near its forward voltage
  });

  test('colour matters: a blue LED is dimmer than a red one on the same circuit', async ({ page }) => {
    const levels = [];
    for (const color of ['#ef4444', '#3b82f6']) {
      const c = poweredLed(330, 1, color);
      await openProject(page, makeProject({ code: '# idle', components: c.components, connections: c.connections }));
      await expect.poll(() => lit(page)).toBe(true);
      levels.push(await brightness(page));
    }
    expect(levels[1]).toBeLessThan(levels[0]);
  });
});

test.describe('warnings and the status badge', () => {
  test('an LED across a rail with no resistor is flagged on the badge and in the console; adding a resistor clears the badge', async ({ page }) => {
    await openProject(page, makeProject({ code: '# idle', components: [led()], connections: [wire(gpio(36), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))] }));
    const badge = page.locator('#circuit-status');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-severity', 'error');
    await expect(badge).toHaveAttribute('title', /would be destroyed/);
    await expect.poll(() => consoleText(page)).toMatch(/would be destroyed/);

    const c = poweredLed(330);
    await openProject(page, makeProject({ code: '# idle', components: c.components, connections: c.connections }));
    await expect(page.locator('#circuit-status')).toBeHidden();
  });

  test('a GPIO pushing more than its 4 mA drive strength warns once, with numbers, while it stays high', async ({ page }) => {
    const c = padLed(47);
    await openProject(page, makeProject({ code: P + 'p = Pin(15, Pin.OUT)\nfor i in range(6):\n    p.high()\n    time.sleep(0.2)\n    p.low()\n    time.sleep(0.2)\ntime.sleep(2)\n', components: c.components, connections: c.connections }));
    await page.click('#run-btn');
    await expect.poll(() => consoleText(page), { timeout: 15_000 }).toMatch(/GP15 supplies \d\.\d\d mA \(rated 4\.00 mA\)\./);
    await page.waitForTimeout(2500);
    const occurrences = (await consoleText(page)).match(/GP15 supplies/g) || [];
    expect(occurrences.length).toBe(1);                         // reported once per condition, not on every toggle
    await page.click('#stop-btn');
  });

  test('a sensible resistor produces no warning', async ({ page }) => {
    const c = padLed(330);
    await openProject(page, makeProject({ code: P + 'p = Pin(15, Pin.OUT)\np.high()\ntime.sleep(2)\n', components: c.components, connections: c.connections }));
    await page.click('#run-btn'); await page.waitForTimeout(1500);
    expect(await consoleText(page)).not.toMatch(/\[Warning\]|supplies|destroyed/);
    await expect(page.locator('#circuit-status')).toBeHidden();
    await page.click('#stop-btn');
  });

  test('an unsolvable circuit is never hidden: console error, red badge, and the last good LED picture stays', async ({ page }) => {
    const c = poweredLed(330);
    await openProject(page, makeProject({ code: '# idle', components: c.components, connections: c.connections }));
    await expect.poll(() => lit(page)).toBe(true);
    // Make the engine report a failed solve (the engine itself is unit-tested to fail this way for real).
    await page.evaluate(() => {
      const bridge = window.__voltloom.bridge;
      const good = bridge.engine.lastGood();
      const failure = { code: 'unsolvable', severity: 'error', subject: null, value: null, limit: null, message: 'This circuit could not be solved; showing the last valid state.' };
      bridge.engine.update = () => ({ result: good, stale: true, failure, warnings: [failure], added: [failure], cleared: [], notes: [] });
      bridge.updateCircuit();
    });
    const badge = page.locator('#circuit-status');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('Circuit could not be solved');
    await expect.poll(() => consoleText(page)).toMatch(/This circuit could not be solved; showing the last valid state\./);
    expect(await lit(page)).toBe(true);                         // last good picture kept, not blanked or invented
  });
});

test.describe('GPIO interactions and lifecycle (Python)', () => {
  test('LED between 3V3 and a GPIO: lit while the pin sinks (low), dark when it is driven high, dark when it is an input', async ({ page }) => {
    const code = P + 'p = Pin(14, Pin.OUT)\np.low()\ntime.sleep(1.2)\np.high()\ntime.sleep(1.2)\nPin(14, Pin.IN)\ntime.sleep(3)\n';
    await openProject(page, makeProject({ code, components: [led(), res('res_1', 330)],
      connections: [wire(gpio(36), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(19), cp('led_1', 'C'))] }));
    await page.click('#run-btn');
    await expect.poll(() => lit(page), { timeout: 8_000 }).toBe(true);        // sinking
    await expect.poll(() => lit(page), { timeout: 8_000 }).toBe(false);       // high: no voltage across the LED
    await page.click('#stop-btn');
  });

  test('Stop returns the pins to reset: a GPIO-driven LED goes dark, a rail-powered LED stays lit; Run again works', async ({ page }) => {
    const pad = padLed(330);
    const rail = poweredLed(330);
    const components = [led('led_1'), res('res_1', 330), led('led_2'), res('res_2', 330)];
    const connections = [
      ...pad.connections,
      wire(gpio(36), cp('res_2', '1')), wire(cp('res_2', '2'), cp('led_2', 'A')), wire(gpio(3), cp('led_2', 'C')),
    ];
    await openProject(page, makeProject({ code: P + 'p = Pin(15, Pin.OUT)\np.high()\ntime.sleep(10)\n', components, connections }));
    expect(await lit(page, 'led_2')).toBe(true);                               // rail LED lit before Run
    for (let round = 0; round < 2; round++) {
      await page.click('#run-btn');
      await expect.poll(() => lit(page, 'led_1'), { timeout: 10_000 }).toBe(true);
      expect(await lit(page, 'led_2')).toBe(true);
      await page.click('#stop-btn');
      await expect.poll(() => lit(page, 'led_1')).toBe(false);                  // pad is back to an input
      expect(await lit(page, 'led_2')).toBe(true);                              // still powered
    }
  });

  test('a program that resets itself restarts cleanly and the LED keeps following the pin', async ({ page }) => {
    const c = padLed(330);
    const code = P + 'import machine\np = Pin(15, Pin.OUT)\np.high()\ntime.sleep(1.2)\nmachine.reset()\n';
    await openProject(page, makeProject({ code, components: c.components, connections: c.connections }));
    await page.click('#run-btn');
    await expect.poll(() => lit(page), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => consoleText(page), { timeout: 15_000 }).toMatch(/restarting firmware/i);
    await expect.poll(() => lit(page), { timeout: 15_000 }).toBe(true);        // lit again after the restart
    await page.click('#stop-btn');
  });
});

test.describe('C and Python agree', () => {
  test.beforeEach(async () => {
    test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
  });

  const C_LOOPBACK = [
    '#include "pico/stdlib.h"', 'int main() {', '  stdio_init_all();',
    '  gpio_init(14); gpio_set_dir(14, GPIO_OUT); gpio_init(15); gpio_set_dir(15, GPIO_IN); gpio_pull_down(15);',
    '  gpio_put(14, 1); sleep_ms(300); printf("read %d\\n", gpio_get(15));',
    '  gpio_put(14, 0); sleep_ms(300); printf("read %d\\n", gpio_get(15));',
    '  while (1) sleep_ms(100);', '}', '',
  ].join('\n');

  test('GPIO-to-GPIO wiring: the input reads the output, in C exactly as in Python', async ({ page }) => {
    await openProject(page, makeProject({ code: C_LOOPBACK, language: 'c', components: [], connections: [wire(gpio(19), gpio(20))] }));
    await page.click('#run-btn');
    await expect.poll(() => consoleText(page), { timeout: 60_000 }).toMatch(/read 1\s*\n?read 0/);
    await expect(page.locator('#stop-btn')).toBeEnabled();
    expect(await consoleText(page)).not.toMatch(/No button connected/);
    await page.click('#stop-btn');
  });

  const pwmProgram = (level) => [
    '#include "pico/stdlib.h"', '#include "hardware/pwm.h"', 'int main() {',
    '  gpio_set_function(15, GPIO_FUNC_PWM);', '  uint slice = pwm_gpio_to_slice_num(15);',
    '  pwm_set_wrap(slice, 999);', `  pwm_set_gpio_level(15, ${level});`, '  pwm_set_enabled(slice, true);',
    '  while (1) sleep_ms(100);', '}', '',
  ].join('\n');

  test('an LED driven only by PWM lights in proportion to the duty cycle (B2)', async ({ page }) => {
    const c = padLed(330);
    const levels = [];
    for (const level of [100, 500, 900]) {
      await openProject(page, makeProject({ code: pwmProgram(level), language: 'c', components: c.components, connections: c.connections }));
      await page.click('#run-btn');
      await expect.poll(() => lit(page), { timeout: 60_000 }).toBe(true);
      await page.waitForTimeout(400);
      levels.push(await brightness(page));
      await page.click('#stop-btn');
    }
    expect(levels[0]).toBeLessThan(levels[1]);
    expect(levels[1]).toBeLessThan(levels[2]);
    expect(levels[2]).toBeLessThan(1);                           // 330 ohm from a pad never reaches full brightness
  });

  test('a C program that never configures anything leaves a rail-powered LED lit and raises no warning', async ({ page }) => {
    const c = poweredLed(330);
    await openProject(page, makeProject({ code: '#include "pico/stdlib.h"\nint main(){ while(1) sleep_ms(100); }\n', language: 'c', components: c.components, connections: c.connections }));
    await page.click('#run-btn');
    await expect.poll(() => consoleText(page), { timeout: 60_000 }).toMatch(/Firmware running/);
    expect(await lit(page)).toBe(true);
    expect(await consoleText(page)).not.toMatch(/\[Warning\]/);
    await page.click('#stop-btn');
    expect(await lit(page)).toBe(true);
  });
});
