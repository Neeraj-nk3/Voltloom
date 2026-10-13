// worker.js — runs a compiled C program (WebAssembly) in its own thread.
//
// The compile service returns one JavaScript module with the WebAssembly embedded. runtime.js (shared with
// the Node scenario runner) supplies the `Module._sim_*` functions that compiler/sdk/src/js-library.js calls
// for every Pico SDK function. This file is only the browser plumbing: messages in, events out. Because the
// program lives in a worker:
//   - Stop is Worker.terminate(): a program in `while(1){}`, or blocked in a sleep, cannot freeze the page or
//     survive Stop;
//   - the main thread never runs firmware code.
//
// Typed messages: see src/worker-protocol/protocol.js. Hardware pins: WorkerPins (shared with the Python worker).
// Calls that need main-thread state (Wi-Fi status, the localStorage-backed filesystem, reset cause)
// are blocking requests through a shared mailbox (src/worker-protocol/rpc-mailbox.js).

import { WorkerPins } from '../common/pin-model.js';
import { WorkerBoard } from '../common/board-runtime.js';
import { createCRuntime } from './runtime.js';
import { createEventBatcher } from '../common/event-batcher.js';
import { createClockFactory, blockForever } from '../common/worker-support.js';
import { COMMAND, EVENT } from '../../worker-protocol/protocol.js';
import { prepare, waitForResponse } from '../../worker-protocol/rpc-mailbox.js';

const batcher = createEventBatcher({ send: (message) => postMessage(message) });
const emit = (event, options) => batcher.push(event, options);
const pins = new WorkerPins(emit);


const makeClock = createClockFactory({ batcher, pins });

let clock = makeClock('realtime');   // replaced at INIT with the mode the host asked for
pins.attachClock(clock);
let rpcBuffer = null;
let resetCause = -1;      // why the board started: -1 power-on, else a RESET_KIND (from the main thread)

/** Ask the main thread a question and wait for the answer; `fallback` if it cannot answer. */
function ask(op, args, fallback) {
    if (!rpcBuffer) return fallback;
    batcher.flush();                                   // keep events and requests in order
    prepare(rpcBuffer);
    postMessage({ type: EVENT.RPC, op, args });
    const reply = waitForResponse(rpcBuffer);
    return reply.ok ? reply.value : fallback;
}

function reportError(err) {
    const name = (err && err.name) || 'Error';
    const message = (err && err.message) || String(err);
    emit({ type: EVENT.PROGRAM_ERROR, name, message }, { immediate: true });
    console.error('[C worker] Execution error:', err);
}

/** Turn the compiled module text into its factory function, through a blob URL. */
async function importModule(moduleJs) {
    // The module refers to import.meta.url; inside a blob import that is not meaningful, so point it at this worker.
    const patched = moduleJs.replace(/import\.meta\.url/g, JSON.stringify(self.location.href));
    const blobUrl = URL.createObjectURL(new Blob([patched], { type: 'application/javascript' }));
    try {
        return (await import(/* @vite-ignore */ blobUrl)).default;
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

let runtime = null;
function cRuntime() {
    if (!runtime) {
        runtime = createCRuntime({ emit, pins, clock, ask, importModule, blockForever, flush: () => batcher.flush(), reportError, resetCause });
    }
    return runtime;
}

// An Emscripten abort() after the first sleep surfaces as an unhandled rejection.
self.addEventListener('unhandledrejection', (event) => { event.preventDefault(); reportError(event.reason); });

onmessage = async (e) => {
    const message = e.data;
    if (message === null || typeof message !== 'object') return;

    switch (message.type) {
        case COMMAND.INIT:
            if (message.sharedPins) pins.attachShared(new Int32Array(message.sharedPins));
            if (message.circuitBuffer) pins.attachBoard(new WorkerBoard(message.circuitBuffer));
            clock = makeClock(message.clockMode === 'fast' ? 'fast' : 'realtime');
            pins.attachClock(clock);
            runtime = null;                            // rebuilt with the new clock on the first run
            rpcBuffer = message.rpcBuffer || null;
            resetCause = Number.isInteger(message.resetCause) ? message.resetCause : -1;
            break;

        case COMMAND.PIN_INPUT:
            pins.setFallbackInput(message.pin, message.value);
            break;

        case COMMAND.PING:
            emit({ type: EVENT.PONG, t: message.t }, { immediate: true });
            break;

        case COMMAND.RUN:
            await cRuntime().run(message.moduleJs);
            break;
    }
};
