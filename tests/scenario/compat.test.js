import { describe, it, expect } from 'vitest';
import { runScenario, pinWrites } from '../../src/scenario/runner.js';
import { ledBrightness } from '../../src/electrical/led-model.js';
import { cIt } from '../support/emcc.js';
import { C_HEAD } from '../support/c-programs.js';

// R6 — compatibility with the real Pico SDK / MicroPython idioms that programs commonly use.


const gpio = (pin) => ({ nodeType: 'gpio', pin });
const cp = (componentId, pin) => ({ nodeType: 'component_pin', componentId, pin });
const wire = (start, end) => ({ start, end });
const LED = { id: 'led_1', type: 'led', color: '#ef4444' };
const res = (id, value, unit = 1) => ({ id, type: 'resistor', value, unit });
const LED_ON_GP15 = {
  components: [LED, res('res_1', 330)],
  connections: [wire(gpio(20), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))],
};
const run = (code, extra = {}) => runScenario({ language: 'python', code, untilMs: 1000, ...extra });
const lit = (r) => ledBrightness(r.electrical.parts.led_1.current) > 0;

describe('MicroPython machine.Pin idioms', () => {
  it('Pin("LED") is the on-board LED (the most common Pico W line), Pin("GP15") and Pin("GPIO15") are GPIO 15', async () => {
    const r = await run('from machine import Pin\nled = Pin("LED", Pin.OUT)\nled.on()\nled.off()\na = Pin("GP15", Pin.OUT)\nb = Pin("GPIO15", Pin.OUT)\na.on()\nprint("ok", b.value())\n');
    expect(r.ended).toBe('exit');
    expect(r.stdout).toEqual(['ok 1']);
    expect(pinWrites(r, 25).map((w) => w.value)).toEqual([1, 0]);
    expect(pinWrites(r, 15).map((w) => w.value)).toEqual([1]);
  }, 60_000);

  it('Pin.init(), calling a pin, mode(), pull() and printing a pin behave like MicroPython', async () => {
    const code = ['from machine import Pin', 'p = Pin(15)', 'p.init(Pin.OUT, value=1)', 'print(p(), p.value())', 'p(0)', 'print(p())',
      'q = Pin(2, Pin.IN, Pin.PULL_UP)', 'print(q.mode(), q.pull(), p.mode())', 'q.pull(None)', 'print(q.pull())', 'q.pull(Pin.PULL_DOWN)', 'print(q.pull() == Pin.PULL_DOWN)',
      'print(p)', 'print(q)', ''].join('\n');
    const r = await run(code);
    expect(r.stdout).toEqual(['1 1', '0', '0 1 1', 'None', 'True', 'Pin(GPIO15, mode=OUT, pull=PULL_DOWN)', 'Pin(GPIO2, mode=IN, pull=PULL_DOWN)']);
  }, 60_000);

  it('an unknown or out-of-range pin is a ValueError, not a crash', async () => {
    const code = ['from machine import Pin', 'for bad in ("XYZ", "GPx", 99, -1):', '    try:', '        Pin(bad)', '    except ValueError as e:', '        print("ValueError")', ''].join('\n');
    expect((await run(code)).stdout).toEqual(['ValueError', 'ValueError', 'ValueError', 'ValueError']);
  }, 60_000);

  it('machine.PWM accepts the pin object or a name', async () => {
    const r = await run('from machine import PWM, Pin\nprint(PWM(Pin("GP15"), freq=1000, duty_u16=100).freq(), PWM("GP14", freq=500).freq())\n');
    expect(r.stdout).toEqual(['1000 500']);
  }, 60_000);
});

describe('pin function select (PWM with duty 0, back to plain GPIO)', () => {
  const PY = (body) => ['from machine import Pin, PWM', 'import time', ...body, 'time.sleep(0.5)', ''].join('\n');

  it('a pin handed to PWM with duty 0 is held LOW even if it was left high before; back to a plain Pin it follows the old level again', async () => {
    const high = await run(PY(['p = Pin(15, Pin.OUT)', 'p.on()', 'time.sleep(0.1)']), LED_ON_GP15);
    expect(lit(high)).toBe(true);
    const pwm0 = await run(PY(['p = Pin(15, Pin.OUT)', 'p.on()', 'pwm = PWM(p)', 'pwm.duty_u16(0)']), LED_ON_GP15);
    expect(lit(pwm0)).toBe(false);                                         // the old behaviour fell back to the stale high level
    const half = await run(PY(['p = Pin(15, Pin.OUT)', 'pwm = PWM(p, freq=1000, duty_u16=32768)']), LED_ON_GP15);
    expect(half.electrical.parts.led_1.current).toBeGreaterThan(0);
    const back = await run(PY(['p = Pin(15, Pin.OUT)', 'p.on()', 'pwm = PWM(p)', 'pwm.duty_u16(0)', 'pwm.deinit()', 'p = Pin(15, Pin.OUT)']), LED_ON_GP15);
    expect(lit(back)).toBe(true);                                          // plain GPIO again: gpio_put's level (high) is what the pad drives
  }, 120_000);

  cIt('C: gpio_set_function(PWM) with level 0 is low; without the PWM function a running slice does nothing; gpio_init returns the pin to GPIO', async () => {
    const body = (lines) => C_HEAD + `int main() { stdio_init_all(); gpio_init(15); gpio_set_dir(15, GPIO_OUT); gpio_put(15, 1);\n${lines}\n  sleep_ms(300); while (1) sleep_ms(100); }\n`;
    const setup = '  uint s = pwm_gpio_to_slice_num(15); pwm_set_wrap(s, 99); pwm_set_enabled(s, true);';
    const lowDuty0 = await runScenario({ language: 'c', code: body(`${setup} gpio_set_function(15, GPIO_FUNC_PWM); pwm_set_gpio_level(15, 0);`), ...LED_ON_GP15, untilMs: 800 });
    expect(lit(lowDuty0)).toBe(false);
    const noFunction = await runScenario({ language: 'c', code: body(`${setup} pwm_set_gpio_level(15, 0);`), ...LED_ON_GP15, untilMs: 800 });
    expect(lit(noFunction)).toBe(true);                                    // function is still GPIO: the slice does not touch the pad
    const backToGpio = await runScenario({ language: 'c', code: body(`${setup} gpio_set_function(15, GPIO_FUNC_PWM); pwm_set_gpio_level(15, 0); gpio_init(15); gpio_set_dir(15, GPIO_OUT); gpio_put(15, 1);`), ...LED_ON_GP15, untilMs: 800 });
    expect(lit(backToGpio)).toBe(true);
    const query = await runScenario({ language: 'c', code: C_HEAD + 'int main() { stdio_init_all(); printf("%d ", (int)gpio_get_function(15)); gpio_set_function(15, GPIO_FUNC_PWM); printf("%d ", (int)gpio_get_function(15)); gpio_init(15); printf("%d\\n", (int)gpio_get_function(15)); return 0; }\n', untilMs: 100 });
    expect(query.stdout).toEqual(['5 4 5']);                               // SIO, PWM, SIO
  }, 240_000);
});

describe('removed networking', () => {
  cIt('a C program that includes the removed HTTP or MQTT headers is refused at compile time with a clear message', async () => {
    for (const header of ['net/http_client.h', 'net/mqtt_client.h']) {
      const r = await runScenario({ language: 'c', code: `#include "pico/stdlib.h"
#include "${header}"
int main() { return 0; }
`, untilMs: 100 });
      expect(r.ended).toBe('compile-error');
      expect(r.detail.message).toMatch(/is not allowed/);
    }
  }, 120_000);
});

describe('C GPIO extras from the real SDK', () => {
  cIt('masks, bulk get/put, direction and pull queries match the SDK', async () => {
    const code = C_HEAD + [
      'int main() { stdio_init_all();',
      '  gpio_init_mask((1u << 2) | (1u << 3) | (1u << 4));',
      '  gpio_set_dir_out_masked((1u << 2) | (1u << 3));',
      '  printf("dir %d %d %d\\n", (int)gpio_get_dir(2), (int)gpio_is_dir_out(3), (int)gpio_is_dir_out(4));',
      '  gpio_set_mask((1u << 2) | (1u << 3)); printf("out %d %d\\n", (int)gpio_get_out_level(2), (int)gpio_get_out_level(3));',
      '  gpio_clr_mask(1u << 2); gpio_xor_mask((1u << 2) | (1u << 3)); printf("xor %d %d\\n", (int)gpio_get_out_level(2), (int)gpio_get_out_level(3));',
      '  gpio_put_masked((1u << 2) | (1u << 3), 1u << 3); printf("masked %d %d\\n", (int)gpio_get_out_level(2), (int)gpio_get_out_level(3));',
      '  gpio_set_dir_masked((1u << 2) | (1u << 3), 1u << 2); printf("dirmasked %d %d\\n", (int)gpio_get_dir(2), (int)gpio_get_dir(3));',
      '  gpio_set_pulls(4, true, false); printf("pulls %d %d\\n", (int)gpio_is_pulled_up(4), (int)gpio_is_pulled_down(4));',
      '  gpio_set_pulls(4, false, true); printf("pulls %d %d\\n", (int)gpio_is_pulled_up(4), (int)gpio_is_pulled_down(4));',
      '  gpio_set_pulls(4, false, false); printf("pulls %d %d\\n", (int)gpio_is_pulled_up(4), (int)gpio_is_pulled_down(4));',
      '  gpio_pull_up(4); printf("all %d\\n", (int)((gpio_get_all() >> 4) & 1u));',
      '  gpio_put_all(0); printf("allzero %d\\n", (int)gpio_get_out_level(2) + (int)gpio_get_out_level(3));',
      '  gpio_set_dir_all_bits(0); printf("alldirs %d\\n", (int)gpio_get_dir(2) + (int)gpio_get_dir(3));',
      '  return 0; }', ''].join('\n');
    const r = await runScenario({ language: 'c', code, untilMs: 500 });
    expect(r.stdout).toEqual(['dir 1 1 0', 'out 1 1', 'xor 1 0', 'masked 0 1', 'dirmasked 1 0', 'pulls 1 0', 'pulls 0 1', 'pulls 0 0', 'all 1', 'allzero 0', 'alldirs 0']);
  }, 180_000);

  cIt('gpio_get_all() sees what the circuit drives (GPIO to GPIO loopback)', async () => {
    const code = C_HEAD + [
      'int main() { stdio_init_all(); gpio_init(14); gpio_set_dir(14, GPIO_OUT); gpio_init(15); gpio_set_dir(15, GPIO_IN);',
      '  gpio_put(14, 1); printf("%d\\n", (int)((gpio_get_all() >> 15) & 1u));',
      '  gpio_put(14, 0); printf("%d\\n", (int)((gpio_get_all() >> 15) & 1u)); return 0; }', ''].join('\n');
    const r = await runScenario({ language: 'c', code, connections: [wire(gpio(19), gpio(20))], untilMs: 500 });
    expect(r.stdout).toEqual(['1', '0']);
  }, 180_000);
});
