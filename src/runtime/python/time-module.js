/**
 * time-module.js — makes MicroPython's `time` / `utime` read and sleep on the program's virtual clock
 *
 * `time` and `utime` are two different module objects in this MicroPython build, and attributes can only be set on
 * `time`. So the attributes of `time` are replaced and `sys.modules['utime']` is pointed at that same module
 * (verified: `import utime`, `from utime import ticks_ms` and `import time` all see the virtual functions).
 * User code always runs after this prelude, so `from time import sleep` also gets the virtual one.
 *
 * Values that cross from JavaScript into Python must fit 32 bits, so the JS side returns already-wrapped
 * tick values (ticks wrap at 2**30 in MicroPython) and floats; times in nanoseconds travel as text.
 *
 * Not virtualised (they do not read the clock): ticks_diff, ticks_add. localtime()/gmtime() with no argument
 * use the virtual time. The virtual time.time() starts at a FIXED epoch so runs are repeatable.
 */

/** 2025-01-01T00:00:00Z — where the virtual wall-clock time starts. [A] arbitrary but fixed. */
export const VIRTUAL_EPOCH_SECONDS = 1735689600;

const TICK_WRAP = 2 ** 30;

/** The JS functions the Python prelude calls. `clock` is a VirtualClock. */
export function createClockModule(clock) {
  const wrap = (n) => Math.floor(n) % TICK_WRAP;
  return {
    sleep_s: (s) => { clock.sleepUs(Number(s) * 1e6); },
    sleep_ms: (ms) => { clock.sleepUs(Number(ms) * 1e3); },
    sleep_us: (us) => { clock.sleepUs(Number(us)); },
    ticks_us: () => wrap(clock.tick()),
    ticks_ms: () => wrap(clock.tick() / 1000),
    seconds: () => VIRTUAL_EPOCH_SECONDS + clock.tick() / 1e6,
    nanoseconds: () => String(BigInt(VIRTUAL_EPOCH_SECONDS) * 1_000_000_000n + BigInt(Math.floor(clock.tick())) * 1000n)
  };
}

export const TIME_PRELUDE = `
import sys
import time as _t
import _voltloom_clock as _clk

def sleep(secs):
    _clk.sleep_s(secs)

def sleep_ms(ms):
    _clk.sleep_ms(ms)

def sleep_us(us):
    _clk.sleep_us(us)

def ticks_us():
    return _clk.ticks_us()

def ticks_ms():
    return _clk.ticks_ms()

def ticks_cpu():
    return _clk.ticks_us()

def time():
    return _clk.seconds()

def time_ns():
    return int(_clk.nanoseconds())

def _wrap_clock_reader(name):
    original = getattr(_t, name, None)
    if original is None:
        return None
    def reader(secs=None):
        return original(int(_clk.seconds()) if secs is None else secs)
    return reader

_virtual = {
    'sleep': sleep, 'sleep_ms': sleep_ms, 'sleep_us': sleep_us,
    'ticks_us': ticks_us, 'ticks_ms': ticks_ms, 'ticks_cpu': ticks_cpu,
    'time': time, 'time_ns': time_ns,
}
for _name in ('localtime', 'gmtime'):
    _fn = _wrap_clock_reader(_name)
    if _fn is not None:
        _virtual[_name] = _fn
for _name, _fn in _virtual.items():
    setattr(_t, _name, _fn)
sys.modules['utime'] = _t     # one module for both names: user code sees the same virtual functions
`;
