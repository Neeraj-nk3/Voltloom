# Timing and simulation: the virtual clock and the scenario runner

## The clock (`src/clock/virtual-clock.js`)

A running program does not see the browser's clock. It sees a **program-owned virtual clock**, in microseconds since
the program started. Only the program moves it:

| What the program does | Effect on the virtual clock |
|---|---|
| `sleep_ms(n)`, `sleep_us(n)`, `busy_wait_us(n)`, `time.sleep*()` | advances by exactly the requested time |
| reads a pin (`gpio_get`, `Pin.value()`) | advances by 1 µs |
| reads the clock (`time_us_64()`, `time.ticks_ms()`, `time.time()` …) | advances by 1 µs |

The 1 µs read cost is what makes busy-wait loops (`while (!gpio_get(0)) {}`, `while ticks_diff(...) < 50`) always
make progress and always end at the same virtual time.

Two modes run the **same timeline**:

* **`realtime`** (the UI default): a sleep waits until the wall clock reaches the virtual time, so you watch the
  program at real speed and a 500 ms blink really is 500 ms with no drift (time spent computing counts towards the
  sleep). If the wall clock gets far ahead (a long computation, a debugger pause) the clock jumps forward instead of
  replaying the backlog.
* **`fast`** (tests, the scenario runner): nothing waits. Ten virtual seconds take milliseconds and produce the
  identical trace every time.

A sleep is not one jump: it proceeds in **slices** that end at the next *wake point* (a scripted input, a watchdog
deadline, the scenario's time limit) or at the end of the sleep, and after every slice (and every read) the **interrupt
hook** runs. That is how a GPIO interrupt handler runs at the virtual time of its edge in the middle of a sleep. In
`realtime` mode the wait also ends early when the main thread publishes a circuit change (a button press), so a sleeping
program reacts at once instead of after its sleep.

Stop is `Worker.terminate()`, which also ends a worker that is blocked in a sleep: the clock never has to cooperate.
Pending console events are flushed before a worker blocks, so output printed just before a long sleep is shown at once.

### Python and C
* **C**: `sleep_*` and `time_us_64` are plain blocking calls into the clock (`compiler/sdk/src/time.c`). There is no
  Asyncify any more, so the compiled program is smaller and never yields.
* **Python**: the attributes of `time` are replaced (`sleep`, `sleep_ms`, `sleep_us`, `ticks_ms`, `ticks_us`,
  `ticks_cpu`, `time`, `time_ns`, `localtime()`/`gmtime()` without an argument) and `sys.modules['utime']` points at
  the same module. `ticks_diff` and `ticks_add` are pure arithmetic and unchanged. Virtual `time.time()` starts at a
  fixed epoch (2025-01-01 UTC, an arbitrary choice) so runs are repeatable.

The mode of the next run is `SimulatorBridge.clockMode` (`'realtime'` by default; browser tests set `'fast'`).

## The scenario runner (`src/scenario/runner.js`, Node)

```js
const result = await runScenario({
  language: 'python',                  // or 'c' (needs the Emscripten compiler)
  code,
  components, connections,             // the circuit, in the saved-project format
  script: [{ atMs: 1000, button: 'btn_1', pressed: true },
           { atMs: 2000, resistor: 'res_1', value: 10, unit: 1000 }],
  untilMs: 3000,                       // virtual-time budget
});
result.trace        // [{ tUs, type, ... }] every event, with its virtual time
result.stdout       // printed lines
result.electrical   // the circuit solved at the end: LED currents, pad voltages, warnings
result.ended        // 'limit' | 'exit' | 'reset' | 'error' | 'timeout' | 'compile-error'
```

The program runs in a Node worker thread on the same firmware runtimes as the browser (`runtime/python/runtime.js` and
`runtime/c/runtime.js`, the same pin and electrical model). Scripted inputs are applied **by the clock itself**, in time order,
before the program resumes from whatever advanced the clock, so a program can never observe the wrong moment.
A program that never touches the clock (`while(1){}`) is cut off by a real-time safety net (`wallTimeoutMs`) and
reported as `timeout`; its trace is whatever had been sent so far (events travel in chunks of 256).

With `followResets: true` a reset (`machine.reset()`, an expired watchdog, `watchdog_reboot`) restarts the program in a
fresh worker, as the board would: virtual time restarts at 0, `reset_cause()` / `watchdog_caused_reboot()` tell the new
boot why it started, and the scripted inputs and `untilMs` stay on the scenario's own timeline. `result.boots` lists one
entry per boot and every trace entry carries its `boot` index.

Wi-Fi and filesystem requests are not scripted in the runner: they get their fallback answers.

## Known limitations
* A program that polls with no sleep and no pin/clock read between iterations cannot be paced or limited by the
  clock; Stop (UI) or `wallTimeoutMs` (runner) is what ends it.
* In `realtime` mode, a long run of CPU-bound code between sleeps is not slowed down to "Pico speed"; only sleeps,
  pin reads and clock reads advance virtual time. Virtual time therefore says nothing about how long the same code
  would take on a 125 MHz RP2040.
* The main thread still runs its own copy of the electrical solver for the display (LEDs, badge, readout) with its
  own hysteresis memory; the program's reads come from the worker's solver. In the 0.8–2.0 V undefined band the
  display and the program can disagree momentarily.
