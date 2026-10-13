/**
 * led-model.js — LED electrical model and the display brightness heuristic (pure)
 *
 * The LED is a 5 ohm series resistance plus an ideal-diode (Shockley) curve whose saturation current is
 * fitted so that the LED drops `vf` volts at 10 mA. All forward voltages below are TYPICAL values for
 * common 5 mm LEDs: ASSUMPTIONS, not data for any particular part. They are the one place to change them.
 */

const THERMAL_VOLTAGE = 0.025852; // kT/q at 300 K
const IDEALITY = 2.0;             // typical for visible LEDs
const REFERENCE_AMPS = 0.010;     // the current at which `vf` is specified
export const LED_SERIES_OHMS = 5;

/** Forward voltage at 10 mA, keyed by the swatch colours the app offers. */
export const LED_FORWARD_VOLTS = Object.freeze({
  '#ef4444': 1.9,  // red
  '#22c55e': 2.1,  // green
  '#3b82f6': 3.0,  // blue
  '#facc15': 2.05, // yellow
  '#f97316': 2.0,  // orange
  '#a855f7': 3.0,  // purple
  '#ec4899': 3.0,  // pink
  '#22d3ee': 3.0,  // cyan
  '#ffffff': 3.1,  // white
  '#a3e635': 2.1   // lime
});
export const DEFAULT_LED_FORWARD_VOLTS = 2.0; // used for a colour that is not in the table

/** Diode parameters {is, nVt, rs} giving `vf` volts at 10 mA. */
export function ledModel(vf = DEFAULT_LED_FORWARD_VOLTS) {
  if (!Number.isFinite(vf) || vf <= 0.5 || vf > 6) throw new RangeError(`LED forward voltage ${vf} V is not plausible`);
  const nVt = IDEALITY * THERMAL_VOLTAGE;
  const is = REFERENCE_AMPS / (Math.exp((vf - REFERENCE_AMPS * LED_SERIES_OHMS) / nVt) - 1);
  return { is, nVt, rs: LED_SERIES_OHMS };
}

export function ledModelForColor(color) {
  return ledModel(Object.prototype.hasOwnProperty.call(LED_FORWARD_VOLTS, color) ? LED_FORWARD_VOLTS[color] : DEFAULT_LED_FORWARD_VOLTS);
}

export const BRIGHTNESS_FULL_AMPS = 0.010; // 10 mA shows as full brightness
export const BRIGHTNESS_OFF_BELOW_AMPS = 0.00002; // under 0.02 mA the LED is drawn dark

/**
 * DISPLAY HEURISTIC, not photometry: light output is roughly linear in current and perception is roughly
 * a square root of it, so brightness = sqrt(I / 10 mA), clamped to 0..1, and 0 below 0.02 mA.
 */
export function ledBrightness(amps) {
  if (!Number.isFinite(amps) || amps < BRIGHTNESS_OFF_BELOW_AMPS) return 0;
  return Math.min(1, Math.sqrt(amps / BRIGHTNESS_FULL_AMPS));
}
