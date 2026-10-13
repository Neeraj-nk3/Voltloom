/**
 * board-params.js — the electrical parameters of the Pico board model (pure)
 *
 * Every number the board model uses is here, with its source. [datasheet] values come from the RP2040
 * datasheet (GPIO pad characteristics); [assumed] values are this project's choices and are the first
 * thing to revisit if the model is ever compared with a real board. All can be overridden with
 * `resolveBoardParams({ name: value })`; unknown names and invalid values are rejected.
 */

export const BOARD_DEFAULTS = Object.freeze({
  // --- power rails (USB-powered board assumed) ---
  rail3v3Volts: 3.3,      // [datasheet] regulator output
  rail3v3Ohms: 0.2,       // [assumed]   output resistance of the regulator, wiring and pin
  rail3v3MaxAmps: 0.300,  // [assumed]   board-level limit used for overload warnings
  vbusVolts: 5.0,         // [assumed]   USB 5 V
  vbusOhms: 0.1,          // [assumed]
  vbusMaxAmps: 0.500,     // [assumed]   USB 2.0 limit
  vsysVolts: 4.7,         // [assumed]   VBUS minus the Schottky diode drop
  vsysOhms: 0.3,          // [assumed]
  vsysMaxAmps: 0.500,     // [assumed]

  // --- GPIO output stage (resistance of the pad driver while driving) ---
  padHighOhms: 170,       // [derived]   VOH >= 2.62 V at 4 mA from 3.3 V (datasheet worst case): (3.3-2.62)/4 mA
  padLowOhms: 100,        // [derived]   VOL <= 0.4 V at 4 mA (datasheet worst case): 0.4/4 mA
  padDriveAmps: 0.004,    // [datasheet] default drive strength (selectable 2/4/8/12 mA per pad)
  padAbsoluteMaxAmps: 0.012, // [datasheet] highest drive-strength setting; above this is outside the spec
  gpioTotalAmps: 0.050,   // [datasheet] sum of all GPIO source (or sink) currents

  // --- GPIO input ---
  pullOhms: 65000,        // [datasheet] internal pull-up/down 50-80 kohm, mid-value
  readHighVolts: 2.0,     // [datasheet] VIH (Schmitt trigger) with 3.3 V IO
  readLowVolts: 0.8,      // [datasheet] VIL

  // --- push button ---
  buttonOhms: 0.1         // [assumed]   closed-contact resistance
});

const NAMES = Object.keys(BOARD_DEFAULTS);
export const DRIVE_STRENGTHS_AMPS = Object.freeze([0.002, 0.004, 0.008, 0.012]);

export function resolveBoardParams(overrides = {}) {
  const params = { ...BOARD_DEFAULTS };
  for (const [name, value] of Object.entries(overrides || {})) {
    if (!NAMES.includes(name)) throw new RangeError(`unknown board parameter "${name}"`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(`board parameter "${name}" must be a positive finite number (got ${value})`);
    }
    params[name] = value;
  }
  if (params.readLowVolts >= params.readHighVolts) throw new RangeError('readLowVolts must be below readHighVolts');
  if (params.padDriveAmps > params.padAbsoluteMaxAmps) throw new RangeError('padDriveAmps must not exceed padAbsoluteMaxAmps');
  return params;
}
