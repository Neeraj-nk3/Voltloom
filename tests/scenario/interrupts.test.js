import { describe, it, expect } from 'vitest';
import { runScenario, pinWrites } from '../../src/scenario/runner.js';
import { ledBrightness } from '../../src/electrical/led-model.js';
import { cIt } from '../support/emcc.js';
import { C_HEAD } from '../support/c-programs.js';

// R4: GPIO interrupts, the watchdog, reset handling and PWM frequency, tested on the deterministic runner.
// Interrupt handlers run at the VIRTUAL TIME OF THE EDGE, even in the middle of a sleep, and the program's own sleep
// still ends on schedule.


const gpio = (pin) => ({ nodeType: 'gpio', pin });
const cp = (componentId, pin) => ({ nodeType: 'component_pin', componentId, pin });
const wire = (start, end) => ({ start, end });
const BTN = { id: 'btn_1', type: 'button' };
const LED = { id: 'led_1', type: 'led', color: '#ef4444' };
const res = (id, value, unit = 1) => ({ id, type: 'resistor', value, unit });
// GP0 (physical 1) -> button -> GND, with an LED + resistor on GP15 (physical 20)
const BUTTON_AND_LED = {
  components: [BTN, LED, res('res_1', 330)],
  connections: [wire(gpio(3), cp('btn_1', '1')), wire(cp('btn_1', '3'), gpio(1)),
    wire(gpio(20), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))],
};
const PRESS_RELEASE = [
  { atMs: 1234.5, button: 'btn_1', pressed: true }, { atMs: 1500, button: 'btn_1', pressed: false },
  { atMs: 2000, button: 'btn_1', pressed: true }, { atMs: 2250, button: 'btn_1', pressed: false },
];

const PY_FALLING = ['from machine import Pin', 'import time',
  'led = Pin(15, Pin.OUT)', 'btn = Pin(0, Pin.IN, Pin.PULL_UP)', 'count = 0',
  'def handler(pin):', '    global count', '    count += 1', '    led.toggle()', '    print("irq", count, time.ticks_ms())',
  'btn.irq(trigger=Pin.IRQ_FALLING, handler=handler)',
  'while True:', '    time.sleep(1)', '    print("tick", time.ticks_ms(), count)', ''].join('\n');
const C_FALLING = C_HEAD + [
  'volatile int count = 0; static int level = 0;',
  'void handler(uint gpio, uint32_t events) { count++; level = !level; gpio_put(15, level); printf("irq %d %d\\n", count, (int)(time_us_64() / 1000)); }',
  'int main() { stdio_init_all(); gpio_init(15); gpio_set_dir(15, GPIO_OUT); gpio_init(0); gpio_set_dir(0, GPIO_IN); gpio_pull_up(0);',
  '  gpio_set_irq_enabled_with_callback(0, GPIO_IRQ_EDGE_FALL, true, &handler);',
  '  while (1) { sleep_ms(1000); printf("tick %d %d\\n", (int)(time_us_64() / 1000), count); } }', ''].join('\n');

describe('Python GPIO interrupts', () => {
  it('the handler runs at the exact virtual time of the falling edge, in the middle of a sleep, and the sleep still ends on schedule', async () => {
    const r = await runScenario({ language: 'python', code: PY_FALLING, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 3100 });
    expect(r.ended).toBe('limit');
    // two presses -> two FALLING edges -> two toggles of the LED pin, exactly at the press times (the release edges are rising: not subscribed)
    expect(pinWrites(r, 15)).toEqual([{ tUs: 1_234_500, value: 1 }, { tUs: 2_000_000, value: 0 }]);
    expect(r.trace.filter((e) => e.type === 'irq.fired').map((e) => [e.tUs, e.pin, e.events])).toEqual([[1_234_500, 0, 4], [2_000_000, 0, 4]]);
    // handler output carries the same time; the loop's own prints show the 1 s sleeps were not disturbed
    expect(r.stdout.filter((l) => l.startsWith('irq'))).toEqual(['irq 1 1234', 'irq 2 2000']);
    const ticks = r.stdout.filter((l) => l.startsWith('tick')).map((l) => l.split(' ').map(Number));
    // the first press (1234.5 ms) falls inside the second sleep and the second press (exactly 2000 ms) just before
    // that sleep ends, so by the second tick the program has seen both
    expect(ticks.map((t) => t[2])).toEqual([0, 2, 2]);
    expect(Math.abs(ticks[0][1] - 1000)).toBeLessThanOrEqual(1);
    expect(Math.abs(ticks[1][1] - 2000)).toBeLessThanOrEqual(2);
  }, 60_000);

  it('the LED the handler toggles lights at the press time: electrical result after the second toggle is dark, after the first lit', async () => {
    const lit = await runScenario({ language: 'python', code: PY_FALLING, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 1800 });
    expect(ledBrightness(lit.electrical.parts.led_1.current)).toBeGreaterThan(0.3);
    const dark = await runScenario({ language: 'python', code: PY_FALLING, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 2500 });
    expect(ledBrightness(dark.electrical.parts.led_1.current)).toBe(0);
  }, 60_000);

  it('rising and falling together: every press and release is a separate interrupt, in order', async () => {
    const code = ['from machine import Pin', 'import time', 'btn = Pin(0, Pin.IN, Pin.PULL_UP)', 'def h(pin):', '    print("edge", pin.value(), time.ticks_ms())',
      'btn.irq(trigger=Pin.IRQ_FALLING | Pin.IRQ_RISING, handler=h)', 'time.sleep(5)', ''].join('\n');
    const r = await runScenario({ language: 'python', code, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 3000 });
    expect(r.stdout).toEqual(['edge 0 1234', 'edge 1 1500', 'edge 0 2000', 'edge 1 2250']);
    expect(r.trace.filter((e) => e.type === 'irq.fired').map((e) => e.events)).toEqual([4, 8, 4, 8]);
  }, 60_000);

  it('a program write to a pin wired to another pin with an interrupt runs the handler inside the write, at that time', async () => {
    const code = ['from machine import Pin', 'import time', 'o = Pin(14, Pin.OUT)', 'i = Pin(15, Pin.IN)',
      'def h(pin):', '    print("rise at", time.ticks_us())', 'i.irq(trigger=Pin.IRQ_RISING, handler=h)', 'time.sleep(0.25)', 'o.high()', 'print("after write")', ''].join('\n');
    const r = await runScenario({ language: 'python', code, connections: [wire(gpio(19), gpio(20))], untilMs: 1000 });
    expect(r.stdout[0]).toMatch(/^rise at 25000\d$/);       // 250 ms plus a few microseconds of reads/prints
    expect(r.stdout[1]).toBe('after write');                // the handler ran BEFORE the next statement
  }, 60_000);

  it('irq(handler=None) turns it off; machine.disable_irq() holds interrupts until enable_irq()', async () => {
    const code = ['from machine import Pin, disable_irq, enable_irq', 'import time', 'btn = Pin(0, Pin.IN, Pin.PULL_UP)', 'def h(pin):', '    print("irq at", time.ticks_ms())',
      'btn.irq(trigger=Pin.IRQ_FALLING, handler=h)',
      'state = disable_irq()', 'time.sleep(1.5)', 'print("enabling at", time.ticks_ms())', 'enable_irq(state)', 'print("enabled")',
      'btn.irq(handler=None)', 'time.sleep(2)', 'print("done")', ''].join('\n');
    const r = await runScenario({ language: 'python', code, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 5000 });
    // the press at 1234.5 happened while disabled: it is delivered when interrupts are enabled again (1500), and the
    // press at 2000 happens after the handler was removed
    expect(r.stdout).toEqual(['enabling at 1500', 'irq at 1500', 'enabled', 'done']);
  }, 60_000);

  it('an exception in a handler is reported on stderr and the program carries on', async () => {
    const code = ['from machine import Pin', 'import time', 'btn = Pin(0, Pin.IN, Pin.PULL_UP)', 'def h(pin):', '    raise ValueError("boom")',
      'btn.irq(trigger=Pin.IRQ_FALLING, handler=h)', 'time.sleep(3)', 'print("survived")', ''].join('\n');
    const r = await runScenario({ language: 'python', code, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 4000 });
    expect(r.stdout).toEqual(['survived']);
    expect(r.trace.filter((e) => e.type === 'stderr').map((e) => e.text).join('\n')).toMatch(/boom/);
    expect(r.ended).toBe('exit');
  }, 60_000);

  it('level interrupts fire once when the condition becomes true (a documented simplification)', async () => {
    const code = ['from machine import Pin', 'import time', 'btn = Pin(0, Pin.IN, Pin.PULL_UP)', 'def h(pin):', '    print("low at", time.ticks_ms())',
      'btn.irq(trigger=Pin.IRQ_LOW_LEVEL, handler=h)', 'time.sleep(3)', ''].join('\n');
    const r = await runScenario({ language: 'python', code, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 3000 });
    expect(r.stdout).toEqual(['low at 1234', 'low at 2000']);
  }, 60_000);

  it('polling with busy-waits still sees interrupts, because every pin or clock read is a point where they are delivered', async () => {
    const code = ['from machine import Pin', 'import time', 'btn = Pin(0, Pin.IN, Pin.PULL_UP)', 'n = [0]', 'def h(pin):', '    n[0] += 1',
      'btn.irq(trigger=Pin.IRQ_FALLING, handler=h)', 'while n[0] < 2:', '    time.ticks_ms()', 'print("two interrupts at", time.ticks_ms())', ''].join('\n');
    const r = await runScenario({ language: 'python', code, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 5000 });
    expect(r.stdout).toEqual(['two interrupts at 2000']);
    expect(r.ended).toBe('exit');
  }, 60_000);

  it('the identical scenario gives the identical trace every time (interrupt scenario, 4 runs)', async () => {
    const spec = { language: 'python', code: PY_FALLING, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 3100 };
    const runs = [];
    for (let i = 0; i < 4; i++) runs.push(await runScenario(spec));
    for (const r of runs) expect(r.trace).toEqual(runs[0].trace);
  }, 120_000);
});

describe('C GPIO interrupts and Python / C consistency', () => {
  cIt('the C callback runs at the same virtual times as the Python handler, with the SDK event value', async () => {
    const c = await runScenario({ language: 'c', code: C_FALLING, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 3100 });
    const py = await runScenario({ language: 'python', code: PY_FALLING, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 3100 });
    expect(pinWrites(c, 15)).toEqual([{ tUs: 1_234_500, value: 1 }, { tUs: 2_000_000, value: 0 }]);
    expect(pinWrites(c, 15)).toEqual(pinWrites(py, 15));
    expect(c.trace.filter((e) => e.type === 'irq.fired').map((e) => [e.tUs, e.pin, e.events]))
      .toEqual(py.trace.filter((e) => e.type === 'irq.fired').map((e) => [e.tUs, e.pin, e.events]));
    expect(c.stdout.filter((l) => l.startsWith('irq'))).toEqual(['irq 1 1234', 'irq 2 2000']);
    expect(c.stdout.filter((l) => l.startsWith('tick')).map((l) => Number(l.split(' ')[2]))).toEqual([0, 2, 2]);
    expect(c.electrical.parts.led_1.current).toBeCloseTo(py.electrical.parts.led_1.current, 12);
  }, 180_000);

  cIt('the C callback receives GPIO_IRQ_EDGE_FALL (4) and GPIO_IRQ_EDGE_RISE (8), as in the real SDK', async () => {
    const code = C_HEAD + [
      'void cb(uint gpio, uint32_t events) { printf("gpio %d events %d\\n", (int)gpio, (int)events); }',
      'int main() { stdio_init_all(); gpio_init(0); gpio_set_dir(0, GPIO_IN); gpio_pull_up(0);',
      '  gpio_set_irq_enabled_with_callback(0, GPIO_IRQ_EDGE_FALL | GPIO_IRQ_EDGE_RISE, true, &cb);',
      '  while (1) tight_loop_contents(); }', ''].join('\n');
    const r = await runScenario({ language: 'c', code, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 3000 });
    expect(r.stdout).toEqual(['gpio 0 events 4', 'gpio 0 events 8', 'gpio 0 events 4', 'gpio 0 events 8']);
  }, 180_000);

  cIt('gpio_set_irq_enabled() with a callback set separately, and disabling again, work as in the SDK', async () => {
    const code = C_HEAD + [
      'void cb(uint gpio, uint32_t events) { printf("edge %d\\n", (int)events); }',
      'int main() { stdio_init_all(); gpio_init(0); gpio_set_dir(0, GPIO_IN); gpio_pull_up(0);',
      '  gpio_set_irq_callback(&cb);', '  gpio_set_irq_enabled(0, GPIO_IRQ_EDGE_FALL | GPIO_IRQ_EDGE_RISE, true);',
      '  sleep_ms(1600); gpio_set_irq_enabled(0, GPIO_IRQ_EDGE_RISE, false);', '  while (1) sleep_ms(100); }', ''].join('\n');
    const r = await runScenario({ language: 'c', code, ...BUTTON_AND_LED, script: PRESS_RELEASE, untilMs: 3000 });
    // 1234.5 fall, 1500 rise delivered; after 1600 only FALL remains enabled: the 2000 press is seen, the 2250 release is not
    expect(r.stdout).toEqual(['edge 4', 'edge 8', 'edge 4']);
  }, 180_000);

  cIt('a real-SDK-style program (typical pico-examples gpio_irq with tight_loop_contents) compiles and works', async () => {
    const code = ['#include <stdio.h>', '#include "pico/stdlib.h"', '#include "hardware/gpio.h"',
      'static const char *event_names[] = { "LEVEL_LOW", "LEVEL_HIGH", "EDGE_FALL", "EDGE_RISE" };',
      'void gpio_callback(uint gpio, uint32_t events) {',
      '  for (uint i = 0; i < 4; i++) { uint32_t mask = 1u << i; if (events & mask) printf("GPIO %d %s\\n", gpio, event_names[i]); } }',
      'int main() { stdio_init_all(); bool ok = stdio_init_all();',
      '  gpio_init(0); gpio_set_dir(0, GPIO_IN); gpio_pull_up(0);',
      '  gpio_set_irq_enabled_with_callback(0, GPIO_IRQ_EDGE_RISE | GPIO_IRQ_EDGE_FALL, true, &gpio_callback);',
      '  printf("ok %d\\n", ok); while (1) tight_loop_contents(); }', ''].join('\n');
    const r = await runScenario({ language: 'c', code, ...BUTTON_AND_LED, script: PRESS_RELEASE.slice(0, 2), untilMs: 2000 });
    expect(r.ended).toBe('limit');
    expect(r.stdout).toEqual(['ok 1', 'GPIO 0 EDGE_FALL', 'GPIO 0 EDGE_RISE']);
  }, 180_000);

  cIt('the SDK time helpers work on the virtual clock (absolute_time_t, timeouts, sleep_until)', async () => {
    const code = C_HEAD + [
      'int main() { stdio_init_all();',
      '  absolute_time_t t0 = get_absolute_time();',
      '  absolute_time_t deadline = make_timeout_time_ms(250);',
      '  printf("reached before %d\\n", (int)time_reached(deadline));',
      '  sleep_until(deadline);',
      '  printf("reached after %d\\n", (int)time_reached(deadline));',
      '  printf("elapsed ms %d\\n", (int)(absolute_time_diff_us(t0, get_absolute_time()) / 1000));',
      '  busy_wait_ms(100); printf("since boot %d\\n", (int)to_ms_since_boot(get_absolute_time()));',
      '  printf("us32 %d\\n", (int)(time_us_32() / 1000)); return 0; }', ''].join('\n');
    const r = await runScenario({ language: 'c', code, untilMs: 5000 });
    expect(r.stdout).toEqual(['reached before 0', 'reached after 1', 'elapsed ms 250', 'since boot 350', 'us32 350']);
  }, 180_000);
});

describe('watchdog and reset handling', () => {
  const PY_WDT = ['import machine', 'import time',
    'print("cause", machine.reset_cause())', 'wdt = machine.WDT(timeout=1000)',
    'for i in range(3):', '    time.sleep(0.5)', '    wdt.feed()', '    print("fed", i)',
    'print("now stalling")', 'time.sleep(10)', 'print("never")', ''].join('\n');
  const C_WDT = C_HEAD + [
    'int main() { stdio_init_all(); printf("cause %d\\n", (int)watchdog_caused_reboot()); watchdog_enable(1000, false);',
    '  for (int i = 0; i < 3; i++) { sleep_ms(500); watchdog_update(); printf("fed %d\\n", i); }',
    '  printf("now stalling\\n"); sleep_ms(10000); printf("never\\n"); return 0; }', ''].join('\n');

  it('Python: not feeding the watchdog resets the board exactly one timeout after the last feed, and the next boot knows why', async () => {
    const r = await runScenario({ language: 'python', code: PY_WDT, untilMs: 4000, followResets: true, maxBoots: 2 });
    expect(r.boots.map((b) => [b.cause, b.ended, b.virtualEndUs])).toEqual([[-1, 'reset', 2_500_000], [1, 'limit', r.boots[1].virtualEndUs]]);
    expect(r.stdout).toContain('now stalling');
    expect(r.stdout).not.toContain('never');
    const boot0 = r.trace.filter((e) => e.boot === 0 && e.type === 'stdout').map((e) => e.text);
    const boot1 = r.trace.filter((e) => e.boot === 1 && e.type === 'stdout').map((e) => e.text);
    expect(boot0[0]).toBe('cause 1');           // machine.PWRON_RESET
    expect(boot1[0]).toBe('cause 3');           // machine.WDT_RESET
    expect(r.trace.find((e) => e.type === 'reset')).toMatchObject({ boot: 0, tUs: 2_500_000, kind: 1 });
    expect(boot1.slice(1)).toEqual(boot0.slice(1, boot1.length));            // the second boot behaves exactly like the first (as far as the time budget lets it run)
  }, 60_000);

  it('Python: a program that keeps feeding the watchdog is never reset', async () => {
    const code = ['import machine, time', 'wdt = machine.WDT(timeout=1000)', 'while True:', '    time.sleep(0.4)', '    wdt.feed()', ''].join('\n');
    const r = await runScenario({ language: 'python', code, untilMs: 20_000, followResets: true });
    expect(r.boots).toHaveLength(1);
    expect(r.ended).toBe('limit');
  }, 60_000);

  it('Python: machine.reset() restarts with reset_cause PWRON_RESET, machine.soft_reset() with SOFT_RESET', async () => {
    const hard = ['import machine, time', 'print("cause", machine.reset_cause())', 'time.sleep(0.2)', 'machine.reset()', ''].join('\n');
    const r = await runScenario({ language: 'python', code: hard, untilMs: 1000, followResets: true, maxBoots: 2 });
    expect(r.boots.map((b) => b.cause)).toEqual([-1, 2]);        // the second boot was started by a power-cycle-kind reset
    expect(r.stdout.slice(0, 2)).toEqual(['cause 1', 'cause 1']);
    const soft = ['import machine, time', 'print("cause", machine.reset_cause())', 'time.sleep(0.2)', 'machine.soft_reset()', ''].join('\n');
    const s = await runScenario({ language: 'python', code: soft, untilMs: 1000, followResets: true, maxBoots: 2 });
    expect(s.stdout.slice(0, 2)).toEqual(['cause 1', 'cause 4']);
  }, 60_000);

  it('Python: the watchdog is a virtual-time feature: a 30 s timeout costs no real time', async () => {
    const code = ['import machine, time', 'wdt = machine.WDT(timeout=8000)', 'time.sleep(20)', ''].join('\n');
    const r = await runScenario({ language: 'python', code, untilMs: 30_000 });
    expect(r.ended).toBe('reset');
    expect(r.virtualEndUs).toBe(8_000_000);
    expect(r.wallMs).toBeLessThan(5000);
  }, 60_000);

  cIt('C: the same watchdog scenario ends the first boot at the same virtual time as Python, and the second boot sees watchdog_caused_reboot()', async () => {
    const c = await runScenario({ language: 'c', code: C_WDT, untilMs: 4000, followResets: true, maxBoots: 2 });
    expect(c.boots.map((b) => [b.cause, b.ended, b.virtualEndUs])).toEqual([[-1, 'reset', 2_500_000], [1, 'limit', c.boots[1].virtualEndUs]]);
    const boot0 = c.trace.filter((e) => e.boot === 0 && e.type === 'stdout').map((e) => e.text);
    const boot1 = c.trace.filter((e) => e.boot === 1 && e.type === 'stdout').map((e) => e.text);
    expect(boot0[0]).toBe('cause 0');
    expect(boot1[0]).toBe('cause 1');
    expect(c.trace.find((e) => e.type === 'reset')).toMatchObject({ boot: 0, tUs: 2_500_000, kind: 1 });
    expect(boot1.slice(1)).toEqual(boot0.slice(1, boot1.length));
  }, 180_000);

  cIt('C: watchdog_reboot with a delay reboots after that delay while the program keeps running; with 0 it is immediate', async () => {
    const delayed = C_HEAD + 'int main() { stdio_init_all(); watchdog_reboot(0, 0, 300); for (int i = 0; ; i++) { printf("alive %d\\n", i); sleep_ms(100); } }\n';
    const d = await runScenario({ language: 'c', code: delayed, untilMs: 2000 });
    expect(d.ended).toBe('reset');
    expect(d.virtualEndUs).toBe(300_000);
    expect(d.stdout).toEqual(['alive 0', 'alive 1', 'alive 2']);
    const immediate = C_HEAD + 'int main() { stdio_init_all(); printf("before\\n"); watchdog_reboot(0, 0, 0); printf("never\\n"); return 0; }\n';
    const i = await runScenario({ language: 'c', code: immediate, untilMs: 2000 });
    expect(i.ended).toBe('reset'); expect(i.stdout).toEqual(['before']);
  }, 180_000);
});

describe('PWM frequency', () => {
  const PY_PWM = ['from machine import Pin, PWM', 'import time', 'pwm = PWM(Pin(15), freq=1000, duty_u16=32768)',
    'print("freq", pwm.freq(), "duty", pwm.duty_u16())', 'time.sleep(0.5)', 'pwm.freq(50)', 'print("freq", pwm.freq(), "duty", pwm.duty_u16())',
    'try:', '    pwm.freq(1000000000)', 'except ValueError as e:', '    print("error", e)', 'time.sleep(1)', ''].join('\n');
  const LED_PIN = {
    components: [LED, res('res_1', 330)],
    connections: [wire(gpio(20), cp('res_1', '1')), wire(cp('res_1', '2'), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))],
  };

  it('Python machine.PWM: freq() and duty_u16() read back what was set, a bad frequency raises ValueError, and the LED gets half the current', async () => {
    const r = await runScenario({ language: 'python', code: PY_PWM, ...LED_PIN, untilMs: 1200 });
    expect(r.stdout).toEqual(['freq 1000 duty 32768', 'freq 50 duty 32768', 'error freq too large']);
    const events = r.trace.filter((e) => e.type === 'pwm');
    expect(events.some((e) => e.op === 'clkdiv' && e.value === 2)).toBe(true);          // 1000 Hz = 125 MHz / (2 * 62500)
    expect(events.some((e) => e.op === 'clkdiv' && e.value === 40)).toBe(true);         // 50 Hz = 125 MHz / (40 * 62500)
    const full = await runScenario({ language: 'python', code: PY_PWM.replace('duty_u16=32768', 'duty_u16=65535').replace('pwm.freq(50)', 'pwm.freq(50); pwm.duty_u16(65535)'), ...LED_PIN, untilMs: 1200 });
    expect(r.electrical.parts.led_1.current).toBeCloseTo(full.electrical.parts.led_1.current / 2, 6);
  }, 60_000);

  cIt('C pwm_set_clkdiv / pwm_init give the same frequency and the same LED current as Python machine.PWM', async () => {
    const code = C_HEAD + [
      'int main() { stdio_init_all(); gpio_set_function(15, GPIO_FUNC_PWM); uint s = pwm_gpio_to_slice_num(15);',
      '  pwm_config c = pwm_get_default_config(); pwm_config_set_clkdiv(&c, 2.0f); pwm_config_set_wrap(&c, 62499); pwm_init(s, &c, true);',
      '  pwm_set_gpio_level(15, 31250); sleep_ms(500);',
      '  pwm_set_clkdiv(s, 40.0f); sleep_ms(1000); return 0; }', ''].join('\n');
    const c = await runScenario({ language: 'c', code, ...LED_PIN, untilMs: 1200 });
    const py = await runScenario({ language: 'python', code: PY_PWM, ...LED_PIN, untilMs: 1200 });
    expect(c.trace.filter((e) => e.type === 'pwm').map((e) => [e.op, e.value])).toEqual([['clkdiv', 2], ['wrap', 62499], ['enable', 1], ['level', 31250], ['clkdiv', 40]]);
    expect(c.electrical.parts.led_1.current).toBeCloseTo(py.electrical.parts.led_1.current, 4);
  }, 180_000);

  cIt('the SDK PWM extras exist with the right values: pwm_gpio_to_channel, pwm_set_both_levels, pwm_set_clkdiv_int_frac', async () => {
    const code = C_HEAD + [
      'int main() { stdio_init_all(); printf("slice %d chan %d %d\\n", (int)pwm_gpio_to_slice_num(14), (int)pwm_gpio_to_channel(14), (int)pwm_gpio_to_channel(15));',
      '  pwm_set_clkdiv_int_frac(7, 3, 8); pwm_set_both_levels(7, 100, 200); pwm_set_enabled(7, true); return 0; }', ''].join('\n');
    const r = await runScenario({ language: 'c', code, untilMs: 100 });
    expect(r.stdout).toEqual(['slice 7 chan 0 1']);
    expect(r.trace.filter((e) => e.type === 'pwm').map((e) => [e.op, e.slice, e.channel ?? null, e.value])).toEqual(
      [['clkdiv', 7, null, 3.5], ['level', 7, 0, 100], ['level', 7, 1, 200], ['enable', 7, null, 1]]);
  }, 180_000);
});
