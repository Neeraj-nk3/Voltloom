/**
 * runtime.js — runs a compiled C program (WebAssembly) against the simulated hardware (no Worker plumbing)
 *
 * Shared by the browser worker (worker.js) and the Node scenario runner. It builds the `Module._sim_*`
 * functions that compiler/sdk/src/js-library.js calls for every Pico SDK function, on top of:
 *
 *   emit          events to whoever watches the hardware (see protocol.js)
 *   pins, clock   WorkerPins and the program's VirtualClock; sleeps are plain blocking calls into the clock
 *   ask           synchronous request for main-thread state (Wi-Fi, filesystem, reset cause), or a fallback
 *   importModule  how to turn the compiled module text into its factory function (blob URL in a browser worker)
 *   blockForever  what a program-requested reset does after announcing itself (never returns)
 *
 * Stopping a program is the host terminating the thread: nothing here has to cooperate, even in a blocking sleep.
 */

import { EVENT, PULL, RESET_KIND } from '../../worker-protocol/protocol.js';
import { WatchdogTimer } from '../common/watchdog.js';

export function createCRuntime({ emit, pins, clock, ask, importModule, blockForever, flush = () => {}, reportError = () => {}, resetCause = -1 }) {
  /** Announce a reset to the host and never return (a real reset does not return to the caller). */
  const resetBoard = (kind) => {
    emit({ type: EVENT.RESET, kind }, { immediate: true });
    blockForever();
  };
  const watchdog = new WatchdogTimer(clock, () => resetBoard(RESET_KIND.WATCHDOG));
  watchdog.attachTo(clock);

  // The Emscripten Module object. Emscripten adds HEAPU8 etc. to it as the program starts.
  const moduleConfig = {
    noInitialRun: false,
    print: (text) => emit({ type: EVENT.STDOUT, text }),
    printErr: (text) => emit({ type: EVENT.STDERR, text }),

    // ---- GPIO ----
    _sim_gpio_init: (pin) => pins.init(pin),
    _sim_gpio_set_dir: (pin, dir) => pins.setDir(pin, dir),
    _sim_gpio_put: (pin, value) => pins.write(pin, value),
    _sim_gpio_get: (pin) => pins.read(pin),
    _sim_gpio_pull_up: (pin) => pins.setPull(pin, PULL.UP),
    _sim_gpio_pull_down: (pin) => pins.setPull(pin, PULL.DOWN),
    _sim_gpio_disable_pulls: (pin) => pins.setPull(pin, PULL.NONE),
    _sim_gpio_set_irq: (pin, mask, enabled) => pins.irqEnable(pin, mask, !!enabled),   // handlers run via _sim_irq_dispatch (exported from the program)
    _sim_gpio_set_function: (pin, fn) => pins.setFunction(pin, fn),
    _sim_gpio_get_function: (pin) => pins.getFunction(pin),
    _sim_gpio_get_dir: (pin) => pins.getDir(pin),
    _sim_gpio_get_pull: (pin) => pins.getPull(pin),
    _sim_gpio_get_out: (pin) => pins.getOut(pin),

    // ---- stdio / time (the virtual clock; sleeping is a blocking call, not Asyncify) ----
    _sim_stdio_init: () => { /* nothing to do */ },
    _sim_print: (text) => emit({ type: EVENT.STDOUT, text }),
    _sim_time_us_64: () => Math.floor(clock.tick()),
    _sim_sleep_us: (us) => { clock.sleepUs(us); },

    // ---- PWM ----
    _sim_pwm_set_wrap: (slice, value) => pins.pwmSetWrap(slice, value),
    _sim_pwm_set_level: (slice, channel, value) => pins.pwmSetLevel(slice, channel, value),
    _sim_pwm_set_enabled: (slice, enabled) => pins.pwmSetEnabled(slice, !!enabled),
    _sim_pwm_set_clkdiv: (slice, div) => pins.pwmSetClkdiv(slice, div),

    // ---- Wi-Fi (simulated) ----
    _sim_wifi_init: () => ask('wifi.init', [], -1),
    _sim_wifi_deinit: () => { ask('wifi.deinit', [], null); },
    _sim_wifi_enable_sta: () => { ask('wifi.enableSta', [], null); },
    _sim_wifi_connect: (ssid, password, timeout) => ask('wifi.connect', [ssid, password, timeout], -1),
    _sim_wifi_set_led: (gpio, value) => { pins.write(25, value ? 1 : 0); },

    // ---- Reset / watchdog ----
    _sim_reset: (kind) => resetBoard(kind),
    _sim_watchdog_enable: (delayMs) => { watchdog.enable(delayMs); },
    _sim_watchdog_update: () => { watchdog.feed(); },
    _sim_watchdog_reboot: (delayMs) => { if (delayMs > 0) watchdog.schedule(delayMs); else resetBoard(RESET_KIND.WATCHDOG); },
    _sim_watchdog_caused_reboot: () => (resetCause === RESET_KIND.WATCHDOG ? 1 : 0),

    // ---- Filesystem (simulated flash, kept in the main thread's localStorage) ----
    _sim_fs_init: () => ask('fs.init', [], -3),
    _sim_fs_write: (filename, data) => ask('fs.write', [filename, data], -2),
    _sim_fs_exists: (filename) => ask('fs.exists', [filename], 0) ? 1 : 0,
    _sim_fs_delete: (filename) => ask('fs.delete', [filename], -1),
    _sim_fs_read: (filename, bufferPtr, maxLen) => {
      const reply = ask('fs.read', [filename, maxLen], { status: -3, data: '' });
      if (reply.status !== 0) return reply.status;
      // stringToUTF8 is exported by the compile flags; it copies at most maxLen bytes including the NUL.
      moduleConfig.stringToUTF8(String(reply.data), bufferPtr, maxLen);
      return 0;
    }
  };

  // Interrupt handlers live in the program: JavaScript calls its exported dispatcher at the virtual time of the edge.
  pins.setIrqDispatch((pin, events) => {
    if (typeof moduleConfig._sim_irq_dispatch !== 'function') return;
    try {
      moduleConfig._sim_irq_dispatch(pin, events);
    } catch (err) {
      reportError(err);
    }
  });

  async function run(moduleJs) {
    try {
      const createModule = await importModule(moduleJs);
      if (typeof createModule !== 'function') throw new Error('Compiled output has no module factory (check the emcc flags)');
      await createModule(moduleConfig);
      flush();
    } catch (err) {
      reportError(err);
    }
  }

  return { run, moduleConfig };
}
