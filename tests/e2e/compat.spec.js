import { test, expect } from '@playwright/test';
import { makeProject, openProject, gpio, cp, wire, LED, programOutput } from './helpers.js';

// R6 — small correctness and compatibility fixes that need the real page.

const led = { ...LED, id: 'led_1' };
const res = { id: 'res_1', type: 'resistor', x: 50, y: 300, rotation: 0, value: 330, unit: 1 };
const WIRED = { components: [led, res], connections: [wire(gpio(20), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))] };

const graphWireCount = (page) => page.evaluate(() => window.__voltloom.wireRegistry.getWires().length);
const canvasWireCount = (page) => page.evaluate(() => window.__voltloom.bridge.canvasManager.wires.length);

test.describe('the connection graph agrees with the canvas', () => {
  test('after a project loads, and after a component is deleted with its wires', async ({ page }) => {
    await openProject(page, makeProject({ code: '#', ...WIRED }));
    expect(await canvasWireCount(page)).toBe(3);
    expect(await graphWireCount(page)).toBe(3);

    await page.dispatchEvent('#res_1', 'mousedown'); await page.dispatchEvent('#res_1', 'mouseup');   // select the resistor
    await page.waitForTimeout(200);
    await page.click('#popup-delete');
    await expect.poll(() => canvasWireCount(page)).toBe(1);               // only LED cathode -> GND is left
    expect(await graphWireCount(page)).toBe(1);                            // it used to keep all 3 (stale wires to a deleted part)
  });

  test('a wire that was once drawn between two pins can be drawn again after the part it touched is gone', async ({ page }) => {
    await openProject(page, makeProject({ code: '#', ...WIRED }));
    await page.dispatchEvent('#led_1', 'mousedown'); await page.dispatchEvent('#led_1', 'mouseup');
    await page.waitForTimeout(200);
    await page.click('#popup-delete');
    await expect.poll(() => canvasWireCount(page)).toBe(1);               // GP15 -> resistor pin 1 remains
    expect(await graphWireCount(page)).toBe(1);
    const accepted = await page.evaluate(() => {
      // the wire that went with the LED must no longer count as an existing connection
      return window.__voltloom.wireRegistry.validateWire({ nodeType: 'component_pin', componentId: 'res_1', pin: '2' }, { nodeType: 'gpio', pin: 3 }).valid;
    });
    expect(accepted).toBe(true);
  });
});

test.describe('Save Code names the file after the language', () => {
  for (const [language, code, name] of [['python', 'print("hi")\n', 'main.py'], ['c', '#include "pico/stdlib.h"\nint main() { return 0; }\n', 'main.c']]) {
    test(`${language} program -> ${name}`, async ({ page }) => {
      await openProject(page, makeProject({ code, language }));
      const download = page.waitForEvent('download');
      await page.click('#save-code-btn');
      expect((await download).suggestedFilename()).toBe(name);
    });
  }
});

test.describe('Pico W idioms in the browser', () => {
  test('Pin("LED") works, and a Pin with a bad number raises a ValueError that a program can catch', async ({ page }) => {
    const code = ['from machine import Pin', 'import time', 'led = Pin("LED", Pin.OUT)', 'led.on()',
      'try:', '    Pin(99)', 'except ValueError:', '    print("caught")', 'print("led", led.value())', 'time.sleep(1)', ''].join('\n');
    await openProject(page, makeProject({ code }));
    await page.click('#run-btn');
    await expect.poll(async () => (await programOutput(page)).join('\n'), { timeout: 15_000 }).toMatch(/caught\s*\n?led 1/);
    await page.click('#stop-btn');
  });

  test('PWM at duty 0 darkens an LED that was left high, in the browser too', async ({ page }) => {
    const code = ['from machine import Pin, PWM', 'import time', 'p = Pin(15, Pin.OUT)', 'p.on()', 'time.sleep(1.2)',
      'pwm = PWM(p)', 'pwm.duty_u16(0)', 'print("duty0")', 'time.sleep(5)', ''].join('\n');
    await openProject(page, makeProject({ code, ...WIRED }));
    const lit = () => page.evaluate(() => !!document.querySelector('#led_1 svg').style.filter);
    await page.click('#run-btn');
    await expect.poll(lit, { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => (await programOutput(page)).join('\n'), { timeout: 15_000 }).toMatch(/duty0/);
    await expect.poll(lit, { timeout: 5_000 }).toBe(false);
    await page.click('#stop-btn');
  });
});
