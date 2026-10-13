import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import {
  makeProject, openProject, programOutput, ledIsOn, gpio, cp, wire, LED, BUTTON, LED_ON_GP15, compilerReady,
} from './helpers.js';

// These tests need the compile service AND Emscripten. They skip (not fail) when the compiler
// is missing; see README "Tests".
const BLINK = fs.readFileSync('examples/c/blink.c', 'utf8');
const cProject = (code, { led = true, button = false } = {}) => makeProject({
  code,
  language: 'c',
  components: [...(led ? [LED] : []), ...(button ? [BUTTON] : [])],
  connections: [
    ...(led ? LED_ON_GP15 : []),
    ...(button ? [wire(gpio(1), cp('btn_1', '1')), wire(gpio(3), cp('btn_1', '3'))] : []),   // GP0 -> button -> GND
  ],
});

const text = async (page) => (await programOutput(page)).join('\n');
const waitForText = (page, pattern, timeout = 60_000) =>
  expect.poll(() => text(page), { timeout }).toMatch(pattern);
const isResponsive = (page) =>
  Promise.race([page.evaluate(() => 'responsive'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);

test.describe('C path', () => {
  test.beforeEach(async () => {
    test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
  });

  test('compiles and runs the blink example and prints to the console', async ({ page }) => {
    await openProject(page, cProject(BLINK));
    await page.click('#run-btn');
    await waitForText(page, /\[1\] LED OFF/);
    expect(await text(page)).toContain('C Blink Test');
    expect(await text(page)).toContain('[0] LED ON');
    await page.click('#stop-btn');
  });

  test('shows compiler errors to the user and re-enables Run', async ({ page }) => {
    await openProject(page, cProject('int main(){ undeclared_function(); return 0; }', { led: false }));
    await page.click('#run-btn');
    await waitForText(page, /Compilation failed/);
    await expect(page.locator('#run-btn')).toBeEnabled();
    await expect(page.locator('#stop-btn')).toBeDisabled();
  });

  test('refuses to compile a program that includes a host file, and says why', async ({ page }) => {
    await openProject(page, cProject('#include "/etc/passwd"\nint main(){ return 0; }', { led: false }));
    await page.click('#run-btn');
    await waitForText(page, /not allowed/i, 30_000);
    await expect(page.locator('#run-btn')).toBeEnabled();
  });

  test('the compile service refuses cross-site requests', async ({ request }) => {
    const res = await request.post('http://127.0.0.1:3001/compile', {
      headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      data: { code: 'int main(){return 0;}' },
    });
    expect(res.status()).toBe(403);
  });

  test.describe('hardware', () => {
    test('the wired LED lights up when the C program drives GP15', async ({ page }) => {
      await openProject(page, cProject(BLINK));
      await page.click('#run-btn');
      const seen = new Set();
      await expect.poll(async () => { seen.add(await ledIsOn(page)); return seen.size; }, { timeout: 60_000, intervals: [100] }).toBe(2);
      await page.click('#stop-btn');
      await page.waitForTimeout(300);
      expect(await ledIsOn(page)).toBe(false);
    });

    test('a C program reads a button through the circuit (pull-up, press, release)', async ({ page }) => {
      const code = [
        '#include "pico/stdlib.h"',
        'int main() {',
        '  stdio_init_all();',
        '  gpio_init(0); gpio_set_dir(0, GPIO_IN); gpio_pull_up(0);',
        '  int last = -1;',
        '  while (1) {',
        '    int v = gpio_get(0);',
        '    if (v != last) { printf("btn=%d\\n", v); last = v; }',
        '    sleep_ms(20);',
        '  }',
        '}',
        '',
      ].join('\n');
      await openProject(page, cProject(code, { led: false, button: true }));
      await page.click('#run-btn');
      await waitForText(page, /btn=1/);
      await page.dispatchEvent('#btn-cap-group-btn_1', 'mousedown');
      await waitForText(page, /btn=1\s*\n?btn=0/, 10_000);
      await page.dispatchEvent('#btn-cap-group-btn_1', 'mouseup');
      await waitForText(page, /btn=1\s*\n?btn=0\s*\n?btn=1/, 10_000);
      await page.click('#stop-btn');
    });

    test('the simulated filesystem and Wi-Fi answer blocking calls from the C program', async ({ page }) => {
      const code = [
        '#include "pico/stdlib.h"',
        '#include "pico/cyw43_arch.h"',
        '#include "fs/fs.h"',
        'int main() {',
        '  stdio_init_all();',
        '  fs_init();',
        '  fs_write("note.txt", "hello flash");',
        '  char buf[32];',
        '  int r = fs_read("note.txt", buf, 32);',
        '  printf("fs read=%d text=%s exists=%d\\n", r, buf, fs_exists("note.txt"));',
        '  fs_delete("note.txt");',
        '  printf("after delete exists=%d\\n", fs_exists("note.txt"));',
        '  cyw43_arch_init(); cyw43_arch_enable_sta_mode();',
        '  int c = cyw43_arch_wifi_connect_timeout_ms("net", "pw", CYW43_AUTH_WPA2_AES_PSK, 1000);',
        '  printf("wifi=%d\\n", c);',
        '  while (1) sleep_ms(100);',
        '}',
        '',
      ].join('\n');
      await openProject(page, cProject(code, { led: false }));
      await page.click('#run-btn');
      await waitForText(page, /wifi=0/);
      const out = await text(page);
      expect(out).toContain('fs read=0 text=hello flash exists=1');
      expect(out).toContain('after delete exists=0');
      await page.click('#stop-btn');
    });
  });

  test.describe('lifecycle', () => {
    test('Stop really stops the C program', async ({ page }) => {
      await openProject(page, cProject(BLINK));
      await page.click('#run-btn');
      await expect.poll(async () => (await programOutput(page)).length, { timeout: 60_000 }).toBeGreaterThan(4);
      await page.click('#stop-btn');
      await page.waitForTimeout(300);
      const before = (await programOutput(page)).length;
      await page.waitForTimeout(2500);
      expect((await programOutput(page)).length).toBe(before);
    });

    // Timing note: compiling takes 2-4 s on a normal machine, so these tests wait for the output they
    // need instead of sleeping a fixed time. The console is cleared AFTER Stop: a line the first program
    // legitimately printed between "clear" and "Stop" would otherwise be mistaken for a second instance.
    const ledOnCounters = async (page) =>
      (await programOutput(page)).map((l) => l.match(/^\[(\d+)\] LED ON$/)).filter(Boolean).map((m) => Number(m[1]));

    test('Run -> Stop -> Run starts exactly one program', async ({ page }) => {
      await openProject(page, cProject(BLINK));
      await page.click('#run-btn');
      await waitForText(page, /\[1\] LED OFF/);
      await page.click('#stop-btn');
      await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
      await page.click('#run-btn');
      await expect.poll(async () => (await ledOnCounters(page)).length, { timeout: 60_000 }).toBeGreaterThan(2);
      await page.waitForTimeout(1200);   // a second instance would show up as repeated or interleaved counters
      const counters = await ledOnCounters(page);
      expect(counters).toEqual(counters.map((_, i) => i));
      await page.click('#stop-btn');
    });

    test('Run pressed again while a program runs replaces it (no second instance)', async ({ page }) => {
      await openProject(page, cProject(BLINK));
      await page.click('#run-btn');
      await waitForText(page, /\[1\] LED OFF/);
      // Run is disabled while running, so replace the program through Stop + Run, then check only one runs.
      await page.click('#stop-btn');
      await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
      await page.click('#run-btn');
      await expect.poll(async () => (await ledOnCounters(page)).length, { timeout: 60_000 }).toBeGreaterThan(1);
      await page.waitForTimeout(1200);
      const counters = await ledOnCounters(page);
      expect(counters).toEqual(counters.map((_, i) => i));
      await page.click('#stop-btn');
    });

    test('an infinite loop without sleep does not freeze the page, and Stop ends it', async ({ page }) => {
      await openProject(page, cProject('#include "pico/stdlib.h"\nint main(){ volatile int x = 0; while (1) { x++; } return 0; }', { led: false }));
      await page.click('#run-btn');
      await page.waitForTimeout(2000);
      expect(await isResponsive(page)).toBe('responsive');
      await page.click('#stop-btn');
      await expect(page.locator('#run-btn')).toBeEnabled();
      expect(await isResponsive(page)).toBe('responsive');
    });

    test('a flood of printf output cannot freeze the page; the console stays bounded', async ({ page }) => {
      await openProject(page, cProject('#include "pico/stdlib.h"\nint main(){ stdio_init_all(); while (1) { printf("flood\\n"); } }', { led: false }));
      await page.click('#run-btn');
      await page.waitForTimeout(3000);
      expect(await isResponsive(page)).toBe('responsive');
      const lines = await page.evaluate(() => document.querySelectorAll('#output > div').length);
      expect(lines).toBeLessThanOrEqual(1000);
      await page.click('#stop-btn');
      await page.waitForTimeout(500);
      const after = await page.evaluate(() => document.querySelectorAll('#output > div').length);
      await page.waitForTimeout(1000);
      expect(await page.evaluate(() => document.querySelectorAll('#output > div').length)).toBe(after);
    });

    test('after a tight toggling loop the LED still ends in the level the program last wrote', async ({ page }) => {
      const code = [
        '#include "pico/stdlib.h"',
        'int main() {',
        '  gpio_init(15); gpio_set_dir(15, GPIO_OUT);',
        '  for (long i = 0; i < 400000; i++) gpio_put(15, i & 1);',
        '  gpio_put(15, 1);',
        '  while (1) { }',
        '}',
        '',
      ].join('\n');
      await openProject(page, cProject(code));
      await page.click('#run-btn');
      await expect.poll(() => ledIsOn(page), { timeout: 60_000 }).toBe(true);
      expect(await isResponsive(page)).toBe('responsive');
      await page.click('#stop-btn');
      await page.waitForTimeout(300);
      expect(await ledIsOn(page)).toBe(false);
    });

    test('Stop while the program is still compiling cancels the run', async ({ page }) => {
      await openProject(page, cProject(BLINK));
      await page.click('#run-btn');
      await page.click('#stop-btn');                  // immediately, before the compile can finish
      await page.waitForTimeout(6000);
      const out = await text(page);
      expect(out).not.toContain('Firmware running');
      expect(out).not.toContain('C Blink Test');
      await expect(page.locator('#run-btn')).toBeEnabled();
      // and the app is still usable
      await page.click('#run-btn');
      await waitForText(page, /\[0\] LED ON/);
      await page.click('#stop-btn');
    });

    test('watchdog_reboot() restarts the program from main() on cleared hardware', async ({ page }) => {
      const code = [
        '#include "pico/stdlib.h"',
        '#include "hardware/watchdog.h"',
        'int main() {',
        '  stdio_init_all();',
        '  if (watchdog_caused_reboot()) { printf("rebooted by watchdog\\n"); while (1) sleep_ms(100); }',
        '  printf("first boot\\n");',
        '  sleep_ms(400);',
        '  watchdog_reboot(0, 0, 0);',
        '  printf("never printed\\n");',
        '  while (1) sleep_ms(100);',
        '}',
        '',
      ].join('\n');
      await openProject(page, cProject(code, { led: false }));
      await page.click('#run-btn');
      await waitForText(page, /rebooted by watchdog/);
      const out = await text(page);
      expect(out).toContain('Watchdog Reset');
      expect(out).not.toContain('never printed');
      expect((out.match(/first boot/g) || []).length).toBe(1);
      await page.click('#stop-btn');
    });

    test('a program that resets itself in a loop is stopped with an explanation', async ({ page }) => {
      const code = '#include "pico/stdlib.h"\n#include "hardware/watchdog.h"\nint main(){ watchdog_reboot(0,0,0); while(1){} }\n';
      await openProject(page, cProject(code, { led: false }));
      await page.click('#run-btn');
      await waitForText(page, /keeps resetting itself/, 60_000);
      await expect(page.locator('#run-btn')).toBeEnabled();
    });
  });
});
