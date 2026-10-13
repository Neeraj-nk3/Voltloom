import { describe, it, expect, beforeEach } from 'vitest';
import {
  gpioToSlice, gpioToChannel, setWrap, setLevel, setEnabled,
  getDutyCycle, isPwmActive, getSliceState, resetAll,
} from '../../../src/hardware/pwm-sim.js';

beforeEach(() => resetAll());

describe('pwm-sim', () => {
  it('maps GPIO to slice/channel like the RP2040 (slice = gpio/2, channel = gpio%2)', () => {
    expect(gpioToSlice(0)).toBe(0);  expect(gpioToChannel(0)).toBe(0);
    expect(gpioToSlice(15)).toBe(7); expect(gpioToChannel(15)).toBe(1);
    // RP2040: pwm_gpio_to_slice_num() is (gpio >> 1) & 7, so GP16..GP29 wrap onto slices 0..6
    expect(gpioToSlice(16)).toBe(0); expect(gpioToChannel(16)).toBe(0);
    expect(gpioToSlice(29)).toBe(6); expect(gpioToChannel(29)).toBe(1);
  });

  it('computes duty cycle as level / (wrap + 1) once enabled', () => {
    setWrap(2, 99); setLevel(2, 0, 25);
    expect(getDutyCycle(4)).toBe(0);          // not enabled yet
    setEnabled(2, true);
    expect(getDutyCycle(4)).toBeCloseTo(0.25);
    expect(isPwmActive(4)).toBe(true);
  });

  it('clamps wrap/level to 16 bits and caps duty at 1', () => {
    setWrap(0, 70000); setLevel(0, 0, 70000); setEnabled(0, true);
    expect(getSliceState(0).wrap).toBe(65535);
    expect(getDutyCycle(0)).toBeLessThanOrEqual(1);
  });

  it('ignores invalid slices/channels and resets cleanly', () => {
    expect(() => { setWrap(9, 1); setLevel(0, 5, 1); setEnabled(-1, true); }).not.toThrow();
    setWrap(0, 10); resetAll();
    expect(getSliceState(0).wrap).toBe(65535);
  });
});
