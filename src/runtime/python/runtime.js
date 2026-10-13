/**
 * runtime.js — runs a MicroPython program against the simulated hardware (no Worker plumbing)
 *
 * Both hosts use this: the browser worker (worker.js) and the Node scenario runner (src/scenario/). The host
 * supplies everything environment-specific, so the program sees the same pins, the same virtual clock and the
 * same `machine` module either way:
 *
 *   emit        send an event to whoever watches the hardware (see protocol.js)
 *   pins        a WorkerPins (pin state, electrical model, PWM, interrupts)
 *   clock       a VirtualClock
 *   loadMicroPython / loadOptions   how to load the interpreter (the browser needs the .wasm URL)
 *   checkpoint  debugger hook called before each statement, or null
 *   blockForever  what a program-requested reset does after announcing itself (never returns)
 *   flush       push any buffered events out when the program ends
 *   resetCause  why the board started: -1 power-on, else a RESET_KIND
 */

import { injectCheckpoints, remapErrorLines } from './line-checkpoints.js';
import { MACHINE_PRELUDE } from './machine-module.js';
import { createClockModule, TIME_PRELUDE } from './time-module.js';
import { WatchdogTimer } from '../common/watchdog.js';
import { EVENT, RESET_KIND } from '../../worker-protocol/protocol.js';

export function createPythonRuntime({ emit, pins, clock, loadMicroPython, loadOptions = {}, checkpoint = null, blockForever, flush = () => {}, resetCause = -1 }) {
  let mp = null;
  let irqEntry = null;          // the Python function that runs a pin's interrupt handler

  const resetBoard = (kind) => {
    emit({ type: EVENT.RESET, kind }, { immediate: true });
    blockForever();
  };
  const watchdog = new WatchdogTimer(clock, () => resetBoard(RESET_KIND.WATCHDOG));
  watchdog.attachTo(clock);

  // Interrupts reach Python at the virtual time of the edge: JavaScript calls the handler even while Python is
  // inside a sleep. An exception in a handler is printed and the program carries on.
  pins.setIrqDispatch((pin, events) => {
    if (!irqEntry) return;
    try {
      irqEntry(pin, events);
    } catch (err) {
      emit({ type: EVENT.STDERR, text: String((err && err.message) || err) });
    }
  });

  /**
   * The JavaScript primitives behind the Python `machine` module (see machine-module.js).
   * Python-level argument handling (keywords, defaults) lives in Python; these are positional only.
   */
  const hardware = {
    create: (pin, mode, pull, value) => {
      pins.create(pin, mode, pull);
      if ((value === 0 || value === 1) && pins.isOutput(pin)) pins.write(pin, value);
    },
    read: (pin) => pins.read(pin),
    get_mode: (pin) => pins.getDir(pin),
    get_pull: (pin) => pins.getPull(pin),
    write: (pin, value) => pins.write(pin, value),
    toggle: (pin) => pins.toggle(pin),
    reset: (kind) => resetBoard(kind),

    // interrupts
    set_irq_entry: (fn) => { irqEntry = fn; },
    irq: (pin, trigger) => pins.irqSet(pin, trigger),
    irq_disable: (disabled) => pins.setIrqMasked(!!disabled),     // edges are latched meanwhile and run on enable

    // watchdog and reset cause
    wdt_enable: (timeoutMs) => { watchdog.enable(timeoutMs); },
    wdt_feed: () => { watchdog.feed(); },
    reset_cause: () => resetCause,

    // machine.PWM. Errors come back as text so Python can raise ValueError, as MicroPython does.
    pwm_init: (pin) => pins.pwmInit(pin),
    pwm_freq: (pin) => pins.pwmFreq(pin),
    pwm_set_freq: (pin, hz) => {
      try { pins.pwmSetFreq(pin, Number(hz)); return ''; } catch (err) { return String((err && err.message) || err); }
    },
    pwm_duty16: (pin) => pins.pwmDuty16(pin),
    pwm_set_duty16: (pin, duty) => pins.pwmSetDuty16(pin, Number(duty)),
    pwm_deinit: (pin) => pins.pwmDeinit(pin)
  };

  async function run(code) {
    // Instrumented-line -> user-line map; declared outside the try so the catch can use it.
    let lineMap = {};

    try {
      if (!mp) {
        mp = await loadMicroPython({
          ...loadOptions,
          stdout: (text) => emit({ type: EVENT.STDOUT, text }),
          stderr: (text) => emit({ type: EVENT.STDERR, text })
        });
        mp.registerJsModule('_voltloom_hw', hardware);
        mp.registerJsModule('_voltloom_clock', createClockModule(clock));
        mp.registerJsModule('sim_debug', { checkpoint: checkpoint || (() => {}) });
        mp.runPython(MACHINE_PRELUDE);        // defines the Python-level `machine` module
        mp.runPython(TIME_PRELUDE);           // time / utime run on the virtual clock
      }

      // Checkpoints go only before real statement starts (see line-checkpoints.js).
      const instrumented = injectCheckpoints(code);
      lineMap = instrumented.lineMap;
      mp.runPython(instrumented.code);
      flush();

    } catch (err) {
      // MicroPython loading errors AND Python exceptions (syntax errors, uncaught exceptions).
      const name = err.name || 'Error';
      const message = remapErrorLines(err.message || String(err), lineMap);
      emit({ type: EVENT.PROGRAM_ERROR, name, message }, { immediate: true });
      console.error('[Python runtime] Execution error:', { name, message, stack: err.stack || '' });
    }
  }

  return { run };
}
