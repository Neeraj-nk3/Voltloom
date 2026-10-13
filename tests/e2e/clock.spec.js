import { test, expect } from '@playwright/test';
import { makeProject, openProject, programOutput, compilerReady, watchLines, timed } from './helpers.js';
import { C_HEAD } from '../support/c-programs.js';

// R3e — the virtual clock in the real browser. Real-time mode must behave like real time (the default),
// fast mode must run the same timeline instantly and repeatably, and Stop must end any program however it waits.

const python = (code) => makeProject({ code });
const c = (code) => makeProject({ code, language: 'c' });

const wallBetween = (lines, from, to) => lines.find((l) => l.text === to).t - lines.find((l) => l.text === from).t;
const programLines = async (page) => (await programOutput(page)).filter((l) => /^[a-z0-9_]+( -?\d+)?$/i.test(l));
const waitFor = (page, regex, timeout = 60_000) => expect.poll(async () => (await programOutput(page)).join('\n'), { timeout }).toMatch(regex);

test.describe('real-time mode (the default)', () => {
  test('Python: sleep(1) takes about one real second, and time.ticks_ms() says exactly that', async ({ page }) => {
    await openProject(page, python([
      'import time', 'print("a")', 't0 = time.ticks_ms()', 'time.sleep(1)', 'print("b")',
      'print("elapsed", time.ticks_diff(time.ticks_ms(), t0))', 'time.sleep_ms(500)', 'print("c")', 'time.sleep(5)', '',
    ].join('\n')));
    await watchLines(page);
    await page.click('#run-btn');
    await waitFor(page, /\bc\b/);
    const lines = await timed(page);
    expect(wallBetween(lines, 'a', 'b')).toBeGreaterThan(900);
    expect(wallBetween(lines, 'a', 'b')).toBeLessThan(1500);
    expect(wallBetween(lines, 'b', 'c')).toBeGreaterThan(400);
    expect(wallBetween(lines, 'b', 'c')).toBeLessThan(900);
    const elapsed = Number((await programOutput(page)).find((l) => l.startsWith('elapsed')).split(' ')[1]);
    expect(elapsed).toBeGreaterThanOrEqual(1000); expect(elapsed).toBeLessThanOrEqual(1003);   // virtual time is exact (+ read costs)
    await page.click('#stop-btn');
  });

  test('C: sleep_ms(1000) takes about one real second, and time_us_64() says exactly that', async ({ page }) => {
    test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
    await openProject(page, c(C_HEAD + [
      'int main() { stdio_init_all();', '  printf("a\\n"); uint64_t t0 = time_us_64(); sleep_ms(1000); printf("b\\n");',
      '  printf("elapsed %d\\n", (int)((time_us_64() - t0) / 1000)); sleep_ms(500); printf("c\\n"); while (1) sleep_ms(100); }', '',
    ].join('\n')));
    await watchLines(page);
    await page.click('#run-btn');
    await waitFor(page, /\bc\b/);
    const lines = await timed(page);
    expect(wallBetween(lines, 'a', 'b')).toBeGreaterThan(900);
    expect(wallBetween(lines, 'a', 'b')).toBeLessThan(1500);
    const elapsed = Number((await programOutput(page)).find((l) => l.startsWith('elapsed')).split(' ')[1]);
    expect(elapsed).toBeGreaterThanOrEqual(1000); expect(elapsed).toBeLessThanOrEqual(1002);
    await page.click('#stop-btn');
  });

  test('output printed just before a long sleep is delivered at once, not after the sleep (events are flushed before blocking)', async ({ page }) => {
    test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
    for (const [language, code] of [
      ['python', 'import time\nfor i in range(40):\n    print("n", i)\nprint("sleeping")\ntime.sleep(8)\n'],
      ['c', C_HEAD + 'int main() { stdio_init_all(); for (int i = 0; i < 40; i++) printf("n %d\\n", i); printf("sleeping\\n"); sleep_ms(8000); while (1) sleep_ms(100); }\n'],
    ]) {
      await openProject(page, makeProject({ code, language }));
      await page.click('#run-btn');
      await waitFor(page, /sleeping/, 20_000);          // well before the 8 s sleep ends
      expect((await programOutput(page)).filter((l) => /^n \d+$/.test(l)).length, language).toBe(40);
      await page.click('#stop-btn');
    }
  });

  test('a C blink keeps a steady 500 ms period (no drift) over several cycles', async ({ page }) => {
    test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
    await openProject(page, c(C_HEAD + 'int main() { stdio_init_all(); while (1) { printf("tick\\n"); sleep_ms(500); } }\n'));
    await watchLines(page);
    await page.click('#run-btn');
    await expect.poll(async () => (await timed(page)).filter((l) => l.text === 'tick').length, { timeout: 60_000 }).toBeGreaterThanOrEqual(6);
    const ticks = (await timed(page)).filter((l) => l.text === 'tick').map((l) => l.t);
    const span = ticks[5] - ticks[0];                   // five periods
    expect(span).toBeGreaterThan(2400); expect(span).toBeLessThan(2900);
    await page.click('#stop-btn');
  });
});

test.describe('Stop ends any program, however it waits', () => {
  test('Stop during a very long sleep (Python and C): the run button comes back quickly and nothing more is printed', async ({ page }) => {
    test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
    for (const [language, code] of [
      ['python', 'import time\nprint("start")\ntime.sleep(3600)\nprint("late")\n'],
      ['c', C_HEAD + 'int main() { stdio_init_all(); printf("start\\n"); sleep_ms(3600000); printf("late\\n"); while (1) sleep_ms(100); }\n'],
    ]) {
      await openProject(page, makeProject({ code, language }));
      await page.click('#run-btn');
      await waitFor(page, /start/, 60_000);
      const t = Date.now();
      await page.click('#stop-btn');
      await expect(page.locator('#run-btn')).toBeEnabled();
      expect(Date.now() - t, language).toBeLessThan(2000);
      await page.waitForTimeout(500);
      expect((await programOutput(page)).join('\n'), language).not.toContain('late');
    }
  });

  test('busy-waiting on the clock (no sleep at all) neither freezes the page nor survives Stop', async ({ page }) => {
    test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
    for (const [language, code] of [
      ['python', 'import time\nprint("spin")\nwhile True:\n    time.ticks_ms()\n'],
      ['c', C_HEAD + 'int main() { stdio_init_all(); printf("spin\\n"); while (1) { (void)time_us_64(); } }\n'],
    ]) {
      await openProject(page, makeProject({ code, language }));
      await page.click('#run-btn');
      await waitFor(page, /spin/, 60_000);
      await page.waitForTimeout(1000);
      const responsive = await Promise.race([page.evaluate(() => 'responsive'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
      expect(responsive, language).toBe('responsive');
      await page.click('#stop-btn');
      await expect(page.locator('#run-btn')).toBeEnabled();
    }
  });

  test('a busy-wait of 300 ms on the virtual clock lasts about 300 ms of real time', async ({ page }) => {
    test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
    for (const [language, code] of [
      ['python', 'import time\nprint("a")\nt0 = time.ticks_ms()\nwhile time.ticks_diff(time.ticks_ms(), t0) < 300:\n    pass\nprint("b")\ntime.sleep(5)\n'],
      ['c', C_HEAD + 'int main() { stdio_init_all(); printf("a\\n"); uint64_t t0 = time_us_64(); while (time_us_64() - t0 < 300000) {} printf("b\\n"); while (1) sleep_ms(100); }\n'],
    ]) {
      await openProject(page, makeProject({ code, language }));
      await watchLines(page);
      await page.click('#run-btn');
      await waitFor(page, /\bb\b/, 60_000);
      const w = wallBetween(await timed(page), 'a', 'b');
      expect(w, language).toBeGreaterThan(250); expect(w, language).toBeLessThan(900);
      await page.click('#stop-btn');
    }
  });

  test('after a reset the program starts again at virtual time ~0', async ({ page }) => {
    test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
    for (const [language, code] of [
      ['python', 'import time, machine\nprint("t", time.ticks_ms())\ntime.sleep(0.6)\nmachine.reset()\n'],
      ['c', C_HEAD + '#include "hardware/watchdog.h"\nint main() { stdio_init_all(); printf("t %d\\n", (int)(time_us_64() / 1000)); sleep_ms(600); watchdog_reboot(0, 0, 0); while (1) sleep_ms(100); }\n'],
    ]) {
      await openProject(page, makeProject({ code, language }));
      await page.click('#run-btn');
      await expect.poll(async () => (await programLines(page)).filter((l) => l.startsWith('t ')).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
      const starts = (await programLines(page)).filter((l) => l.startsWith('t ')).map((l) => Number(l.split(' ')[1]));
      expect(starts[0], language).toBeLessThan(5); expect(starts[1], language).toBeLessThan(5);   // the second run did not inherit the first run's time
      await page.click('#stop-btn');
    }
  });
});

test.describe('fast mode (tests and scenarios)', () => {
  const FAST_PY = ['import time', 'for i in range(5):', '    print("t", time.ticks_ms())', '    time.sleep(10)', 'print("end", time.ticks_ms())', 'time.sleep(1)', ''].join('\n');
  const FAST_C = C_HEAD + 'int main() { stdio_init_all(); for (int i = 0; i < 5; i++) { printf("t %d\\n", (int)(time_us_64() / 1000)); sleep_ms(10000); } printf("end %d\\n", (int)(time_us_64() / 1000)); while (1) sleep_ms(100); }\n';

  async function runFast(page, language, code) {
    await openProject(page, makeProject({ code, language }));
    await page.evaluate(() => { window.__voltloom.bridge.clockMode = 'fast'; });
    const started = Date.now();
    await page.click('#run-btn');
    await waitFor(page, /\bend\b/, 60_000);
    const took = Date.now() - started;
    const lines = (await programOutput(page)).filter((l) => /^(t|end) \d+$/.test(l));
    await page.click('#stop-btn');
    return { lines, took };
  }

  test('50 virtual seconds run in a moment, with the exact timeline, identically on every run, in Python and C', async ({ page }) => {
    test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
    const expected = ['t 0', 't 10000', 't 20000', 't 30000', 't 40000', 'end 50000'];
    const normalise = (lines) => lines.map((l) => l.replace(/\d+$/, (n) => String(Math.round(Number(n) / 10) * 10)));   // ignore the few us of read cost
    const results = {};
    for (const [language, code] of [['python', FAST_PY], ['c', FAST_C]]) {
      results[language] = [];
      for (let run = 0; run < 3; run++) {
        const { lines, took } = await runFast(page, language, code);
        expect(took, `${language} run ${run}`).toBeLessThan(language === 'c' ? 20_000 : 8_000);   // C includes compiling
        results[language].push(lines);
      }
      for (const lines of results[language]) expect(normalise(lines)).toEqual(expected);
      expect(results[language][1]).toEqual(results[language][0]);       // byte-identical, not just close
      expect(results[language][2]).toEqual(results[language][0]);
    }
  });
});
