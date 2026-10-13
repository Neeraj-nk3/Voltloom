/**
 * readout.js — human-readable electrical values for the properties popup (pure)
 */

export function formatCurrent(amps) {
  const x = Math.abs(amps);
  const sign = amps < 0 ? '-' : '';
  if (!Number.isFinite(x)) return '—';
  if (x >= 1) return `${sign}${x.toFixed(2)} A`;
  if (x >= 0.001) return `${sign}${(x * 1000).toFixed(2)} mA`;
  if (x >= 1e-6) return `${sign}${(x * 1e6).toFixed(1)} µA`;
  if (x >= 1e-9) return `${sign}${(x * 1e9).toFixed(1)} nA`;
  return '0 A';
}

export function formatVoltage(volts) {
  const x = Math.abs(volts);
  const sign = volts < 0 ? '-' : '';
  if (!Number.isFinite(x)) return '—';
  if (x >= 1) return `${sign}${x.toFixed(2)} V`;
  if (x >= 0.001) return `${sign}${(x * 1000).toFixed(1)} mV`;
  return '0 V';
}

export function formatPower(watts) {
  const x = Math.abs(watts);
  if (!Number.isFinite(x)) return '—';
  if (x >= 1) return `${x.toFixed(2)} W`;
  if (x >= 0.001) return `${(x * 1000).toFixed(2)} mW`;
  if (x >= 1e-6) return `${(x * 1e6).toFixed(1)} µW`;
  return '0 W';
}

/**
 * The line shown under "Properties" for a selected part, or '' when there is nothing to show.
 * @param {'led'|'resistor'|'button'} type  registry type name
 * @param {{current:number, voltage:number, power:number}|undefined} part  from evaluateBoard().parts
 */
export function readoutText(type, part) {
  if (!part) return '';
  if (type === 'led') return `${formatCurrent(part.current)} · ${formatVoltage(part.voltage)}`;
  if (type === 'resistor') return `${formatCurrent(part.current)} · ${formatVoltage(part.voltage)} · ${formatPower(part.power)}`;
  if (type === 'button') return `${formatCurrent(part.current)} · ${formatVoltage(part.voltage)}`;
  return '';
}
