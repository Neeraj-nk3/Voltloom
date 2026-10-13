/**
 * protocol.js — messages exchanged between the main thread and a firmware worker
 *
 * Both firmware workers (MicroPython in src/runtime/python/worker.js, C in src/runtime/c/worker.js) speak
 * this one protocol. Every message is an object with a string `type`. Nothing a program prints can
 * be mistaken for a command, because program output only ever travels inside a typed message.
 *
 * Worker -> main (usually delivered inside {type:'events', events:[...]} batches, see event-batcher.js):
 *   stdout / stderr   {text}                       program output
 *   pin.create        {pin, mode, pull}            Python created/reconfigured a Pin   (absolute values)
 *   pin.init          {pin, pull}                  C gpio_init: input, output low (pull is left as it was; reset state is pull-down)
 *   pin.dir           {pin, dir}                   C gpio_set_dir
 *   pin.pull          {pin, pull}                  C gpio_pull_up/down/disable_pulls
 *   pin.write         {pin, value}                 output level (0/1); toggles are sent as explicit values
 *   pin.func          {pin, fn}                    gpio_set_function / PWM(pin): which peripheral drives the pad (4 = PWM, 5 = plain GPIO)
 *   pin.irq           {pin, mask, enabled}         interrupt configuration (SDK values: LEVEL_LOW 1, LEVEL_HIGH 2, EDGE_FALL 4, EDGE_RISE 8)
 *   irq.fired         {pin, events}                an interrupt handler is about to run in the program (informational)
 *   pwm               {op, slice, channel?, value} op: wrap | level | enable
 *   program.error     {name, message}              uncaught exception in the user's program
 *   debug.paused      {line}                       debugger stopped at a statement (Python only)
 *   reset             {kind}                       program asked to reset (see reset-sim RESET_*)
 *   overflow          {dropped}                    events were discarded because the program flooded the channel
 *   pong              {t}                          answer to ping
 * Worker -> main, never batched (the worker then blocks until the answer is written to the mailbox):
 *   rpc               {op, args}                   synchronous request for main-thread state (see rpc-mailbox.js)
 *
 * Main -> worker:
 *   init              {sharedPins, circuitBuffer?, debugBuffer?, rpcBuffer?, breakpoints?, clockMode, resetCause}
 *                     resetCause: -1 power-on, else the RESET_KIND of the reset that restarted the program
 *                     clockMode: 'realtime' | 'fast' - the program's virtual clock (see clock/virtual-clock.js)
 *                     circuitBuffer: the circuit (parts, wires, pressed buttons) published by the main thread; with it
 *                     the worker solves input reads itself (see board-runtime.js, circuit-channel.js)
 *   run               {code} (Python source) | {moduleJs} (compiled C module text)
 *   breakpoints       {lines}
 *   pin.input         {pin, value}                 fallback when SharedArrayBuffer is unavailable
 *   ping              {t}
 *
 * Shared memory layout (Int32Array over a SharedArrayBuffer, see SHARED_PINS_LENGTH):
 *   [0 .. 29]    what the circuit drives onto each GPIO input: 0, 1, or FLOATING (pin-levels.js).
 *                Only used when the worker has no circuitBuffer (the legacy / no-SharedArrayBuffer path).
 *   [64 .. 93]   the level each GPIO output was last set to by the program, or UNSET
 */

export const PROTOCOL_VERSION = 1;

export const EVENT = Object.freeze({
    BATCH: 'events',
    STDOUT: 'stdout',
    STDERR: 'stderr',
    PIN_CREATE: 'pin.create',
    PIN_INIT: 'pin.init',
    PIN_DIR: 'pin.dir',
    PIN_PULL: 'pin.pull',
    PIN_WRITE: 'pin.write',
    PIN_IRQ: 'pin.irq',
    PIN_FUNC: 'pin.func',
    IRQ_FIRED: 'irq.fired',
    PWM: 'pwm',
    PROGRAM_ERROR: 'program.error',
    DEBUG_PAUSED: 'debug.paused',
    RESET: 'reset',
    OVERFLOW: 'overflow',
    PONG: 'pong',
    RPC: 'rpc'
});

export const COMMAND = Object.freeze({
    INIT: 'init',
    RUN: 'run',
    BREAKPOINTS: 'breakpoints',
    PIN_INPUT: 'pin.input',
    PING: 'ping'
});

export const NUM_GPIO = 30;
export const SHARED_INPUT_BASE = 0;
export const SHARED_OUTPUT_BASE = 64;
export const SHARED_PINS_LENGTH = 128;
export const OUTPUT_UNSET = -1;

export const RESET_KIND = Object.freeze({ SOFT: 0, WATCHDOG: 1, POWER_CYCLE: 2 });

export const PIN_DIR = Object.freeze({ IN: 0, OUT: 1 });
export const PULL = Object.freeze({ NONE: 0, UP: 1, DOWN: 2 });

export function isMessage(value) {
    return value !== null && typeof value === 'object' && typeof value.type === 'string';
}
