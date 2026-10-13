// worker.js — runs the user's MicroPython program in its own thread.
//
// Talks to the main thread with the typed messages described in src/worker-protocol/protocol.js.
// Hardware (Pin) goes through WorkerPins (pin-model.js), the same model the C worker uses; time goes through
// the program's VirtualClock (clock/virtual-clock.js). The program itself is run by runtime.js, which the Node
// scenario runner uses too. This file is only the browser plumbing: messages in, events out.
// Events are sent through an event batcher so a program that floods the channel cannot freeze the page.

import { loadMicroPython } from "../../../runtimes/micropython/micropython.mjs";
// Tell MicroPython where its .wasm is. Without this the built app looks for an unhashed file name
// next to the worker bundle, gets the HTML fallback page instead, and fails to start.
import wasmUrl from "../../../runtimes/micropython/micropython.wasm?url";
import { WorkerPins } from "../common/pin-model.js";
import { WorkerBoard } from "../common/board-runtime.js";
import { createPythonRuntime } from "./runtime.js";
import { createEventBatcher } from "../common/event-batcher.js";
import { createClockFactory, blockForever } from "../common/worker-support.js";
import { COMMAND, EVENT } from "../../worker-protocol/protocol.js";

const batcher = createEventBatcher({ send: (message) => postMessage(message) });
const emit = (event, options) => batcher.push(event, options);
const pins = new WorkerPins(emit);

let resetCause = -1;      // why the board started: -1 power-on, else a RESET_KIND (from the main thread)

const makeClock = createClockFactory({ batcher, pins });

let clock = makeClock("realtime");   // replaced at INIT with the mode the host asked for
pins.attachClock(clock);

// Debugger state: [ STATE, LINE, ... ] shared with the main thread, and the breakpoint lines.
let sharedDebug = null;
let breakpoints = [];

/** Debugger checkpoint, exposed to MicroPython as `sim_debug.checkpoint(line)`. */
function debugCheckpoint(line) {
  if (!sharedDebug) return;

  const STATE_PAUSED = 1;
  const STATE_STEP = 2;

  let state = Atomics.load(sharedDebug, 0);
  const isBreakpoint = breakpoints.includes(line);

  // Stepping or hitting a breakpoint pauses.
  if (state === STATE_STEP || isBreakpoint) {
    Atomics.store(sharedDebug, 0, STATE_PAUSED);
    state = STATE_PAUSED;
  }

  if (state === STATE_PAUSED) {
    // Tell the UI (and make sure it arrives before we block).
    emit({ type: EVENT.DEBUG_PAUSED, line }, { immediate: true });

    // Block this worker (allowed in workers) until the UI changes the state.
    while (Atomics.load(sharedDebug, 0) === STATE_PAUSED) {
      Atomics.wait(sharedDebug, 0, STATE_PAUSED);
    }
  }
}

let runtime = null;
function pythonRuntime() {
  if (!runtime) {
    runtime = createPythonRuntime({
      emit, pins, clock, loadMicroPython, loadOptions: { url: wasmUrl },
      checkpoint: debugCheckpoint, blockForever, flush: () => batcher.flush(), resetCause
    });
  }
  return runtime;
}

onmessage = async (e) => {
  const message = e.data;
  if (message === null || typeof message !== 'object') return;

  switch (message.type) {
    case COMMAND.INIT:
      if (message.sharedPins) pins.attachShared(new Int32Array(message.sharedPins));
      if (message.circuitBuffer) pins.attachBoard(new WorkerBoard(message.circuitBuffer));
      clock = makeClock(message.clockMode === "fast" ? "fast" : "realtime");
      pins.attachClock(clock);
      resetCause = Number.isInteger(message.resetCause) ? message.resetCause : -1;
      runtime = null;                    // rebuilt with the new clock on the first run
      sharedDebug = message.debugBuffer ? new Int32Array(message.debugBuffer) : null;
      breakpoints = message.breakpoints || [];
      break;

    case COMMAND.BREAKPOINTS:
      breakpoints = message.lines || [];
      break;

    case COMMAND.PIN_INPUT:          // fallback when SharedArrayBuffer is unavailable
      pins.setFallbackInput(message.pin, message.value);
      break;

    case COMMAND.PING:
      emit({ type: EVENT.PONG, t: message.t }, { immediate: true });
      break;

    case COMMAND.RUN:
      await pythonRuntime().run(message.code);
      break;
  }
};
