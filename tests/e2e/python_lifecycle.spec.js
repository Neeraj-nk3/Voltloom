import { test, expect } from '@playwright/test';
import { makeProject, openProject, programOutput, ledIsOn, LED, LED_ON_GP15 } from './helpers.js';

const text = async (page) => (await programOutput(page)).join('\n');
const isResponsive = (page) =>
  Promise.race([page.evaluate(() => 'responsive'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);

test.describe('Python lifecycle and protocol', () => {
  test('program output that looks like a command is only text (it cannot drive a pin)', async ({ page }) => {
    const code = [
      'from machine import Pin',
      'import time',
      'led = Pin(15, Pin.OUT)',
      'print("ON:15")', 'print("TOGGLE:15")', 'print("CREATE:15:1:0")',
      'time.sleep(1.5)',
      '',
    ].join('\n');
    await openProject(page, makeProject({ code, components: [LED], connections: LED_ON_GP15 }));
    await page.click('#run-btn');
    await page.waitForTimeout(1200);
    expect(await ledIsOn(page)).toBe(false);
    expect(await text(page)).toContain('ON:15');
    await page.click('#stop-btn');
  });

  test('an infinite loop that never sleeps does not freeze the page, and Stop ends it', async ({ page }) => {
    await openProject(page, makeProject({ code: 'x = 0\nwhile True:\n    x += 1\n' }));
    await page.click('#run-btn');
    await page.waitForTimeout(1500);
    expect(await isResponsive(page)).toBe('responsive');
    await page.click('#stop-btn');
    await expect(page.locator('#run-btn')).toBeEnabled();
    expect(await isResponsive(page)).toBe('responsive');
  });

  test('a flood of print output cannot freeze the page; the console stays bounded', async ({ page }) => {
    await openProject(page, makeProject({ code: 'while True:\n    print("flood")\n' }));
    await page.click('#run-btn');
    await page.waitForTimeout(3000);
    expect(await isResponsive(page)).toBe('responsive');
    expect(await page.evaluate(() => document.querySelectorAll('#output > div').length)).toBeLessThanOrEqual(1000);
    await page.click('#stop-btn');
  });

  test('after a tight toggling loop the LED ends in the level the program last wrote', async ({ page }) => {
    const code = [
      'from machine import Pin',
      'led = Pin(15, Pin.OUT)',
      'for i in range(60000):',
      '    led.toggle()',
      'led.high()',
      'while True:',
      '    pass',
      '',
    ].join('\n');
    await openProject(page, makeProject({ code, components: [LED], connections: LED_ON_GP15 }));
    await page.click('#run-btn');
    await expect.poll(() => ledIsOn(page), { timeout: 30_000 }).toBe(true);
    expect(await isResponsive(page)).toBe('responsive');
    await page.click('#stop-btn');
  });

  test('machine.reset() restarts the program from the top, one instance at a time', async ({ page }) => {
    const code = [
      'import machine, time',
      'print("boot")',
      'time.sleep(0.4)',
      'machine.reset()',
      'print("never printed")',
      '',
    ].join('\n');
    await openProject(page, makeProject({ code }));
    await page.click('#run-btn');
    await expect.poll(async () => ((await text(page)).match(/^boot$/gm) || []).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    const out = await text(page);
    expect(out).toContain('restarting firmware');
    expect(out).not.toContain('never printed');
    await page.click('#stop-btn');
  });

  test('a program that resets itself in a loop is stopped with an explanation', async ({ page }) => {
    await openProject(page, makeProject({ code: 'import machine\nmachine.reset()\n' }));
    await page.click('#run-btn');
    await expect.poll(() => text(page), { timeout: 60_000 }).toMatch(/keeps resetting itself/);
    await expect(page.locator('#run-btn')).toBeEnabled();
  });

  test('Stop during a long sleep ends the program immediately and a new Run works', async ({ page }) => {
    await openProject(page, makeProject({ code: 'import time\nprint("start")\ntime.sleep(30)\nprint("late")\n' }));
    await page.click('#run-btn');
    await expect.poll(() => text(page), { timeout: 20_000 }).toContain('start');
    await page.click('#stop-btn');
    await expect(page.locator('#run-btn')).toBeEnabled();
    await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
    await page.click('#run-btn');
    await expect.poll(() => text(page), { timeout: 20_000 }).toContain('start');
    expect(await text(page)).not.toContain('late');
    await page.click('#stop-btn');
  });

  test('an output pin with nothing wired warns but the program keeps running until it finishes', async ({ page }) => {
    // GP15 is driven but nothing is wired: the simulator warns (it used to stop the program).
    await openProject(page, makeProject({ code: 'from machine import Pin\nimport time\nled = Pin(15, Pin.OUT)\nled.on()\ntime.sleep(1.5)\nprint("finished")\n' }));
    await page.click('#run-btn');
    await expect.poll(() => text(page), { timeout: 20_000 }).toMatch(/GP15 is set as an output but nothing is wired to it\./);
    await expect.poll(() => text(page), { timeout: 20_000 }).toMatch(/finished/);
    await page.click('#stop-btn');
    await expect(page.locator('#run-btn')).toBeEnabled();
  });
});
