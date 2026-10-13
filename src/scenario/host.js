// host.js — the headless firmware host (runs inside a Node worker thread; see runner.js)
//
// It runs the SAME runtimes the browser workers use (runtime.js, runtime.js), on the same pin model and
// electrical model, with the clock in 'fast' mode: sleeps return at once on the program's virtual timeline, so a
// scenario of ten virtual seconds takes milliseconds and produces the identical trace every time.
//
// Scripted inputs (button presses, resistor edits) are applied by the clock itself, at their virtual time: the
// clock stops a sleep at each one, applies it, and runs the interrupt hook, so a GPIO interrupt handler runs at the
// virtual time of the edge, in the middle of the program's sleep. The trace records every event the program
// produced with the virtual time (since this boot) it happened at.

import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerPins } from '../runtime/common/pin-model.js';
import { WorkerBoard } from '../runtime/common/board-runtime.js';
import { createPythonRuntime } from '../runtime/python/runtime.js';
import { createCRuntime } from '../runtime/c/runtime.js';
import { VirtualClock } from '../clock/virtual-clock.js';
import { blockForever } from '../runtime/common/worker-support.js';
import { evaluateBoard } from '../electrical/board-eval.js';
import { EVENT } from '../worker-protocol/protocol.js';

const { language, code, moduleJs, circuit, script, untilUs, traceLimit, micropythonUrl, resetCause } = workerData;

const clock = new VirtualClock({ mode: 'fast' });
const trace = [];
let sent = 0;
let truncated = false;
let finished = false;

function sendChunk() {
  if (trace.length > sent) {
    parentPort.postMessage({ type: 'chunk', events: trace.slice(sent) });
    sent = trace.length;
  }
}

function record(event, tUs = Math.floor(clock.nowUs())) {
  if (trace.length >= traceLimit) { truncated = true; return; }
  trace.push({ tUs, ...event });
  if (trace.length - sent >= 256) sendChunk();
}

/** Report the outcome and stop this thread for good (the runner terminates it). */
function finish(reason, detail = {}) {
  if (finished) return;
  finished = true;
  sendChunk();
  const electrical = evaluateBoard({ components: circuitState.components, wires: circuitState.wires, pads: pins.padSnapshot() });
  parentPort.postMessage({
    type: 'done', reason, detail, truncated, virtualEndUs: Math.floor(clock.nowUs()),
    electrical: { ok: electrical.ok, parts: electrical.parts, pads: electrical.pads, warnings: electrical.warnings }
  });
  blockForever();
}

const emit = (event) => {
  record(event);
  if (event.type === EVENT.RESET) finish('reset', { kind: event.kind });
};

const circuitState = { components: circuit.components.map((c) => ({ ...c })), wires: circuit.wires };
const pins = new WorkerPins(emit);
const board = new WorkerBoard(null);
board.setCircuit(circuitState);
pins.attachBoard(board);
pins.attachClock(clock);

// ---- scripted inputs: applied by the clock, in time order, before the program sees the new time ----
const events = script.slice().sort((a, b) => a.atUs - b.atUs);
let nextEvent = 0;

function applyScripted(item) {
  const next = circuitState.components.map((c) => {
    if (item.button !== undefined && c.id === item.button) return { ...c, isPressed: !!item.pressed };
    if (item.resistor !== undefined && c.id === item.resistor) return { ...c, value: item.value, unit: item.unit ?? c.unit };
    return c;
  });
  circuitState.components = next;
  board.setCircuit({ components: next, wires: circuitState.wires });
  const { atUs, ...what } = item;
  record({ type: 'script', ...what }, Math.max(0, atUs));
}

clock.addWakeSource(() => (nextEvent < events.length ? events[nextEvent].atUs : Infinity));
clock.addWakeSource(() => untilUs);
clock.onAdvance((from, to) => {
  while (nextEvent < events.length && events[nextEvent].atUs <= to) applyScripted(events[nextEvent++]);
  if (to >= untilUs) finish('limit');
});

// Inputs that were already due when this boot started are in place before the first instruction.
while (nextEvent < events.length && events[nextEvent].atUs <= 0) applyScripted(events[nextEvent++]);

// ---- run the program ----
async function main() {
  const common = { emit, pins, clock, blockForever, flush: () => {}, resetCause };
  if (language === 'python') {
    const { loadMicroPython } = await import(pathToFileURL(micropythonUrl).href);
    await createPythonRuntime({ ...common, loadMicroPython }).run(code);
  } else {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voltloom-scenario-')), 'program.mjs');
    fs.writeFileSync(file, moduleJs);
    try {
      const runtime = createCRuntime({
        ...common,
        ask: (op, args, fallback) => fallback,                       // Wi-Fi, filesystem and reset cause are not scripted
        importModule: async () => (await import(pathToFileURL(file).href)).default,
        reportError: (err) => emit({ type: EVENT.PROGRAM_ERROR, name: (err && err.name) || 'Error', message: (err && err.message) || String(err) })
      });
      await runtime.run(moduleJs);
    } finally {
      try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  // main() returned (a C program with an infinite loop never gets here; it ends at the time limit)
  const failed = trace.find((e) => e.type === EVENT.PROGRAM_ERROR);
  finish(failed ? 'error' : 'exit', failed ? { name: failed.name, message: failed.message } : {});
}

main().catch((err) => finish('error', { name: err.name, message: String(err.message || err) }));
