import { describe, it, expect } from 'vitest';
import { runScenario, pinWrites, pinLevelAt } from '../../src/scenario/runner.js';
import { ledBrightness } from '../../src/electrical/led-model.js';
import { cIt } from '../support/emcc.js';
import { C_HEAD } from '../support/c-programs.js';

// Deterministic scenarios: a program, a circuit, scripted inputs, a virtual-time budget. The same inputs must give
// the identical trace every time, in Python and in C, and the two languages must agree.


const gpio = (pin) => ({ nodeType: 'gpio', pin });
const cp = (componentId, pin) => ({ nodeType: 'component_pin', componentId, pin });
const wire = (start, end) => ({ start, end });
const LED = { id: 'led_1', type: 'led', color: '#ef4444' };
const BTN = { id: 'btn_1', type: 'button' };
const res = (id, value, unit = 1) => ({ id, type: 'resistor', value, unit });
// Physical pins: GP0=1, GP14=19, GP15=20, GND=3, 3V3=36
const LED_ON_GP15 = [res('res_1', 330), LED];
const LED_ON_GP15_WIRES = [wire(gpio(20), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))];

const PY_BLINK = ['from machine import Pin', 'import time', 'led = Pin(15, Pin.OUT)', 'while True:', '    led.on()', '    time.sleep(0.5)', '    led.off()', '    time.sleep(0.5)', ''].join('\n');
const C_BLINK = C_HEAD + 'int main() { gpio_init(15); gpio_set_dir(15, GPIO_OUT); while (1) { gpio_put(15, 1); sleep_ms(500); gpio_put(15, 0); sleep_ms(500); } }\n';

// A button to GND with the internal pull-up, polled every 100 ms; prints each change.
const PY_POLL = ['from machine import Pin', 'import time', 'b = Pin(0, Pin.IN, Pin.PULL_UP)', 'last = -1',
  'while True:', '    v = b.value()', '    if v != last:', '        print("v", v)', '        last = v', '    time.sleep_ms(100)', ''].join('\n');
const C_POLL = C_HEAD + 'int main() { stdio_init_all(); gpio_init(0); gpio_set_dir(0, GPIO_IN); gpio_pull_up(0); int last = -1;\n' +
  '  while (1) { int v = gpio_get(0); if (v != last) { printf("v %d\\n", v); last = v; } sleep_ms(100); } }\n';
const BUTTON_CIRCUIT = { components: [BTN], connections: [wire(gpio(3), cp('btn_1', '1')), wire(cp('btn_1', '3'), gpio(1))] };   // GP0 -> button -> GND

describe('Python scenarios (no compiler needed)', () => {
  it('a blink produces writes at exactly 0, 500, 1000 ... ms of virtual time, in about a tenth of a second of real time', async () => {
    const r = await runScenario({ language: 'python', code: PY_BLINK, components: LED_ON_GP15, connections: LED_ON_GP15_WIRES, untilMs: 3000 });
    expect(r.ended).toBe('limit');
    expect(pinWrites(r, 15)).toEqual([
      { tUs: 0, value: 1 }, { tUs: 500_000, value: 0 }, { tUs: 1_000_000, value: 1 },
      { tUs: 1_500_000, value: 0 }, { tUs: 2_000_000, value: 1 }, { tUs: 2_500_000, value: 0 },
    ]);
    expect(r.virtualEndUs).toBeGreaterThanOrEqual(3_000_000);
    expect(r.virtualEndUs).toBeLessThan(3_001_000);
    expect(pinLevelAt(r, 15, 1_200_000)).toBe(1);
    expect(r.wallMs).toBeLessThan(5000);                    // 3 virtual seconds, including starting MicroPython
  }, 60_000);

  it('the identical scenario gives the identical trace every time (5 runs)', async () => {
    const spec = { language: 'python', code: PY_POLL, ...BUTTON_CIRCUIT, untilMs: 3000,
      script: [{ atMs: 1000, button: 'btn_1', pressed: true }, { atMs: 2000, button: 'btn_1', pressed: false }] };
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await runScenario(spec));
    for (const r of runs) {
      expect(r.ended).toBe('limit');
      expect(r.trace).toEqual(runs[0].trace);
      expect(r.stdout).toEqual(runs[0].stdout);
      expect(r.electrical).toEqual(runs[0].electrical);
    }
    expect(runs[0].trace.length).toBeGreaterThan(5);
  }, 120_000);

  it('a scripted button press is seen by the next poll after it, and the release likewise', async () => {
    const r = await runScenario({ language: 'python', code: PY_POLL, ...BUTTON_CIRCUIT, untilMs: 3000,
      script: [{ atMs: 1000, button: 'btn_1', pressed: true }, { atMs: 2000, button: 'btn_1', pressed: false }] });
    expect(r.stdout).toEqual(['v 1', 'v 0', 'v 1']);
    const prints = r.trace.filter((e) => e.type === 'stdout' && /^v \d/.test(e.text));
    const pressSeenAt = prints[1].tUs; const releaseSeenAt = prints[2].tUs;
    expect(pressSeenAt).toBeGreaterThanOrEqual(1_000_000); expect(pressSeenAt).toBeLessThan(1_100_000);
    expect(releaseSeenAt).toBeGreaterThanOrEqual(2_000_000); expect(releaseSeenAt).toBeLessThan(2_100_000);
    expect(r.trace.filter((e) => e.type === 'script').map((e) => [e.tUs, e.pressed])).toEqual([[1_000_000, true], [2_000_000, false]]);
  }, 60_000);

  it('scripted resistor edits change the electrical result: 330 ohm lights the LED, 10 Mohm (edited in at 1 s) leaves it dark', async () => {
    const circuit = { components: [LED, res('res_1', 330)], connections: [wire(gpio(36), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))] };
    const idle = 'import time\ntime.sleep(5)\n';
    const lit = await runScenario({ language: 'python', code: idle, ...circuit, untilMs: 2000 });
    expect(ledBrightness(lit.electrical.parts.led_1.current)).toBeGreaterThan(0.4);
    const dark = await runScenario({ language: 'python', code: idle, ...circuit, untilMs: 2000,
      script: [{ atMs: 1000, resistor: 'res_1', value: 10, unit: 1_000_000 }] });
    expect(ledBrightness(dark.electrical.parts.led_1.current)).toBe(0);
  }, 60_000);

  it('the circuit shapes what the program reads: GPIO-to-GPIO loopback, and a pull-up with nothing wired', async () => {
    const code = ['from machine import Pin', 'import time', 'o = Pin(14, Pin.OUT)', 'i = Pin(15, Pin.IN)', 'u = Pin(3, Pin.IN, Pin.PULL_UP)',
      'print("init", i.value(), u.value())', 'o.high(); print("high", i.value())', 'o.low(); print("low", i.value())', ''].join('\n');
    const r = await runScenario({ language: 'python', code, connections: [wire(gpio(19), gpio(20))], untilMs: 1000 });
    expect(r.ended).toBe('exit');
    expect(r.stdout).toEqual(['init 0 1', 'high 1', 'low 0']);
  }, 60_000);

  it('virtual time is exact and repeatable for the program too (ticks_ms, sleeps, and read costs)', async () => {
    const code = ['import time', 't0 = time.ticks_ms()', 'time.sleep(1.5)', 'time.sleep_ms(250)', 'time.sleep_us(500)', 'print(time.ticks_diff(time.ticks_ms(), t0))', ''].join('\n');
    const a = await runScenario({ language: 'python', code, untilMs: 5000 });
    const b = await runScenario({ language: 'python', code, untilMs: 5000 });
    expect(a.stdout).toEqual(['1750']);
    expect(b.stdout).toEqual(a.stdout);
    expect(a.ended).toBe('exit');
  }, 60_000);

  it('how a scenario ends: exit, reset, program error, and the virtual-time limit', async () => {
    const exit = await runScenario({ language: 'python', code: 'print("hi")\n', untilMs: 1000 });
    expect(exit.ended).toBe('exit'); expect(exit.stdout).toEqual(['hi']);

    const reset = await runScenario({ language: 'python', code: 'import machine, time\nprint("before")\ntime.sleep(0.1)\nmachine.reset()\nprint("never")\n', untilMs: 1000 });
    expect(reset.ended).toBe('reset'); expect(reset.stdout).toEqual(['before']);

    const error = await runScenario({ language: 'python', code: 'print("x")\nraise ValueError("boom")\n', untilMs: 1000 });
    expect(error.ended).toBe('error'); expect(error.detail.message).toMatch(/boom/);

    const limit = await runScenario({ language: 'python', code: 'import time\nwhile True:\n    time.sleep(0.01)\n', untilMs: 500 });
    expect(limit.ended).toBe('limit'); expect(limit.virtualEndUs).toBeGreaterThanOrEqual(500_000);
  }, 120_000);

  it('a loop that busy-waits on the clock (no sleep) still ends at the virtual-time limit', async () => {
    const r = await runScenario({ language: 'python', code: 'import time\nwhile True:\n    time.ticks_ms()\n', untilMs: 100, wallTimeoutMs: 20_000 });
    expect(r.ended).toBe('limit');
  }, 60_000);

  it('a loop that never touches the clock is cut off by the real-time safety net, not left running', async () => {
    const t = Date.now();
    const r = await runScenario({ language: 'python', code: 'while True:\n    pass\n', untilMs: 1000, wallTimeoutMs: 1500 });
    expect(r.ended).toBe('timeout');
    expect(Date.now() - t).toBeLessThan(10_000);
  }, 60_000);

  it('rejects malformed scripts instead of silently ignoring them', async () => {
    await expect(runScenario({ language: 'python', code: '', script: [{ atMs: -1, button: 'btn_1', pressed: true }] })).rejects.toThrow(/non-negative/);
    await expect(runScenario({ language: 'python', code: '', script: [{ atMs: 1, button: 'btn_1' }] })).rejects.toThrow(/pressed/);
    await expect(runScenario({ language: 'python', code: '', script: [{ atMs: 1, wiggle: true }] })).rejects.toThrow(/expected/);
    await expect(runScenario({ language: 'ruby', code: '' })).rejects.toThrow(/language/);
  });
});

describe('C scenarios and Python / C parity (need the Emscripten compiler)', () => {
  cIt('a C blink has the identical trace on repeat, and the same pin writes as the Python blink', async () => {
    const spec = { language: 'c', code: C_BLINK, components: LED_ON_GP15, connections: LED_ON_GP15_WIRES, untilMs: 3000 };
    const a = await runScenario(spec);
    const b = await runScenario(spec);
    expect(a.ended).toBe('limit');
    expect(b.trace).toEqual(a.trace);
    const py = await runScenario({ language: 'python', code: PY_BLINK, components: LED_ON_GP15, connections: LED_ON_GP15_WIRES, untilMs: 3000 });
    expect(pinWrites(a, 15)).toEqual(pinWrites(py, 15));
    expect(a.electrical.parts.led_1.current).toBeCloseTo(py.electrical.parts.led_1.current, 12);
  }, 180_000);

  cIt('the same button scenario gives the same printed lines, at the same virtual times, in C and Python', async () => {
    const script = [{ atMs: 1000, button: 'btn_1', pressed: true }, { atMs: 2000, button: 'btn_1', pressed: false }];
    const py = await runScenario({ language: 'python', code: PY_POLL, ...BUTTON_CIRCUIT, untilMs: 3000, script });
    const c = await runScenario({ language: 'c', code: C_POLL, ...BUTTON_CIRCUIT, untilMs: 3000, script });
    expect(c.stdout).toEqual(py.stdout);
    expect(c.stdout).toEqual(['v 1', 'v 0', 'v 1']);
    const times = (r) => r.trace.filter((e) => e.type === 'stdout' && /^v \d/.test(e.text)).map((e) => e.tUs);
    expect(times(c)).toEqual(times(py));
  }, 180_000);

  cIt('PWM: the LED current of a half-duty PWM is half the full current, and the trace carries the PWM events', async () => {
    const code = C_HEAD + 'int main() { gpio_set_function(15, GPIO_FUNC_PWM); uint s = pwm_gpio_to_slice_num(15); pwm_set_wrap(s, 999); pwm_set_gpio_level(15, 500); pwm_set_enabled(s, true); while (1) sleep_ms(100); }\n';
    const half = await runScenario({ language: 'c', code, components: LED_ON_GP15, connections: LED_ON_GP15_WIRES, untilMs: 500 });
    expect(half.trace.filter((e) => e.type === 'pwm').map((e) => e.op)).toEqual(['wrap', 'level', 'enable']);
    const full = await runScenario({ language: 'c', code: code.replace('500)', '1000)'), components: LED_ON_GP15, connections: LED_ON_GP15_WIRES, untilMs: 500 });
    expect(half.electrical.parts.led_1.current).toBeCloseTo(full.electrical.parts.led_1.current / 2, 6);
  }, 180_000);

  cIt('C: a busy-wait on time_us_64 ends at the limit; a loop that never touches the clock is cut off by the safety net', async () => {
    const spin = await runScenario({ language: 'c', code: C_HEAD + 'int main() { while (1) { (void)time_us_64(); } }\n', untilMs: 50, wallTimeoutMs: 30_000 });
    expect(spin.ended).toBe('limit');
    const t = Date.now();
    const stuck = await runScenario({ language: 'c', code: C_HEAD + 'int main() { volatile int x = 0; while (1) { x++; } }\n', untilMs: 1000, wallTimeoutMs: 1500 });
    expect(stuck.ended).toBe('timeout');
    expect(Date.now() - t).toBeLessThan(20_000);
  }, 180_000);

  cIt('C compile errors are reported, not thrown', async () => {
    const r = await runScenario({ language: 'c', code: 'int main(){ undeclared(); }', untilMs: 100 });
    expect(r.ended).toBe('compile-error');
    expect(r.detail.message).toMatch(/undeclared|implicit/i);
  }, 120_000);
});
