/**
 * pico-pins.js — what each header pin of the Pico IS electrically (pure)
 *
 *   ground      the GND pins (all one node)
 *   rail        3V3(OUT), VBUS, VSYS: a voltage source behind a resistance
 *   gpio        GP0..GP28 (including the ADC-capable ones): a pad with an output stage and a pull
 *   unmodelled  3V3_EN, ADC_VREF, RUN: nothing is driven onto or read from these (limitation, behaviour change B7)
 */

import { LEFT_PINS, RIGHT_PINS } from '../circuit/board-pin-layout.js';

const BY_PHYSICAL = new Map([...LEFT_PINS, ...RIGHT_PINS].map((p) => [p.pin, p]));
const RAIL_LABELS = new Set(['3V3(OUT)', 'VBUS', 'VSYS']);

/** @returns {{kind:'ground'|'rail'|'gpio'|'unmodelled', label:string, gpio?:number}|null} null for an unknown pin. */
export function classifyPhysicalPin(physical) {
  const def = BY_PHYSICAL.get(Number(physical));
  if (!def) return null;
  if (def.type === 'Ground') return { kind: 'ground', label: def.label };
  if (RAIL_LABELS.has(def.label)) return { kind: 'rail', label: def.label };
  if (def.type === 'GPIO' || def.type === 'ADC0' || def.type === 'ADC1' || def.type === 'ADC2') {
    return { kind: 'gpio', label: def.label, gpio: Number(def.label.slice(2)) };
  }
  return { kind: 'unmodelled', label: def.label };
}

/** Physical pin number of GPn, or null. */
export function physicalPinOfGpio(gpio) {
  for (const [physical, def] of BY_PHYSICAL) if (def.label === `GP${gpio}`) return physical;
  return null;
}

/** GPIO numbers present on the header, ascending. */
export function headerGpios() {
  return [...BY_PHYSICAL.values()].filter((d) => /^GP\d+$/.test(d.label)).map((d) => Number(d.label.slice(2))).sort((a, b) => a - b);
}
