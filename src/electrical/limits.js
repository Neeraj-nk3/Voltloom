/**
 * limits.js — configurable electrical limits and the warnings derived from a solved circuit (pure)
 *
 * Every limit has a documented default and a source. Callers pass overrides to `resolveLimits()`; unknown
 * names and nonsensical values are rejected, so a typo cannot silently disable a check. A limit can be
 * switched off with `null`.
 *
 * `analyze(circuit, result, limits)` is generic: it knows about LEDs, resistors, and any source or
 * source group that declares a rating. Pico-specific rules (which sources are GPIO pads, drive strength
 * per pad, contention) are applied by the netlist builder, which passes the ratings in the circuit.
 */

export const DEFAULT_LIMITS = Object.freeze({
  /** LED continuous current above which we warn. Typical 5 mm LED absolute maximum: 20 mA. */
  ledWarnAmps: 0.020,
  /** LED current at which we say the part "would be destroyed". Typical surge rating region: 30 mA+. */
  ledDestroyAmps: 0.030,
  /** Resistor power rating. 1/4 W is the common hobby part. */
  resistorWatts: 0.25,
});

const NAMES = Object.keys(DEFAULT_LIMITS);

export function resolveLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [name, value] of Object.entries(overrides || {})) {
    if (!NAMES.includes(name)) throw new RangeError(`unknown electrical limit "${name}" (known: ${NAMES.join(', ')})`);
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      throw new RangeError(`limit "${name}" must be a positive finite number or null (got ${value})`);
    }
    limits[name] = value;
  }
  if (limits.ledWarnAmps !== null && limits.ledDestroyAmps !== null && limits.ledDestroyAmps < limits.ledWarnAmps) {
    throw new RangeError('ledDestroyAmps must not be below ledWarnAmps');
  }
  return limits;
}

/** 0.0362 -> "36.2 mA", 13.2 -> "13.2 A", 0.0003 -> "0.30 mA". */
export function formatAmps(a) {
  const x = Math.abs(a);
  if (x >= 1) return `${x.toFixed(1)} A`;
  if (x >= 0.01) return `${(x * 1000).toFixed(1)} mA`;
  return `${(x * 1000).toFixed(2)} mA`;
}

export function formatWatts(w) {
  return `${Math.abs(w).toFixed(2)} W`;
}

/**
 * Source ratings: a source element may carry `ratedAmps` (its own limit), `absoluteMaxAmps` (beyond which it is
 * out of spec) and `label` (display name); more than 10x `ratedAmps` is reported as a short circuit.
 * Groups: `circuit.groups = [{ id, label, members: [sourceId...], maxAmps, direction: 'source'|'sink' }]`
 * checks the SUM of members' sourced (or sunk) current, e.g. the RP2040's 50 mA total across all pads.
 * `label` on LEDs/resistors is the display name ("LED 1", "Resistor 3"); it defaults to the type and id.
 *
 * Returns [{ code, severity: 'error'|'warning', subject, value, limit, message }], most severe first.
 */
export function analyze(circuit, result, limits = DEFAULT_LIMITS) {
  const warnings = [];
  if (!result.ok) {
    return [{ code: 'unsolvable', severity: 'error', subject: null, value: null, limit: null,
      message: 'This circuit could not be solved; showing the last valid state.' }];
  }
  const name = (e) => e.label || `${e.type === 'led' ? 'LED' : e.type === 'resistor' ? 'Resistor' : e.type} ${e.id}`;

  for (const e of circuit.elements) {
    const r = result.elements[e.id];
    if (e.type === 'led') {
      const amps = r.current;
      if (limits.ledDestroyAmps !== null && amps > limits.ledDestroyAmps) {
        warnings.push({ code: 'led-destroyed', severity: 'error', subject: e.id, value: amps, limit: limits.ledDestroyAmps,
          message: `${name(e)} carries ${formatAmps(amps)} and would be destroyed. Add a series resistor.` });
      } else if (limits.ledWarnAmps !== null && amps > limits.ledWarnAmps) {
        warnings.push({ code: 'led-overcurrent', severity: 'warning', subject: e.id, value: amps, limit: limits.ledWarnAmps,
          message: `${name(e)} carries ${formatAmps(amps)} (rating ${formatAmps(limits.ledWarnAmps)}). Add or increase a series resistor.` });
      }
    } else if (e.type === 'resistor') {
      if (limits.resistorWatts !== null && r.power > limits.resistorWatts) {
        warnings.push({ code: 'resistor-power', severity: 'warning', subject: e.id, value: r.power, limit: limits.resistorWatts,
          message: `${name(e)} dissipates ${formatWatts(r.power)} (rated ${formatWatts(limits.resistorWatts)}).` });
      }
    } else if (e.type === 'source' && typeof e.ratedAmps === 'number') {
      const amps = Math.abs(r.current);
      const verb = r.current < 0 ? 'sinks' : 'supplies';
      if (amps > e.ratedAmps * 10) {
        warnings.push({ code: 'source-short', severity: 'error', subject: e.id, value: amps, limit: e.ratedAmps,
          message: `${name(e)} is short-circuited (${formatAmps(amps)}, rated ${formatAmps(e.ratedAmps)}).` });
      } else if (typeof e.absoluteMaxAmps === 'number' && amps > e.absoluteMaxAmps) {
        warnings.push({ code: 'source-over-max', severity: 'error', subject: e.id, value: amps, limit: e.absoluteMaxAmps,
          message: `${name(e)} ${verb} ${formatAmps(amps)}, above its ${formatAmps(e.absoluteMaxAmps)} absolute maximum.` });
      } else if (amps > e.ratedAmps) {
        warnings.push({ code: 'source-overload', severity: 'warning', subject: e.id, value: amps, limit: e.ratedAmps,
          message: `${name(e)} ${verb} ${formatAmps(amps)} (rated ${formatAmps(e.ratedAmps)}).` });
      }
    }
  }

  for (const g of circuit.groups || []) {
    let total = 0;
    for (const id of g.members) {
      const amps = result.elements[id] ? result.elements[id].current : 0;
      total += g.direction === 'sink' ? Math.max(0, -amps) : Math.max(0, amps);
    }
    if (total > g.maxAmps) {
      warnings.push({ code: 'group-overload', severity: 'warning', subject: g.id, value: total, limit: g.maxAmps,
        message: `Total ${g.direction === 'sink' ? 'sink' : 'source'} current through ${g.label || g.id} is ${formatAmps(total)} (limit ${formatAmps(g.maxAmps)}).` });
    }
  }

  const rank = { error: 0, warning: 1 };
  return warnings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
