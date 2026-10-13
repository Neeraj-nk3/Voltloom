import { test, expect } from '@playwright/test';
import { makeProject, shareUrl, programOutput, gpio, cp, wire, BUTTON, compilerReady } from './helpers.js';

// R5 — what happens when the app is hosted WITHOUT the cross-origin-isolation headers (e.g. a plain static host).
// The dev server sends the headers, so these tests strip them from the page's own response to reproduce such a host.
// See docs/deployment.md for the evidence this encodes.

async function stripIsolationHeaders(page) {
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers['cross-origin-opener-policy'];
    delete headers['cross-origin-embedder-policy'];
    await route.fulfill({ response, headers });
  });
}
async function open(page, project) {
  await page.goto(shareUrl(project), { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
  await page.waitForTimeout(300);
}
const lines = async (page) => (await programOutput(page)).join('\n');

const POLL_BUTTON = ['from machine import Pin', 'import time', 'b = Pin(0, Pin.IN, Pin.PULL_UP)', 'last = -1',
  'for i in range(30):', '    v = b.value()', '    if v != last:', '        print("button", v)', '        last = v', '    time.sleep(0.1)', 'print("done")', ''].join('\n');
const WITH_BUTTON = { components: [BUTTON], connections: [wire(gpio(1), cp('btn_1', '1')), wire(gpio(3), cp('btn_1', '3'))] };

test.describe('hosted with the isolation headers (as the dev and preview servers do)', () => {
  test('the page is cross-origin isolated and shows no "Limited mode" badge', async ({ page }) => {
    await open(page, makeProject({ code: '#' }));
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    await expect(page.locator('#isolation-status')).toBeHidden();
  });
});

test.describe('hosted WITHOUT the headers (limited mode)', () => {
  test.beforeEach(async ({ page }) => { await stripIsolationHeaders(page); });

  test('the page says so: a "Limited mode" badge whose tooltip names what is missing and where to read more', async ({ page }) => {
    await open(page, makeProject({ code: '#' }));
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(false);
    const badge = page.locator('#isolation-status');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('title', /C programs cannot run.*button presses, interrupts and the debugger.*docs\/deployment\.md/);
  });

  test('Python still runs (sleep, print, timing), and the run says it is in limited mode', async ({ page }) => {
    await open(page, makeProject({ code: 'import time\nprint("a")\ntime.sleep(0.3)\nprint("b", time.ticks_ms())\n' }));
    await page.click('#run-btn');
    await expect.poll(() => lines(page), { timeout: 15_000 }).toMatch(/b 30\d/);
    expect(await lines(page)).toMatch(/Limited mode: this page is not cross-origin isolated/);
  });

  test('LIMITATION (documented): a button pressed while a Python program runs is not seen, which is why the page warns', async ({ page }) => {
    await open(page, makeProject({ code: POLL_BUTTON, ...WITH_BUTTON }));
    await page.click('#run-btn');
    await page.waitForTimeout(800);
    await page.dispatchEvent('#btn-cap-group-btn_1', 'mousedown');
    await page.waitForTimeout(1000);
    await page.dispatchEvent('#btn-cap-group-btn_1', 'mouseup');
    await expect.poll(() => lines(page), { timeout: 15_000 }).toMatch(/\bdone\b/);
    const seen = (await programOutput(page)).filter((l) => /^button/.test(l));
    expect(seen).toEqual(['button 1']);                    // the press (0) never arrived; with isolation it reads 1, 0, 1
  });

  test('C is refused with a message that points at the fix', async ({ page }) => {
    test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
    await open(page, makeProject({ code: '#include "pico/stdlib.h"\nint main() { while (1) sleep_ms(100); }\n', language: 'c' }));
    await page.click('#run-btn');
    await expect.poll(() => lines(page), { timeout: 60_000 }).toMatch(/C programs need a cross-origin-isolated page.*docs\/deployment\.md/);
    await expect(page.locator('#run-btn')).toBeEnabled();
  });
});
