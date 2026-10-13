/**
 * event-batcher.js — send worker events to the main thread without flooding it
 *
 * A firmware program can produce events far faster than the UI can use them (`while True:
 * led.toggle()`, `while(1) printf(...)`). Posting one message per event would freeze the page.
 *
 * Policy:
 *   - Normal use is not delayed: up to `burstLimit` events per `intervalMs` window are sent
 *     immediately (the first event after a quiet period always is).
 *   - Beyond that, events are buffered and sent when the window rolls over or the timer fires.
 *     A worker that spins without ever yielding cannot run timers, so a flood can lag until the
 *     next window; pin LEVELS do not depend on this (they are mirrored in shared memory).
 *   - Consecutive writes to the same pin collapse into the last one.
 *   - The buffer is capped. When full, pin writes keep only the newest value per pin and other
 *     events are dropped and counted; an `overflow` event reports the loss.
 *
 * Pure logic with injectable clock/timers so it can be unit-tested.
 */

export function createEventBatcher({
    send,
    intervalMs = 16,
    burstLimit = 16,
    maxPending = 200,
    now = () => performance.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle)
}) {
    let buffer = [];
    let overflowWrites = new Map();    // pin -> newest pin.write that did not fit
    let dropped = 0;
    let timer = null;
    let windowStart = -Infinity;
    let windowCount = 0;

    function flush() {
        if (timer !== null) { clearTimer(timer); timer = null; }
        if (overflowWrites.size) { buffer.push(...overflowWrites.values()); overflowWrites = new Map(); }
        if (dropped) { buffer.push({ type: 'overflow', dropped }); dropped = 0; }
        if (buffer.length === 0) return;
        const events = buffer;
        buffer = [];
        send({ type: 'events', events });
    }

    function enqueue(event) {
        if (buffer.length >= maxPending) {
            if (event.type === 'pin.write') overflowWrites.set(event.pin, event);
            else dropped++;
            return;
        }
        const last = buffer[buffer.length - 1];
        if (event.type === 'pin.write' && last && last.type === 'pin.write' && last.pin === event.pin) {
            buffer[buffer.length - 1] = event;     // collapse consecutive writes to one pin
            return;
        }
        buffer.push(event);
    }

    /**
     * @param {object} event
     * @param {{immediate?: boolean}} [options] immediate: send now (use before the worker blocks)
     */
    function push(event, { immediate = false } = {}) {
        enqueue(event);
        const t = now();
        if (t - windowStart >= intervalMs) { windowStart = t; windowCount = 0; }
        windowCount++;

        if (immediate || windowCount <= burstLimit) {
            flush();
        } else if (timer === null) {
            timer = setTimer(flush, Math.max(0, windowStart + intervalMs - t));
        }
    }

    return { push, flush, pending: () => buffer.length + overflowWrites.size };
}
