/**
 * machine-module.js — the Python side of the simulated `machine` module
 *
 * The JS bridge between MicroPython and the worker passes positional arguments only: a call like
 * Pin(0, Pin.IN, pull=Pin.PULL_UP) reached a JS function with the keyword silently dropped, so
 * the pull-up was never applied. To get real Python call semantics, `machine.Pin` is a small Python
 * class that parses its own arguments (positional or keyword) and then calls the JS primitives in
 * `_voltloom_hw` (see runtime.js), which own the connection to the simulator.
 *
 * Supported:
 *   Pin(id, mode, pull, *, value) where id is a GPIO number, "GP15" / "GPIO15", or "LED" (the Pico W's on-board LED,
 *     which the simulator keeps on GPIO 25), .init(...), .value([v]), pin([v]), .mode(), .pull(), .on(), .off(),
 *     .high(), .low(), .toggle(), .irq(handler, trigger),
 *     the constants IN, OUT, OPEN_DRAIN, PULL_UP, PULL_DOWN and IRQ_LOW_LEVEL/HIGH_LEVEL/FALLING/RISING
 *     (same values as MicroPython on the RP2040: 1, 2, 4, 8)
 *   PWM(pin, *, freq, duty_u16, duty_ns), .freq([f]), .duty_u16([d]), .duty_ns([ns]), .deinit()
 *   WDT(id=0, timeout=5000), .feed()
 *   reset(), soft_reset(), reset_cause() with PWRON_RESET / WDT_RESET / SOFT_RESET, freq(), disable_irq(), enable_irq()
 * A Pin(id) with no mode or pull keeps that pin's current settings, as in MicroPython.
 * OPEN_DRAIN is approximated as a plain output. Everything else in `machine` (I2C, SPI, UART, ADC, Timer ...) is not provided.
 *
 * Interrupt handlers are called with the Pin object, at the virtual time of the edge (even in the middle of a sleep).
 * An exception inside a handler is printed and the program carries on, as on a real board.
 *
 * This text is executed once by the worker (not through the debugger line injector).
 */

export const MACHINE_PRELUDE = `
import sys
import _voltloom_hw as _hw

_irq_handlers = {}

def _irq_entry(pin_id, events):
    entry = _irq_handlers.get(pin_id)
    if entry is not None:
        entry[0](entry[1])

_hw.set_irq_entry(_irq_entry)

def _pin_number(id):
    # MicroPython accepts board names as well as numbers; resolve them here so the JS side only sees numbers.
    if isinstance(id, str):
        if id == 'LED' or id == 'WL_GPIO0':
            return 25
        digits = id[4:] if id.startswith('GPIO') else id[2:] if id.startswith('GP') else ''
        if digits.isdigit():
            return int(digits)
        raise ValueError("unknown pin '%s'" % id)
    if not isinstance(id, int) or isinstance(id, bool) or id < 0 or id > 29:
        raise ValueError("Pin %s is invalid (0-29)" % (id,))
    return id

class Pin:
    IN = 0
    OUT = 1
    OPEN_DRAIN = 2
    PULL_UP = 1
    PULL_DOWN = 2
    IRQ_LOW_LEVEL = 1
    IRQ_HIGH_LEVEL = 2
    IRQ_FALLING = 4
    IRQ_RISING = 8

    def __init__(self, id, mode=-1, pull=-1, *, value=None):
        self._id = _pin_number(id)
        self.init(mode, pull, value=value)

    def init(self, mode=-1, pull=-1, *, value=None):
        if pull is None:
            pull = 0
        _hw.create(self._id, mode, pull, -1 if value is None else (1 if value else 0))

    def mode(self, m=None):
        if m is None:
            return _hw.get_mode(self._id)
        _hw.create(self._id, m, -1, -1)

    def pull(self, p=-1):
        if p == -1:
            current = _hw.get_pull(self._id)
            return current if current else None
        _hw.create(self._id, -1, 0 if p is None else p, -1)

    def __call__(self, v=None):
        return self.value(v)

    def __str__(self):
        text = 'Pin(GPIO%d, mode=%s' % (self._id, 'OUT' if _hw.get_mode(self._id) == 1 else 'IN')
        current = _hw.get_pull(self._id)
        if current:
            text += ', pull=PULL_UP' if current == 1 else ', pull=PULL_DOWN'
        return text + ')'

    __repr__ = __str__

    def value(self, v=None):
        if v is None:
            return _hw.read(self._id)
        _hw.write(self._id, 1 if v else 0)

    def on(self):
        _hw.write(self._id, 1)

    def off(self):
        _hw.write(self._id, 0)

    def high(self):
        _hw.write(self._id, 1)

    def low(self):
        _hw.write(self._id, 0)

    def toggle(self):
        _hw.toggle(self._id)

    def irq(self, handler=None, trigger=12, *, priority=1, wake=None, hard=False):
        if handler is None:
            _irq_handlers.pop(self._id, None)
            _hw.irq(self._id, 0)
        else:
            _irq_handlers[self._id] = (handler, self)
            _hw.irq(self._id, trigger)

class PWM:
    def __init__(self, pin, *, freq=None, duty_u16=None, duty_ns=None, invert=False):
        self._id = pin._id if isinstance(pin, Pin) else _pin_number(pin)
        _hw.pwm_init(self._id)
        if freq is not None:
            self.freq(freq)
        if duty_u16 is not None:
            self.duty_u16(duty_u16)
        if duty_ns is not None:
            self.duty_ns(duty_ns)

    def freq(self, f=None):
        if f is None:
            return _hw.pwm_freq(self._id)
        message = _hw.pwm_set_freq(self._id, f)
        if message:
            raise ValueError(message)

    def duty_u16(self, d=None):
        if d is None:
            return _hw.pwm_duty16(self._id)
        _hw.pwm_set_duty16(self._id, d)

    def duty_ns(self, ns=None):
        f = _hw.pwm_freq(self._id)
        if ns is None:
            return int(_hw.pwm_duty16(self._id) * 1000000000 // (65535 * f)) if f else 0
        self.duty_u16(int(ns * f * 65535 // 1000000000))

    def deinit(self):
        _hw.pwm_deinit(self._id)

class WDT:
    def __init__(self, id=0, timeout=5000):
        _hw.wdt_enable(timeout)

    def feed(self):
        _hw.wdt_feed()

PWRON_RESET = 1
WDT_RESET = 3
SOFT_RESET = 4

def reset_cause():
    cause = _hw.reset_cause()
    if cause == 1:
        return WDT_RESET
    if cause == 0:
        return SOFT_RESET
    return PWRON_RESET

def freq():
    return 125000000

def disable_irq():
    return _hw.irq_disable(True)      # returns the previous state, to be given back to enable_irq()

def enable_irq(state=False):
    _hw.irq_disable(bool(state))

def reset():
    _hw.reset(2)

def soft_reset():
    _hw.reset(0)

class _MachineModule:
    Pin = Pin
    PWM = PWM
    WDT = WDT
    PWRON_RESET = PWRON_RESET
    WDT_RESET = WDT_RESET
    SOFT_RESET = SOFT_RESET
    reset_cause = reset_cause
    freq = freq
    disable_irq = disable_irq
    enable_irq = enable_irq
    reset = reset
    soft_reset = soft_reset

sys.modules['machine'] = _MachineModule
`;
