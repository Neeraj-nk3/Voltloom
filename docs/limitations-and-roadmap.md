# Limitations and roadmap

This page separates what works (and is tested), what is known not to work, what was deliberately deferred, and what is only an idea. If something is not listed as working, assume it is not.

## What Voltloom is not

- **Not an RP2040 emulator.** No ARM code runs. Programs call the Pico SDK / MicroPython API; the simulator updates virtual pins, solves the circuit and draws the result. Virtual time says nothing about how fast the same code would run at 125 MHz; only sleeps, pin reads and clock reads advance it.
- **Not a transient simulator.** The electrical model is DC only (no capacitors, inductors or switching edges), with typical rather than part-specific parameters ([electrical-model.md](electrical-model.md)).
- **Not a sandbox.** Programs run in Web Workers (so Stop always works), and the compile service has source checks, but neither is a security boundary for hostile code ([deployment-and-security.md](deployment-and-security.md)).

## Works today (each point is covered by tests)

- Wiring canvas with the Pico board, LEDs (10 colours), resistors, and a 4-pin push button; the solver gives each selected part its current, voltage and power; warnings for overcurrent, shorts, contention and unsolvable circuits.
- MicroPython (`machine.Pin`, `PWM`, `WDT`, `reset_cause`, `time`/`utime`) and C (GPIO incl. bulk calls and pulls, interrupts, PWM with frequency, watchdog, time helpers, simulated Wi-Fi and filesystem), on one shared hardware model; the exact lists are in [sdk-compatibility.md](sdk-compatibility.md).
- Run / Stop / re-Run / program-requested reset for both languages; Stop ends any program, including `while True: pass`.
- GPIO interrupts in both languages at the virtual time of the edge; a button press wakes a sleeping program.
- A virtual clock (real time in the UI, instant and repeatable in tests) and a deterministic scenario runner.
- Python breakpoint and step debugger.
- Project format v2 with migration from v1, share links, honest autosave, and an announced *Limited mode* on hosts without cross-origin isolation.
- Local C compile service with source checks.

## Known limitations

| Area | Limitation |
|---|---|
| Output pins | Reading an *output* pin returns the level the program wrote, not the pad voltage. An honest pad read would report 0 for a pin driving an LED through the 170 Ω pad model, which a real board does not do; fixing it needs a lower-resistance pad model and re-validation. |
| Two solvers | The page and the program's worker each solve the circuit with their own hysteresis memory; in the 0.8–2.0 V band the display and the program can briefly disagree. |
| Interrupts | Edges are seen only at *observation points* (sleep slices, pin or clock reads, program writes, circuit changes). A loop with none of these in its body never sees one; a pulse shorter than the gap between two such points is missed. Level interrupts fire once per transition, not continuously. `Pin.irq()` returns `None`; `hard`, `wake` and `priority` are ignored. |
| PWM | The LED uses the average duty at any frequency (no visible flicker); no phase-correct mode, counters or PWM interrupts. PWM into an input reads the more probable level. |
| Watchdog / reset | `watchdog_enable_caused_reboot()` equals `watchdog_caused_reboot()`; the numeric reset-cause values and `machine.reset()` reporting power-on are assumptions; timeouts clamp at 8388 ms. |
| Unsupported APIs | ADC, I2C, SPI, UART, PIO, DMA, `machine.Timer`, multicore, flash APIs, and Wi-Fi/network beyond simulated connect. Anything unlisted fails to compile or raises `AttributeError`. HTTP and MQTT were removed (they were never connected to programs). |
| Projects | One program text per project (the editor has one buffer); "Download" saves the program, not the circuit; a saved project that names a part which no longer exists is rejected as a whole. |
| Loops without sleeps | A program that never touches the clock cannot be paced by it. Stop, or `wallTimeoutMs` in the scenario runner, ends it. A worker does not answer messages while it sleeps or spins. |
| Browsers | Tested in Chromium only. Without cross-origin isolation the app runs Python in *Limited mode* (no live buttons, no interrupts, no debugger input) and refuses C. Safari and Firefox are untested; `credentialless` isolation support there is unverified. GitHub Pages cannot send the headers. |
| Network | The page loads Monaco and fonts from CDNs, so the editor needs internet access and cannot be used offline. |
| Platforms | Verified on Windows with Node 24.12 / 24.19 only. The CI workflow in `.github/workflows` has never run; Linux and macOS are unverified. |
| C++ | Not supported; the service compiles C only. |

## Deferred on purpose (not started)

New device subsystems (an I2C OLED display, a UART terminal), `machine.ADC/I2C/SPI/UART/Timer`, per-language sources in one project, a service-worker shim for hosts that cannot send headers, vendoring Monaco/fonts for offline use. Each of these is a new feature or a packaging change, not a correction, and was kept out of the cleanup and restructuring work.

## Ideas (no commitment)

- Make the display take the worker's pin readings, removing the two-solver discrepancy.
- A lower-resistance pad model so output reads can reflect pad voltage.
- Time-domain (transient) analysis for RC circuits.
- More parts (capacitor, potentiometer, buzzer) and a second board model.
- Self-hosted front-end assets, which would also allow strict cross-origin embedding rules.
