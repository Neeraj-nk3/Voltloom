import { test, expect } from '@playwright/test';
import {
  makeProject, openProject, programOutput, ledIsOn, gpio, cp, wire, LED, BUTTON, LED_ON_GP15,
} from './helpers.js';

const BLINK = 'from machine import Pin\nimport time\nled = Pin(15, Pin.OUT)\nwhile True:\n    led.toggle()\n    time.sleep(0.3)\n';

test.describe('Python path', () => {
  test('blink drives the wired LED on and off, Stop turns it off', async ({ page }) => {
    await openProject(page, makeProject({ code: BLINK, components: [LED], connections: LED_ON_GP15 }));
    await page.click('#run-btn');
    const seen = new Set();
    for (let i = 0; i < 30; i++) { seen.add(await ledIsOn(page)); await page.waitForTimeout(100); }
    expect([...seen].sort()).toEqual([false, true]);
    await page.click('#stop-btn');
    await page.waitForTimeout(300);
    expect(await ledIsOn(page)).toBe(false);
    expect((await programOutput(page)).join('\n')).toContain('Simulation Stopped');
  });

  test('Run -> Stop -> Run produces a single output stream', async ({ page }) => {
    const code = 'import time\ni = 0\nwhile True:\n    print("T", i)\n    i += 1\n    time.sleep(0.2)\n';
    await openProject(page, makeProject({ code }));
    await page.click('#run-btn'); await page.waitForTimeout(1200);
    await page.click('#stop-btn'); await page.waitForTimeout(300);
    await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
    await page.click('#run-btn'); await page.waitForTimeout(1500);
    const nums = (await programOutput(page)).filter((l) => /^T \d+$/.test(l)).map((l) => Number(l.slice(2)));
    expect(nums.length).toBeGreaterThan(3);
    expect(nums).toEqual(nums.map((_, i) => i)); // 0,1,2,... with no duplicates or interleaving
  });

  test('a syntax error is reported to the user', async ({ page }) => {
    await openProject(page, makeProject({ code: 'print("a")\nprint("b"\nprint("c")\n' }));
    await page.click('#run-btn'); await page.waitForTimeout(3000);
    expect((await programOutput(page)).join('\n')).toMatch(/SyntaxError/i);
  });

  test('a runtime exception is reported with the message and the right line', async ({ page }) => {
    await openProject(page, makeProject({ code: 'print("a")\nraise ValueError("boom")\n' }));
    await page.click('#run-btn'); await page.waitForTimeout(3000);
    const text = (await programOutput(page)).join('\n');
    expect(text).toContain('boom');
    expect(text).toMatch(/line 2\b/);
  });

  test('a statement spanning several lines runs normally', async ({ page }) => {
    await openProject(page, makeProject({ code: 'x = [1,\n     2,\n     3]\nprint(sum(x))\nprint("done")\n' }));
    await page.click('#run-btn'); await page.waitForTimeout(3000);
    const out = await programOutput(page);
    expect(out).toContain('6');
    expect(out).toContain('done');
  });

  async function watchButton(page, pull, otherSidePin) {
    const code = [
      'from machine import Pin', 'import time', `b = Pin(0, Pin.IN, Pin.${pull})`, 'last = -1',
      'for i in range(60):', '    v = b.value()', '    if v != last:', '        print("v", v)', '        last = v',
      '    time.sleep(0.05)', '',
    ].join('\n');
    await openProject(page, makeProject({
      code, components: [BUTTON],
      connections: [wire(gpio(1), cp('btn_1', '1')), wire(gpio(otherSidePin), cp('btn_1', '3'))],
    }));
    await page.click('#run-btn'); await page.waitForTimeout(900);
    await page.dispatchEvent('#btn-cap-group-btn_1', 'mousedown'); await page.waitForTimeout(900);
    await page.dispatchEvent('#btn-cap-group-btn_1', 'mouseup'); await page.waitForTimeout(900);
    return (await programOutput(page)).filter((l) => /^v \d$/.test(l));
  }

  test('Pin accepts pull= and value= as keyword arguments, plus high()/low()', async ({ page }) => {
    const code = [
      'from machine import Pin',
      'a = Pin(0, Pin.IN, pull=Pin.PULL_UP)',   // nothing wired to GP0: the pull resistor decides
      'print("kw_pull_up", a.value())',
      'b = Pin(1, Pin.IN, Pin.PULL_UP)',
      'print("pos_pull_up", b.value())',
      'led = Pin(15, mode=Pin.OUT, value=1)',
      'print("initial", led.value())',
      'led.low()',
      'print("after_low", led.value())',
      'led.high()',
      'print("after_high", led.value())',
      '',
    ].join('\n');
    await openProject(page, makeProject({ code, components: [LED, BUTTON], connections: [
      ...LED_ON_GP15,
      wire(gpio(1), cp('btn_1', '1')), wire(gpio(3), cp('btn_1', '3')),   // GP0 -> button -> GND (released: floating)
      // GP1 is left unwired: it used to share GP0's net only to avoid the old "no button connected" stop. On one net the
      // two pads' pulls would now fight (GP1 still has its reset pull-down when GP0 is read), as on a real board.
    ] }));
    await page.click('#run-btn'); await page.waitForTimeout(3000);
    const out = (await programOutput(page)).join('\n');
    expect(out).toContain('kw_pull_up 1');
    expect(out).toContain('pos_pull_up 1');
    expect(out).toContain('initial 1');
    expect(out).toContain('after_low 0');
    expect(out).toContain('after_high 1');
  });

  test('button to GND with pull-up reads 1, 0, 1', async ({ page }) => {
    expect(await watchButton(page, 'PULL_UP', 3)).toEqual(['v 1', 'v 0', 'v 1']);
  });

  test('button to 3V3 with pull-down reads 0, 1, 0', async ({ page }) => {
    expect(await watchButton(page, 'PULL_DOWN', 36)).toEqual(['v 0', 'v 1', 'v 0']);
  });
});
