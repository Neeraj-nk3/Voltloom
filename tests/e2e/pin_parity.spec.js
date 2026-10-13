import { test, expect } from '@playwright/test';
import { makeProject, openProject, programOutput, gpio, cp, wire, compilerReady, press } from './helpers.js';
import { C_HEAD } from '../support/c-programs.js';

// R3d — Python / C parity for the pin model that now lives inside both firmware workers.
// Each scenario is written once per language, run against the same circuit, and BOTH outputs must equal
// the same expected list. Physical pins: GP0=1, GP14=19, GP15=20, GND.1=3, 3V3(OUT)=36.
// (Python has no machine.PWM yet, so the PWM scenario runs in C only.)

const res = (id, value, unit = 1) => ({ id, type: 'resistor', x: 50, y: 300, rotation: 0, value, unit });
const BUTTON = { id: 'btn_1', type: 'button', x: 100, y: 600, rotation: 0 };

/** The program's own output lines (console lines minus the [System] chatter and warnings). */
async function lines(page) {
  return (await programOutput(page)).filter((l) => /^[a-z0-9_]+ -?\d+$/i.test(l) || l === 'done');
}
async function waitForLines(page, count, timeout = 60_000) {
  await expect.poll(async () => (await lines(page)).length, { timeout }).toBeGreaterThanOrEqual(count);
}

const python = (code, components = [], connections = []) => makeProject({ code, components, connections });
const c = (code, components = [], connections = []) => makeProject({ code, language: 'c', components, connections });


// ---- scenarios: [name, pythonCode, cCode, components, connections, expected lines] ----------------------

const PULLS = {
  py: [
    'from machine import Pin', 'import time',
    'def show(tag, p): print(tag, p.value())',
    'show("reset", Pin(3, Pin.IN))',
    'show("up", Pin(3, Pin.IN, Pin.PULL_UP))',
    'show("none_after_up", Pin(3, Pin.IN, None))',
    'show("down", Pin(3, Pin.IN, Pin.PULL_DOWN))',
    'show("none_after_down", Pin(3, Pin.IN, None))',
    'Pin(3, Pin.IN, Pin.PULL_UP)', 'show("keeps_up", Pin(3, Pin.IN))',
    'print("done")', 'time.sleep(2)', '',
  ].join('\n'),
  c: C_HEAD + [
    'int main() { stdio_init_all();',
    '  gpio_init(3); gpio_set_dir(3, GPIO_IN);',
    '  printf("reset %d\\n", gpio_get(3));',
    '  gpio_pull_up(3); printf("up %d\\n", gpio_get(3));',
    '  gpio_disable_pulls(3); printf("none_after_up %d\\n", gpio_get(3));',
    '  gpio_pull_down(3); printf("down %d\\n", gpio_get(3));',
    '  gpio_disable_pulls(3); printf("none_after_down %d\\n", gpio_get(3));',
    '  gpio_pull_up(3); gpio_init(3); printf("keeps_up %d\\n", gpio_get(3));',
    '  printf("done\\n"); while (1) sleep_ms(100); }', '',
  ].join('\n'),
  expected: ['reset 0', 'up 1', 'none_after_up 1', 'down 0', 'none_after_down 0', 'keeps_up 1', 'done'],
};

const WATCH = (setup, cSetup) => ({
  py: ['from machine import Pin', 'import time', setup, 'last = -1', 'while True:', '    v = p.value()', '    if v != last:', '        print("v", v)', '        last = v', '    time.sleep(0.05)', ''].join('\n'),
  c: C_HEAD + ['int main() { stdio_init_all();', cSetup, '  int last = -1;', '  while (1) { int v = gpio_get(0); if (v != last) { printf("v %d\\n", v); last = v; } sleep_ms(50); } }', ''].join('\n'),
});

const LOOPBACK = {
  py: [
    'from machine import Pin', 'import time',
    'o = Pin(14, Pin.OUT)', 'i = Pin(15, Pin.IN)',
    'print("init", i.value())',
    'o.high(); time.sleep(0.05); print("r", i.value())',
    'o.low(); time.sleep(0.05); print("r", i.value())',
    'o.high(); time.sleep(0.05); print("r", i.value())',
    'print("done")', 'time.sleep(3)', '',
  ].join('\n'),
  c: C_HEAD + [
    'int main() { stdio_init_all();',
    '  gpio_init(14); gpio_set_dir(14, GPIO_OUT); gpio_init(15); gpio_set_dir(15, GPIO_IN);',
    '  printf("init %d\\n", gpio_get(15));',
    '  gpio_put(14, 1); sleep_ms(50); printf("r %d\\n", gpio_get(15));',
    '  gpio_put(14, 0); sleep_ms(50); printf("r %d\\n", gpio_get(15));',
    '  gpio_put(14, 1); sleep_ms(50); printf("r %d\\n", gpio_get(15));',
    '  printf("done\\n"); while (1) sleep_ms(100); }', '',
  ].join('\n'),
  wires: [wire(gpio(19), gpio(20))],
  expected: ['init 0', 'r 1', 'r 0', 'r 1', 'done'],
};

test.describe('Python / C parity: the pin model inside the workers', () => {
  test.beforeEach(async () => {
    test.skip(!(await compilerReady()), 'compile service or Emscripten not available');
  });

  async function runBoth(page, scenario, { components = [], connections = [], waitFor }) {
    const results = {};
    for (const [language, build] of [['python', python], ['c', c]]) {
      await openProject(page, build(language === 'python' ? scenario.py : scenario.c, components, connections));
      await page.click('#run-btn');
      await waitFor(page, language);
      results[language] = await lines(page);
      await page.click('#stop-btn');
    }
    return results;
  }

  test('pulls: reset state is pull-down; pull-up/down/none and "keeps the pull" behave the same', async ({ page }) => {
    const out = await runBoth(page, PULLS, { waitFor: (p) => waitForLines(p, PULLS.expected.length) });
    expect(out.python).toEqual(PULLS.expected);
    expect(out.c).toEqual(PULLS.expected);
  });

  test('thresholds and hysteresis: editing a resistor WHILE the program runs moves the pin through 0.8 V / 2.0 V identically', async ({ page }) => {
    const scenario = WATCH('p = Pin(0, Pin.IN)', '  gpio_init(0); gpio_set_dir(0, GPIO_IN);');
    const wires = [wire(gpio(36), cp('res_1', '1')), wire(cp('res_1', '2'), gpio(1))];
    const setR = async (page, value, unit) => {
      await press(page, 'res_1');
      await page.fill('#popup-value', String(value));
      await page.selectOption('#popup-unit', String(unit));
      await page.waitForTimeout(700);
    };
    const out = {};
    for (const [language, build] of [['python', python], ['c', c]]) {
      await openProject(page, build(language === 'python' ? scenario.py : scenario.c, [res('res_1', 100, 1000)], wires));   // 100 kohm: 1.3 V, undefined
      await page.click('#run-btn');
      await waitForLines(page, 1);                         // "v 0": previous reading at reset
      await setR(page, 1, 1000);                           // 1 kohm: 3.2 V  -> high
      await waitForLines(page, 2);
      await setR(page, 100, 1000);                         // back to 1.3 V: stays high (hysteresis)
      await setR(page, 10, 1000000);                       // 10 Mohm: ~0.02 V -> low
      await waitForLines(page, 3);
      await setR(page, 100, 1000);                         // 1.3 V again: stays low
      out[language] = await lines(page);
      await page.click('#stop-btn');
    }
    expect(out.python).toEqual(['v 0', 'v 1', 'v 0']);
    expect(out.c).toEqual(['v 0', 'v 1', 'v 0']);
  });

  test('floating input: no pull and nothing holding it keeps its last reading, in both languages', async ({ page }) => {
    const scenario = WATCH('p = Pin(0, Pin.IN, None)', '  gpio_init(0); gpio_set_dir(0, GPIO_IN); gpio_disable_pulls(0);');
    const wires = [wire(gpio(36), cp('btn_1', '1')), wire(cp('btn_1', '3'), gpio(1))];   // 3V3 -> button -> GP0
    const out = {};
    for (const [language, build] of [['python', python], ['c', c]]) {
      await openProject(page, build(language === 'python' ? scenario.py : scenario.c, [BUTTON], wires));
      await page.click('#run-btn');
      await waitForLines(page, 1);                         // released: floating, reads 0 (reset value)
      await page.dispatchEvent('#btn-cap-group-btn_1', 'mousedown');
      await waitForLines(page, 2);                         // pressed: 3.3 V -> 1
      await page.dispatchEvent('#btn-cap-group-btn_1', 'mouseup');
      await page.waitForTimeout(800);                      // released again: nothing holds the pin, it stays 1
      out[language] = await lines(page);
      await page.click('#stop-btn');
    }
    expect(out.python).toEqual(['v 0', 'v 1']);
    expect(out.c).toEqual(['v 0', 'v 1']);
  });

  test('GPIO to GPIO, and a fresh start after Stop (the previous run leaves no memory behind)', async ({ page }) => {
    for (const [language, build, source] of [['python', python, LOOPBACK.py], ['c', c, LOOPBACK.c]]) {
      await openProject(page, build(source, [], LOOPBACK.wires));
      for (let run = 0; run < 2; run++) {
        await page.evaluate(() => { document.getElementById('output').innerHTML = ''; });
        await page.click('#run-btn');
        await waitForLines(page, LOOPBACK.expected.length);
        expect(await lines(page), `${language} run ${run + 1}`).toEqual(LOOPBACK.expected);   // "init 0" again, though the last run ended on 1
        await page.click('#stop-btn');
      }
    }
  });

  test('reads are immediate: write then read with no delay never sees a stale level (the worker solves, not the main thread)', async ({ page }) => {
    const py = ['from machine import Pin', 'import time', 'o = Pin(14, Pin.OUT)', 'i = Pin(15, Pin.IN)', 'bad = 0',
      'for k in range(300):', '    o.value(k & 1)', '    if i.value() != (k & 1):', '        bad += 1', 'print("mismatches", bad)', 'time.sleep(2)', ''].join('\n');
    const cc = C_HEAD + ['int main() { stdio_init_all();', '  gpio_init(14); gpio_set_dir(14, GPIO_OUT); gpio_init(15); gpio_set_dir(15, GPIO_IN);',
      '  int bad = 0; for (int k = 0; k < 300; k++) { gpio_put(14, k & 1); if (gpio_get(15) != (k & 1)) bad++; }',
      '  printf("mismatches %d\\n", bad); while (1) sleep_ms(100); }', ''].join('\n');
    for (const [language, build, source] of [['python', python, py], ['c', c, cc]]) {
      await openProject(page, build(source, [], LOOPBACK.wires));
      await page.click('#run-btn');
      await waitForLines(page, 1);
      expect(await lines(page), language).toEqual(['mismatches 0']);
      await page.click('#stop-btn');
    }
  });

  test('after the program resets itself, the new run starts from the reset pin state again', async ({ page }) => {
    const py = ['from machine import Pin', 'import machine, time', 'o = Pin(14, Pin.OUT)', 'i = Pin(15, Pin.IN)',
      'print("init", i.value())', 'o.high(); time.sleep(0.05); print("r", i.value())', 'time.sleep(0.4)', 'machine.reset()', ''].join('\n');
    const cc = C_HEAD + ['int main() { stdio_init_all();', '  gpio_init(14); gpio_set_dir(14, GPIO_OUT); gpio_init(15); gpio_set_dir(15, GPIO_IN);',
      '  printf("init %d\\n", gpio_get(15)); gpio_put(14, 1); sleep_ms(50); printf("r %d\\n", gpio_get(15)); sleep_ms(400);',
      '  watchdog_reboot(0, 0, 0); while (1) sleep_ms(100); }', ''].join('\n');
    for (const [language, build, source] of [['python', python, py], ['c', c, cc]]) {
      await openProject(page, build(source, [], LOOPBACK.wires));
      await page.click('#run-btn');
      await waitForLines(page, 4, 90_000);               // two full runs: init, r, init, r
      const got = await lines(page);
      expect(got.slice(0, 4), language).toEqual(['init 0', 'r 1', 'init 0', 'r 1']);
      await page.click('#stop-btn');
    }
  });

  test('C PWM into an input: mostly-high reads 1, mostly-low reads 0, level above wrap is constant high, level 0 and disabled are low', async ({ page }) => {
    const code = C_HEAD + [
      'int main() { stdio_init_all();',
      '  gpio_set_function(14, GPIO_FUNC_PWM); gpio_init(15); gpio_set_dir(15, GPIO_IN);',
      '  pwm_set_wrap(7, 999); pwm_set_gpio_level(14, 900); pwm_set_enabled(7, true);',
      '  printf("duty90 %d\\n", gpio_get(15));',
      '  pwm_set_gpio_level(14, 100); printf("duty10 %d\\n", gpio_get(15));',
      '  pwm_set_wrap(7, 99); pwm_set_gpio_level(14, 5000); printf("clamped %d\\n", gpio_get(15));',
      '  pwm_set_gpio_level(14, 0); printf("zero %d\\n", gpio_get(15));',
      '  pwm_set_gpio_level(14, 80); pwm_set_enabled(7, false); printf("disabled %d\\n", gpio_get(15));',
      '  printf("done\\n"); while (1) sleep_ms(100); }', '',
    ].join('\n');
    await openProject(page, c(code, [], [wire(gpio(19), gpio(20))]));
    await page.click('#run-btn');
    await waitForLines(page, 6);
    expect(await lines(page)).toEqual(['duty90 1', 'duty10 0', 'clamped 1', 'zero 0', 'disabled 0', 'done']);
    await page.click('#stop-btn');
  });
});
