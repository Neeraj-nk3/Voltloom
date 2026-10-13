/**
 * pwm-frequency.js — turning a requested PWM frequency into a clock divider and a counter wrap (pure)
 *
 * Same method as MicroPython's rp2 `PWM.freq()`: start from divider*wrap = system clock / frequency, then move small
 * factors 5 and 3 (when they divide exactly) and 2 (always) from the divider into the counter while it still fits in
 * 16 bits, so the result is as close to the request as the hardware allows. The divider is kept in 1/16 steps (`div16`).
 * Where that method lands more than 0.5 % away from the request, the largest counter range that fits is used instead
 * (an addition: it keeps odd frequencies such as 7777 Hz accurate).
 *
 *   frequency = systemClock / (clkdiv * (wrap + 1)),    clkdiv = div16 / 16,    wrap + 1 = top
 */

import { PWM_SYSTEM_CLOCK_HZ } from '../../hardware/pwm-sim.js';

const TOP_MAX = 65535;

/** @returns {{ div16: number, top: number }}  top = wrap + 1. Throws RangeError('freq too large' | 'freq too small'). */
export function planFrequency(freqHz, sourceHz = PWM_SYSTEM_CLOCK_HZ) {
  if (!Number.isFinite(freqHz) || freqHz <= 0) throw new RangeError('freq must be positive');
  if ((sourceHz + freqHz / 2) / freqHz < 2) throw new RangeError('freq too large');
  let div16 = Math.floor((16 * sourceHz + freqHz / 2) / freqHz);
  let top = 1;
  for (;;) {
    if (div16 >= 16 * 5 && div16 % 5 === 0 && top * 5 <= TOP_MAX) { div16 /= 5; top *= 5; }
    else if (div16 >= 16 * 3 && div16 % 3 === 0 && top * 3 <= TOP_MAX) { div16 /= 3; top *= 3; }
    else if (div16 >= 16 * 2 && top * 2 <= TOP_MAX) { div16 = Math.floor(div16 / 2); top *= 2; }   // halving needs no exact fit
    else break;
  }
  if (div16 < 16) throw new RangeError('freq too large');

  // The factor method is exact for round frequencies but can be a few percent off for others. When it is, use the
  // largest counter range that fits instead (smallest divider, then the best top): within 1/top of the request.
  const achieved = (d, t) => (16 * sourceHz) / (d * t);
  if (div16 >= 256 * 16 || Math.abs(achieved(div16, top) - freqHz) / freqHz > 0.005) {
    const d = Math.max(16, Math.ceil((16 * sourceHz) / (freqHz * TOP_MAX)));
    const t = Math.max(1, Math.round((16 * sourceHz) / (d * freqHz)));
    if (d >= 256 * 16) throw new RangeError('freq too small');
    if (t <= TOP_MAX && Math.abs(achieved(d, t) - freqHz) <= Math.abs(achieved(div16, top) - freqHz)) return { div16: d, top: t };
    if (div16 >= 256 * 16) throw new RangeError('freq too small');
  }
  return { div16, top };
}

/** The compare level for a duty of `duty16` (0..65535, 65535 = always on) on a counter of `top` steps. */
export function levelForDuty16(duty16, top) {
  const clamped = Math.min(65535, Math.max(0, Math.round(duty16)));
  return Math.round((clamped * top) / 65535);
}

/** Inverse of levelForDuty16(): the duty (0..65535) a compare level corresponds to. */
export function duty16ForLevel(level, top) {
  return top === 0 ? 0 : Math.min(65535, Math.round((level * 65535) / top));
}
