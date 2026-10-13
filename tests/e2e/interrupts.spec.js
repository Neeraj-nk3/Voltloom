import { test, expect } from '@playwright/test';
import { makeProject, openProject, programOutput, gpio, cp, wire, LED, BUTTON, compilerReady, watchLines, timed } from './helpers.js';
import { C_HEAD } from '../support/c-programs.js';

// R4 in the real browser: GPIO interrupts react to a button press while the program is asleep (in real time),
// the watchdog restarts the program, the reset cause survives the restart but not a Stop, and machine.PWM works.

const BUTTON_ON_GP0 = [wire(gpio(1), cp('btn_1', '1')), wire(gpio(3), cp('btn_1', '3'))];   // GP0 -> button -> GND

const text = async (page) => (await programOutput(page)).join('\n');
const waitFor = (page, regex, timeout = 60_000) => expect.poll(() => text(page), { timeout }).toMatch(regex);
const press = (page) => page.dispatchEvent('#btn-cap-group-btn_1', 'mousedown');
const release = (page) => page.dispatchEvent('#btn-cap-group-btn_1', 'mouseup');

const PY_IRQ = ['from machine import Pin', 'import time', 'btn = Pin(0, Pin.IN, Pin.PULL_UP)', 'n = [0]',
  'def handler(pin):', '    n[0] += 1', '    print("irq", n[0])',
  'btn.irq(trigger=Pin.IRQ_FALLING, handler=handler)', 'print("ready")',
  'while True:', '    time.sleep(5)', ''].join('\n');
const C_IRQ = C_HEAD + [
  'static volatile int n = 0;', 'void handler(uint gpio, uint32_t events) { n++; printf("irq %d\\n", n); }',
  'int main() { stdio_init_all(); gpio_init(0); gpio_set_dir(0, GPIO_IN); gpio_pull_up(0);',
  '  gpio_set_irq_enabled_with_callback(0, GPIO_IRQ_EDGE_FALL, true, &handler); printf("ready\\n");',
  '  while (1) sleep_ms(5000); }', ''].join('\n');

test.describe('GPIO interrupts react to the button while the program sleeps (real time)', () => {
  for (const language of ['python', 'c']) {
    test(`${language}: pressing the button runs the handler within a fraction of a second, although the program sleeps for 5 s`, async ({ page }) => {
      if (language === 'c') test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
      await openProject(page, makeProject({ code: language === 'c' ? C_IRQ : PY_IRQ, language, components: [BUTTON], connections: BUTTON_ON_GP0 }));
      await watchLines(page);
      await page.click('#run-btn');
      await waitFor(page, /\bready\b/);
      await page.waitForTimeout(400);                       // the program is now inside its 5 s sleep

      for (let i = 1; i <= 3; i++) {
        const before = await page.evaluate(() => performance.now());
        await press(page);
        await waitFor(page, new RegExp(`irq ${i}\\b`), 5000);
        const line = (await timed(page)).find((l) => l.text === `irq ${i}`);
        expect(line.t - before, `${language} press ${i}`).toBeLessThan(600);        // not "after the sleep ends"
        await release(page);                                 // the rising edge is not subscribed: no extra irq
        await page.waitForTimeout(250);
      }
      expect(((await text(page)).match(/\birq \d\b/g) || []).length).toBe(3);
      await page.click('#stop-btn');
    });
  }

  test('after Stop the handler is gone: a press does nothing, and a new Run starts with no interrupts armed', async ({ page }) => {
    await openProject(page, makeProject({ code: PY_IRQ, components: [BUTTON], connections: BUTTON_ON_GP0 }));
    await page.click('#run-btn');
    await waitFor(page, /\bready\b/);
    await page.click('#stop-btn');
    await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
    await press(page); await page.waitForTimeout(500); await release(page);
    expect(await text(page)).not.toMatch(/irq/);
    await page.click('#run-btn');
    await waitFor(page, /\bready\b/);
    await page.waitForTimeout(300);
    expect(await text(page)).not.toMatch(/irq/);           // the press from before the run did not leak into it
    await press(page);
    await waitFor(page, /irq 1\b/, 5000);
    await page.click('#stop-btn');
  });
});

test.describe('watchdog and reset cause', () => {
  const PY_WDT = ['import machine, time', 'print("cause", machine.reset_cause())', 'w = machine.WDT(timeout=700)',
    'time.sleep(0.3)', 'w.feed()', 'time.sleep(0.3)', 'w.feed()', 'print("stalling")', 'time.sleep(10)', ''].join('\n');
  const C_WDT = C_HEAD + [
    'int main() { stdio_init_all(); printf("cause %d\\n", (int)watchdog_caused_reboot()); watchdog_enable(700, false);',
    '  sleep_ms(300); watchdog_update(); sleep_ms(300); watchdog_update(); printf("stalling\\n"); sleep_ms(10000); return 0; }', ''].join('\n');

  for (const [language, code, powerOn, afterWatchdog] of [['python', PY_WDT, 1, 3], ['c', C_WDT, 0, 1]]) {
    test(`${language}: not feeding the watchdog restarts the program, the new run knows why, and a Stop + Run starts from power-on again`, async ({ page }) => {
      if (language === 'c') test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
      await openProject(page, makeProject({ code, language }));
      await page.click('#run-btn');
      await waitFor(page, new RegExp(`cause ${afterWatchdog}\\b`), 90_000);
      const lines = (await programOutput(page)).filter((l) => /^(cause \d|stalling)$/.test(l));
      expect(lines.slice(0, 3)).toEqual([`cause ${powerOn}`, 'stalling', `cause ${afterWatchdog}`]);
      expect(await text(page)).toMatch(/Watchdog Reset/);
      await page.click('#stop-btn');
      await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
      await page.click('#run-btn');
      await waitFor(page, /cause \d/, 90_000);
      expect((await programOutput(page)).filter((l) => /^cause \d$/.test(l))[0]).toBe(`cause ${powerOn}`);   // not the cause of the earlier run
      await page.click('#stop-btn');
    });
  }

  test('a program that keeps feeding the watchdog keeps running', async ({ page }) => {
    const code = ['import machine, time', 'w = machine.WDT(timeout=600)', 'n = 0', 'while True:', '    time.sleep(0.25)', '    w.feed()', '    n += 1', '    if n % 4 == 0:', '        print("alive", n)', ''].join('\n');
    await openProject(page, makeProject({ code }));
    await page.click('#run-btn');
    await waitFor(page, /alive 12\b/, 30_000);
    expect(await text(page)).not.toMatch(/Watchdog Reset|restarting firmware/i);
    await page.click('#stop-btn');
  });
});

test.describe('machine.PWM and frequency', () => {
  test('Python machine.PWM: frequency and duty read back, a bad frequency is a ValueError, and the LED brightness follows the duty', async ({ page }) => {
    const code = ['from machine import Pin, PWM', 'import time', 'pwm = PWM(Pin(15), freq=1000, duty_u16=16384)',
      'print("freq", pwm.freq(), "duty", pwm.duty_u16())', 'time.sleep(1.5)', 'pwm.duty_u16(65535)', 'print("full")', 'time.sleep(1.5)',
      'try:', '    pwm.freq(1000000000)', 'except ValueError as e:', '    print("error", e)', 'time.sleep(5)', ''].join('\n');
    const led = { ...LED };
    const res = { id: 'res_1', type: 'resistor', x: 50, y: 300, rotation: 0, value: 330, unit: 1 };
    await openProject(page, makeProject({ code, components: [led, res],
      connections: [wire(gpio(20), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))] }));
    const brightness = () => page.evaluate(() => { const s = document.querySelector('#led_1 svg'); return s.style.filter ? Number(s.style.opacity) : 0; });
    await page.click('#run-btn');
    await waitFor(page, /freq 1000 duty 16384\b/);
    await expect.poll(brightness).toBeGreaterThan(0);
    const quarter = await brightness();
    await waitFor(page, /\bfull\b/);
    await expect.poll(brightness).toBeGreaterThan(quarter);        // 100 % duty is brighter than 25 %
    await waitFor(page, /error freq too large/);
    await page.click('#stop-btn');
  });
});
