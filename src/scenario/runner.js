/**
 * runner.js — run a Pico program against a circuit, headlessly and deterministically (Node)
 *
 *   const result = await runScenario({
 *     language: 'python' | 'c',
 *     code,                                  the program
 *     components, connections,               the circuit, in the project-file format (the same as a saved project)
 *     script: [ { atMs: 500, button: 'btn_1', pressed: true },        scripted inputs, applied at their virtual time
 *               { atMs: 900, resistor: 'res_1', value: 10, unit: 1000 } ],
 *     untilMs: 3000,                         stop after this much VIRTUAL time (programs often loop forever)
 *     wallTimeoutMs: 30000,                  safety net for a program that never touches the clock (`while(1){}`)
 *   });
 *
 * The program runs in a Node worker thread on the same firmware runtimes as the browser, with the virtual clock in
 * 'fast' mode: it does not wait, and the same inputs always give the same trace. C needs the Emscripten compiler
 * (compiler/lib/compile.js); Python does not.
 *
 * result = {
 *   ended:    'limit' (reached untilMs) | 'exit' (program returned) | 'reset' | 'error' | 'timeout' | 'compile-error',
 *   detail, virtualEndUs, wallMs, truncated,
 *   boots:    [{ boot, cause, ended, startUs, virtualEndUs }]   one entry per boot (cause: -1 power-on, else a RESET_KIND)
 *   trace:    [{ boot, tUs, type, ... }]  every event with its virtual time since that boot started (see src/worker-protocol/protocol.js;
 *             plus type 'script' for applied inputs and 'irq.fired' for interrupt handlers about to run)
 *   stdout:   [line, ...]
 *   electrical: { ok, parts, pads, warnings }   the circuit solved at the end (LED currents, pad voltages, warnings)
 * }
 */

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotCircuit } from '../electrical/circuit-channel.js';
import { compileC, CompileError } from '../../compiler/lib/compile.js';
import { EVENT } from '../worker-protocol/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const HOST = path.join(here, 'host.js');
const MICROPYTHON = path.join(root, 'runtimes', 'micropython', 'micropython.mjs');

const DEFAULTS = { untilMs: 10_000, wallTimeoutMs: 30_000, traceLimit: 100_000 };

function normaliseScript(script) {
  return script.map((item, i) => {
    const at = item.atUs !== undefined ? item.atUs : item.atMs * 1000;
    if (!Number.isFinite(at) || at < 0) throw new RangeError(`script[${i}]: atMs / atUs must be a non-negative number`);
    if (item.button !== undefined) {
      if (typeof item.pressed !== 'boolean') throw new TypeError(`script[${i}]: "pressed" must be true or false`);
      return { atUs: at, button: item.button, pressed: item.pressed };
    }
    if (item.resistor !== undefined) {
      if (!Number.isFinite(item.value) || item.value < 0) throw new RangeError(`script[${i}]: resistor "value" must be a non-negative number`);
      return { atUs: at, resistor: item.resistor, value: item.value, unit: item.unit };
    }
    throw new TypeError(`script[${i}]: expected { button, pressed } or { resistor, value, unit }`);
  });
}

/** Program output as lines: both interpreters deliver one stdout event per line (a trailing newline is dropped). */
export function stdoutLines(trace) {
  return trace.filter((e) => e.type === EVENT.STDOUT).map((e) => String(e.text).replace(/\r?\n$/, ''));
}

/** Run ONE boot of the program in a fresh worker thread. */
function runBoot(workerData, wallTimeoutMs) {
  return new Promise((resolve) => {
    const worker = new Worker(HOST, { workerData });
    const trace = [];
    let settled = false;
    const settle = (partial) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve({ detail: {}, virtualEndUs: trace.length ? trace[trace.length - 1].tUs : 0, truncated: false, electrical: null, ...partial, trace });
    };
    const timer = setTimeout(() => settle({ ended: 'timeout', detail: { message: `no result after ${wallTimeoutMs} ms of real time (a loop that never touches the clock?)` } }), wallTimeoutMs);

    worker.on('message', (m) => {
      if (m.type === 'chunk') trace.push(...m.events);
      else if (m.type === 'done') settle({ ended: m.reason, detail: m.detail, virtualEndUs: m.virtualEndUs, truncated: m.truncated, electrical: m.electrical });
    });
    worker.on('error', (err) => settle({ ended: 'error', detail: { name: err.name, message: String(err.message) } }));
    worker.on('exit', () => settle({ ended: 'error', detail: { message: 'the firmware host exited without a result' } }));
  });
}

export async function runScenario(options) {
  const { language, code, components = [], connections = [], script = [], followResets = false, maxBoots = 5 } = options;
  if (language !== 'python' && language !== 'c') throw new RangeError('language must be "python" or "c"');
  const { untilMs, wallTimeoutMs, traceLimit } = { ...DEFAULTS, ...options };
  const started = performance.now();

  let moduleJs = null;
  if (language === 'c') {
    try {
      moduleJs = (await compileC(code, { baseDir: path.join(root, 'compiler') })).js;
    } catch (err) {
      if (err instanceof CompileError) {
        return { ended: 'compile-error', detail: { kind: err.kind, message: err.message }, virtualEndUs: 0, wallMs: 0, truncated: false, trace: [], stdout: [], electrical: null, boots: [] };
      }
      throw err;
    }
  }

  const circuit = snapshotCircuit(components, connections);
  const fullScript = normaliseScript(script);
  const untilUs = untilMs * 1000;

  // One boot normally. With followResets, a reset (machine.reset(), watchdog expiry, watchdog_reboot) restarts the
  // program in a fresh worker, as the board would: virtual time restarts at 0, the program can ask why it restarted,
  // and scripted inputs and the time budget stay on the scenario's own timeline.
  const trace = [];
  const boots = [];
  let offsetUs = 0;
  let resetCause = -1;
  let last = null;
  for (let boot = 0; boot < (followResets ? maxBoots : 1); boot++) {
    const localScript = fullScript.map((item) => ({ ...item, atUs: item.atUs - offsetUs }));
    last = await runBoot({
      language, code, moduleJs, circuit, script: localScript, untilUs: untilUs - offsetUs, traceLimit,
      micropythonUrl: MICROPYTHON, resetCause
    }, wallTimeoutMs);
    for (const event of last.trace) trace.push({ boot, ...event });
    boots.push({ boot, cause: resetCause, ended: last.ended, startUs: offsetUs, virtualEndUs: last.virtualEndUs });
    if (last.ended !== 'reset' || !followResets) break;
    offsetUs += last.virtualEndUs;
    resetCause = last.detail.kind;
    if (offsetUs >= untilUs) { last = { ...last, ended: 'limit' }; break; }
  }

  return {
    ended: last.ended, detail: last.detail, virtualEndUs: last.virtualEndUs, truncated: last.truncated, electrical: last.electrical,
    boots, trace, stdout: stdoutLines(trace), wallMs: Math.round(performance.now() - started)
  };
}

// ---- helpers for reading a result ----

/** [{ tUs, value }] for every write to a pin. */
export function pinWrites(result, pin) {
  return result.trace.filter((e) => e.type === EVENT.PIN_WRITE && e.pin === pin).map((e) => ({ tUs: e.tUs, value: e.value }));
}

/** The level a pin had at a virtual time (last write at or before it; undefined before the first write). */
export function pinLevelAt(result, pin, tUs) {
  let level;
  for (const w of pinWrites(result, pin)) { if (w.tUs <= tUs) level = w.value; else break; }
  return level;
}
