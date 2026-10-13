/**
 * rpc-mailbox.js — blocking request/response between a firmware worker and the main thread
 *
 * Some firmware calls must return a value that lives on the main thread (Wi-Fi status, the
 * simulated filesystem in localStorage, "was the last reset a watchdog reset"). A worker may
 * block, so it posts a `rpc` message and then sleeps on a SharedArrayBuffer cell until the main
 * thread writes the JSON answer there and wakes it.
 *
 * Layout of the SharedArrayBuffer (Int32 cells, then bytes):
 *   cell 0   state: 0 = waiting, 1 = answer ready
 *   cell 1   length in bytes of the JSON answer
 *   byte 16+ the answer, UTF-8 JSON (at most MAILBOX_PAYLOAD_BYTES)
 *
 * Only one request is ever outstanding (the worker is blocked while it waits). If the main thread
 * does not answer within the timeout the call fails instead of hanging the worker forever.
 */

export const MAILBOX_HEADER_BYTES = 16;
export const MAILBOX_PAYLOAD_BYTES = 64 * 1024;
export const MAILBOX_BYTES = MAILBOX_HEADER_BYTES + MAILBOX_PAYLOAD_BYTES;
export const DEFAULT_RPC_TIMEOUT_MS = 5000;

const ctrlOf = (buffer) => new Int32Array(buffer, 0, 2);
const bytesOf = (buffer) => new Uint8Array(buffer, MAILBOX_HEADER_BYTES, MAILBOX_PAYLOAD_BYTES);

export function createMailbox() {
    return new SharedArrayBuffer(MAILBOX_BYTES);
}

/** Main thread: store the answer and wake the worker. */
export function respond(buffer, value) {
    let json = JSON.stringify(value === undefined ? null : value);
    let encoded = new TextEncoder().encode(json);
    if (encoded.length > MAILBOX_PAYLOAD_BYTES) {
        encoded = new TextEncoder().encode(JSON.stringify({ error: 'response too large' }));
    }
    bytesOf(buffer).set(encoded);
    const ctrl = ctrlOf(buffer);
    Atomics.store(ctrl, 1, encoded.length);
    Atomics.store(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
}

/** Worker: clear the mailbox before sending a request. */
export function prepare(buffer) {
    Atomics.store(ctrlOf(buffer), 0, 0);
}

/**
 * Worker: block until the main thread answers.
 * @returns {{ok: true, value: any} | {ok: false, error: string}}
 */
export function waitForResponse(buffer, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
    const ctrl = ctrlOf(buffer);
    const outcome = Atomics.wait(ctrl, 0, 0, timeoutMs);      // returns at once if already answered
    if (outcome === 'timed-out') return { ok: false, error: 'timeout' };
    const length = Atomics.load(ctrl, 1);
    const text = new TextDecoder().decode(bytesOf(buffer).slice(0, length));
    Atomics.store(ctrl, 0, 0);
    try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, error: 'bad response' }; }
}
