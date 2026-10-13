# Examples

Everything in `examples/` runs, and a test keeps it honest: `tests/scenario/examples.test.js` runs every example on the real firmware runtimes and circuit solver and compares the result with the behaviour recorded in [`examples/examples.json`](../examples/examples.json). An example that is not listed there, or stops doing what is listed, fails the test. (The C examples need Emscripten; without it they are skipped, not passed.)

```
examples/
  python/     seven MicroPython programs
  c/          three C programs
  projects/   one ready-to-open project per program (code + circuit), generated from the two folders above
  examples.json   program, circuit, scripted button presses, and the expected behaviour of each example
```

## Circuits

The first two circuits use the red LED (a typical forward voltage of 1.9 V at 10 mA is assumed) and a 330 Ω resistor.

| Circuit | Wiring |
|---|---|
| `led` | GP15 (pin 20) → 330 Ω → LED anode; LED cathode → GND (pin 3) |
| `led-button` | the `led` circuit, plus a push button between GP0 (pin 1) and GND (pin 3) |
| `traffic-light` | three rows, each a header pin → 220 Ω → LED anode, LED cathode → the GND pin just above: GP22 (pin 29) → red → GND (pin 33), GP19 (pin 25) → yellow → GND (pin 28), GP16 (pin 21) → green → GND (pin 23) |

With this wiring the solver gives about **3 mA** through the LED when GP15 is high, which the app draws as a clearly lit LED. Change the resistor and the current, the LED brightness and the readout change with it.

## The examples

| Example | Language | Circuit | What it does | What the test checks |
|---|---|---|---|---|
| `python-blink` | Python | `led` | toggles GP15 every 0.5 s | in 2.2 s of virtual time GP15 goes 1, 0, 1, 0, 1; the LED is lit at the end |
| `python-button-led` | Python | `led-button` | polls the button; the LED follows it | button pressed at 1 s and released at 2 s: GP15 goes 0, 1, 0; LED dark at the end |
| `python-button-irq` | Python | `led-button` | `Pin.irq` falling-edge handler toggles the LED and prints the count | two presses print `press 1`, `press 2`; the LED ends dark (toggled twice) |
| `python-pwm-fade` | Python | `led` | `PWM` duty ramps 0 → 65535 in nine steps | prints the nine duty values and `done`; the program exits; LED lit at the end (full duty) |
| `python-watchdog-reset` | Python | `led` | feeds a 1 s watchdog three times, then stops; the board resets | two boots; the second prints `restarted by the watchdog`; LED off after the reset |
| `python-traffic-light` | Python | `traffic-light` | a traffic light: red, red + yellow, green, yellow, repeating | in 5.5 s prints `Light: red`, `Light: red + yellow`, `Light: green`, `Light: yellow`; the red LED is off at the end |
| `python-serial-hello` | Python | `led` | prints `hello 1` … `hello 5` once a second, then `done` | those six lines; the program exits |
| `c-blink` | C | `led` | the C blink program (prints a line per toggle) | GP15 goes 1, 0, 1, 0, 1 and the program prints the same markers each run |
| `c-button-irq` | C | `led-button` | `gpio_set_irq_enabled_with_callback` on a falling edge | same behaviour as the Python version |
| `c-pwm-fade` | C | `led` | `pwm_set_gpio_level` ramp on GP15 | prints nine levels and `done`; LED lit at the end |

The times are **virtual** time: the scenario runner does not wait, so the whole table is checked in a few seconds, and the same inputs always give the same result. In the browser the same programs run in real time.

## Running an example

**In the app.** Print the link for the example's project and open it:

```bash
npm run dev
node scripts/share-link.mjs examples/projects/python-button-irq.project.json
```

The link contains the code and the circuit. Press **Run**; for the button examples click the button on the canvas. (C examples also need `npm run compiler` and Emscripten.)

**Headlessly.** `npm run demo` runs every example and prints, for each, the console output, the changes of GP15 and the LED state at the end, using the button presses listed in the manifest. `npm run demo -- --json` prints the same as JSON; two runs are byte-identical.

**As tests.** `npx vitest run tests/scenario/examples.test.js`.

## Adding an example

1. Put the program in `examples/python/` or `examples/c/`.
2. Add an entry to `examples/examples.json` (id, file, circuit, `untilMs`, optional `script` of button presses, `summary`). Run `npm run demo` and read the output: does it show what the program *should* do? Only then record it as `expect`.
3. Run `npm run examples:build` to write `examples/projects/<id>.project.json`, and `npm run examples:check` to confirm nothing is stale.
4. Run the examples test. Use only APIs listed in [sdk-compatibility.md](sdk-compatibility.md).
