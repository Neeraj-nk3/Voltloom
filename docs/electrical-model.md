# Electrical model

Voltloom solves the circuit you draw as a **DC operating point**: the steady voltages and currents when everything has settled. That is why a resistor's value changes how bright an LED is, why two outputs wired together fight, and why a button to GND needs a pull-up. The model is deliberately small, and every number in it has a stated source. Where a number is an assumption it says so, here and in the code (`src/electrical/board-params.js`, `led-model.js`, `limits.js`).

## What is solved

- **Method.** Modified Nodal Analysis; the LED's diode curve is handled with Newton–Raphson using SPICE-style tolerances, junction-voltage limiting, and *gmin stepping* then *source stepping* when plain Newton fails (`solver.js`). If no solution is found the circuit is reported as unsolvable (a warning in the app); the previous good answer is kept for reads.
- **Wires are ideal.** A wire merges two pins into one node. All GND pins are node 0.
- **Elements.** Resistors (their real value), LEDs, push buttons (a switch with a closed-contact resistance), the 3V3 / VBUS / VSYS rails (a source behind a resistance), and every GPIO pad.
- **GPIO pad.** Driving high: 3.3 V behind the pad's high resistance. Driving low: 0 V behind its low resistance. Input: the internal pull resistor to 3.3 V or to GND if a pull is on, otherwise nothing. PWM: a pad with a duty between 0 and 1 is solved once high and once low and the results are weighted by the duty (exact for networks of resistors, LEDs and switches; up to three PWM pads are combined as independent phases, any more are treated as constant at the rounded duty). LED and resistor values and warnings use these time averages.
- **Reading a pad as an input.** The pad voltage is compared with 2.0 V (high) and 0.8 V (low) with hysteresis; in between, the last answer is kept. This is the rule the program sees in both Python and C.

## Parameters and their sources

`[datasheet]` = taken or derived from the RP2040 datasheet GPIO characteristics; `[assumed]` = this project's choice; `[derived]` = computed from datasheet worst cases.

| Parameter | Value | Source |
|---|---|---|
| 3V3 rail | 3.3 V behind 0.2 Ω, board limit 300 mA | 3.3 V [datasheet]; 0.2 Ω and 300 mA [assumed] |
| VBUS | 5.0 V behind 0.1 Ω, 500 mA | [assumed] (USB 2.0 limit) |
| VSYS | 4.7 V behind 0.3 Ω, 500 mA | [assumed] (VBUS minus a Schottky drop) |
| Pad driving high | 170 Ω | [derived] VOH ≥ 2.62 V at 4 mA from 3.3 V |
| Pad driving low | 100 Ω | [derived] VOL ≤ 0.4 V at 4 mA |
| Default pad drive | 4 mA (selectable 2 / 4 / 8 / 12 mA) | [datasheet] |
| Sum of all GPIO currents | 50 mA | [datasheet] |
| Internal pull resistor | 65 kΩ | [datasheet] range 50–80 kΩ, mid-value |
| Input thresholds | VIH 2.0 V, VIL 0.8 V | [datasheet] (Schmitt trigger, 3.3 V I/O) |
| Closed button | 0.1 Ω | [assumed] |
| LED | 5 Ω series + Shockley diode with ideality 2.0, fitted to the forward voltage at 10 mA | model [assumed] |
| LED forward voltage at 10 mA | red 1.9 V, orange 2.0 V, yellow 2.05 V, green 2.1 V, lime 2.1 V, blue / purple / pink / cyan 3.0 V, white 3.1 V (default 2.0 V) | typical 5 mm LEDs [assumed]; **not data for any particular part** |

All of the board parameters can be overridden in code with `resolveBoardParams({ name: value })`; unknown names and invalid values are rejected, so a typo cannot silently change the model.

## Warnings and limits

| Warning | Condition (defaults) |
|---|---|
| LED overcurrent | LED current above **20 mA** (typical 5 mm LED maximum) |
| LED destroyed | LED current above **30 mA** |
| Resistor power | dissipation above **0.25 W** (a ¼ W part) |
| Source overload / over max / short | a pad above its drive strength; above the 12 mA absolute maximum; a rail or pad driven into a short |
| GPIO group overload | all GPIOs together above 50 mA |
| Contention (error) | two drivers on one net at opposite levels |
| Unsolvable | the solver found no operating point |

Limits are configurable (`resolveLimits`) and can be switched off with `null`. They are *warnings with numbers*, not a promise that a real part would survive or fail at exactly that value.

## LED brightness

Brightness on screen is a display heuristic, not photometry: `brightness = sqrt(I / 10 mA)`, clamped to 0–1, and 0 below 0.02 mA. It is monotonic in current, which is what matters for seeing a larger resistor dim the LED.

## Approximations and limits

- DC only: no capacitors, inductors, switching transients, or PWM edge effects. A PWM duty is treated as an average.
- One operating point per change, not a time-domain simulation.
- The output-pin read rule: reading an *output* pin returns the level the program wrote, not the pad voltage (this matches the usual idiom, but a shorted output reads as what was written).
- The page and the worker each run their own solver with their own hysteresis memory, so in the 0.8–2.0 V band the display and the program can briefly disagree.
- Typical, not part-specific, parameters: use the numbers for relative behaviour (a bigger resistor dims the LED), not as a substitute for a datasheet.
