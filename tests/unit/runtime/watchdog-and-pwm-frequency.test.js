import { describe, it, expect } from 'vitest';
import { WatchdogTimer, WATCHDOG_MAX_MS } from '../../../src/runtime/common/watchdog.js';
import { planFrequency, levelForDuty16, duty16ForLevel } from '../../../src/runtime/common/pwm-frequency.js';
import { PwmEngine, PWM_SYSTEM_CLOCK_HZ } from '../../../src/hardware/pwm-sim.js';
import { WorkerPins } from '../../../src/runtime/common/pin-model.js';
import { VirtualClock } from '../../../src/clock/virtual-clock.js';
import { EVENT } from '../../../src/worker-protocol/protocol.js';

describe('watchdog', () => {
  const setup = () => {
    const clock = new VirtualClock({ mode: 'fast' });
    const expired = [];
    const wd = new WatchdogTimer(clock, () => expired.push(clock.nowUs()));
    wd.attachTo(clock);
    return { clock, wd, expired };
  };

  it('does nothing until enabled; once enabled it expires at exactly the deadline on the virtual timeline', () => {
    const { clock, wd, expired } = setup();
    clock.sleepUs(5_000_000);
    expect(expired).toEqual([]);
    wd.enable(1000);
    clock.sleepUs(900_000);
    expect(expired).toEqual([]);
    clock.sleepUs(500_000);
    expect(expired).toEqual([5_000_000 + 1_000_000]);          // not 1.4 s later: the sleep was stopped at the deadline
  });

  it('feeding restarts the countdown; stopping feeding lets it expire exactly one period after the last feed', () => {
    const { clock, wd, expired } = setup();
    wd.enable(1000);
    for (let i = 0; i < 3; i++) { clock.sleepUs(600_000); wd.feed(); }
    clock.sleepUs(5_000_000);
    expect(expired).toEqual([1_800_000 + 1_000_000]);
  });

  it('expires only once, cannot be switched off, and a scheduled reboot cannot be fed away', () => {
    const { clock, wd, expired } = setup();
    wd.enable(100);
    clock.sleepUs(1_000_000);
    expect(expired).toHaveLength(1);
    const second = setup();
    second.wd.schedule(500);
    second.clock.sleepUs(300_000); second.wd.feed(); second.clock.sleepUs(300_000);
    expect(second.expired).toEqual([500_000]);
  });

  it('timeouts above the hardware limit are clamped, nonsense becomes the minimum', () => {
    const { wd } = setup();
    expect(wd.enable(100_000)).toBe(WATCHDOG_MAX_MS);
    expect(wd.enable(-5)).toBe(1);
    expect(wd.enable(NaN)).toBe(1);
  });
});

describe('PWM frequency planning (same method as MicroPython rp2 PWM.freq)', () => {
  const frequencyOf = ({ div16, top }) => PWM_SYSTEM_CLOCK_HZ * 16 / (div16 * top);

  it.each([[1000, 32, 62500], [50, 640, 62500], [1_000_000, 16, 125], [10_000, 16, 12500], [100, 320, 62500]])(
    '%i Hz -> div16 %i, top %i, and the achieved frequency equals the request', (hz, div16, top) => {
      const plan = planFrequency(hz);
      expect(plan).toEqual({ div16, top });
      expect(frequencyOf(plan)).toBeCloseTo(hz, 6);
    });

  it('frequencies that are not exact are within the hardware resolution', () => {
    for (const hz of [333, 440, 1234, 2000, 7777, 20_000]) {
      const plan = planFrequency(hz);
      expect(Math.abs(frequencyOf(plan) - hz) / hz).toBeLessThan(0.01);
      expect(plan.top).toBeLessThanOrEqual(65535);
      expect(plan.div16).toBeGreaterThanOrEqual(16);
      expect(plan.div16).toBeLessThan(256 * 16);
    }
  });

  it('too fast or too slow is an error with the MicroPython wording', () => {
    expect(() => planFrequency(100_000_000)).toThrow('freq too large');
    expect(() => planFrequency(0.5)).toThrow('freq too small');
    expect(() => planFrequency(0)).toThrow();
    expect(() => planFrequency(NaN)).toThrow();
  });

  it('duty conversion: 65535 is always on, 0 always off, and it round-trips', () => {
    expect(levelForDuty16(65535, 1000)).toBe(1000);
    expect(levelForDuty16(0, 1000)).toBe(0);
    expect(levelForDuty16(32768, 1000)).toBe(500);
    expect(levelForDuty16(99999, 1000)).toBe(1000);
    expect(duty16ForLevel(500, 1000)).toBe(32768);
    expect(duty16ForLevel(1000, 1000)).toBe(65535);
  });
});

describe('PwmEngine clock divider and frequency', () => {
  it('frequency = 125 MHz / (clkdiv * (wrap + 1)) for an enabled slice, 0 otherwise', () => {
    const pwm = new PwmEngine();
    expect(pwm.getFrequencyHz(14)).toBe(0);
    pwm.setWrap(7, 999); pwm.setEnabled(7, true);
    expect(pwm.getFrequencyHz(14)).toBeCloseTo(125_000, 6);                  // default divider 1
    pwm.setClkdiv(7, 125);
    expect(pwm.getFrequencyHz(14)).toBeCloseTo(1000, 6);
    pwm.setEnabled(7, false);
    expect(pwm.getFrequencyHz(14)).toBe(0);
  });

  it('the divider is limited to 1..255.9375 and rounded to 1/16 steps; junk is ignored', () => {
    const pwm = new PwmEngine();
    pwm.setClkdiv(0, 0.1); expect(pwm.getSliceState(0).clkdiv).toBe(1);
    pwm.setClkdiv(0, 9999); expect(pwm.getSliceState(0).clkdiv).toBe(255.9375);
    pwm.setClkdiv(0, 2.57); expect(pwm.getSliceState(0).clkdiv).toBe(2.5625);
    pwm.setClkdiv(0, NaN); expect(pwm.getSliceState(0).clkdiv).toBe(2.5625);
  });
});

describe('WorkerPins machine.PWM helpers', () => {
  const make = () => {
    const events = [];
    const pins = new WorkerPins((e) => events.push(e));
    return { pins, events };
  };

  it('setting a frequency programs divider and wrap, keeps the duty, starts the slice, and reports it all to the main thread', () => {
    const { pins, events } = make();
    pins.pwmInit(15);
    pins.pwmSetDuty16(15, 32768);
    pins.pwmSetFreq(15, 1000);
    expect(pins.pwmFreq(15)).toBe(1000);
    expect(pins.pwmDuty16(15)).toBe(32768);
    expect(events.filter((e) => e.type === EVENT.PWM).map((e) => e.op)).toContain('clkdiv');
    const clkdiv = events.filter((e) => e.type === EVENT.PWM && e.op === 'clkdiv').at(-1);
    expect(clkdiv.value).toBe(2);
  });

  it('changing the frequency afterwards keeps the duty', () => {
    const { pins } = make();
    pins.pwmInit(15); pins.pwmSetFreq(15, 1000); pins.pwmSetDuty16(15, 16384);
    pins.pwmSetFreq(15, 50);
    expect(pins.pwmFreq(15)).toBe(50);
    expect(Math.abs(pins.pwmDuty16(15) - 16384)).toBeLessThanOrEqual(2);
  });

  it('a bad frequency throws the MicroPython-style message and changes nothing', () => {
    const { pins } = make();
    pins.pwmInit(15); pins.pwmSetFreq(15, 1000);
    expect(() => pins.pwmSetFreq(15, 1e9)).toThrow('freq too large');
    expect(pins.pwmFreq(15)).toBe(1000);
  });

  it('deinit sets the duty to 0 and stops the slice when nothing else uses it', () => {
    const { pins } = make();
    pins.pwmInit(14); pins.pwmSetFreq(14, 1000); pins.pwmSetDuty16(14, 40000);
    pins.pwmInit(15); pins.pwmSetDuty16(15, 40000);        // GP14 and GP15 share slice 7
    pins.pwmDeinit(14);
    expect(pins.pwmDuty16(14)).toBe(0);
    expect(pins.pwmFreq(14)).toBeGreaterThan(0);           // GP15 still running on that slice
    pins.pwmDeinit(15);
    expect(pins.pwmFreq(14)).toBe(0);
  });
});
