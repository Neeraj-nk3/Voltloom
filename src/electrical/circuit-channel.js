/**
 * circuit-channel.js — publishes the circuit (parts + wires) from the main thread to a firmware worker (pure)
 *
 * The worker solves the circuit itself, so it must see the same circuit the user sees, including edits and
 * button presses made WHILE the program is running and busy in a loop (it cannot receive messages then).
 * The circuit therefore travels through shared memory:
 *
 *   Int32 header [0] = sequence number (odd while the writer is writing, even when stable)
 *                [1] = byte length of the JSON that follows
 *   bytes from offset HEADER_BYTES = UTF-8 JSON of the snapshot
 *
 * A single writer (the main thread) and any number of readers use a seqlock: the reader copies the bytes and
 * accepts them only if the sequence number is even and unchanged afterwards.
 */

export const HEADER_BYTES = 16;
export const DEFAULT_CAPACITY = 256 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The fields of the circuit that matter electrically, as plain data. Anything else on a component (DOM nodes,
 * positions, ...) is dropped, so the snapshot is small and always serialisable.
 */
export function snapshotCircuit(components, wires) {
  const endpoint = (n) => (n.nodeType === 'gpio'
    ? { nodeType: 'gpio', pin: n.pin }
    : { nodeType: 'component_pin', componentId: n.componentId, pin: n.pin });
  return {
    components: components.map((c) => ({ id: c.id, color: c.color, value: c.value, unit: c.unit, isPressed: !!c.isPressed })),
    wires: wires.filter((w) => w && w.start && w.end).map((w) => ({ start: endpoint(w.start), end: endpoint(w.end) }))
  };
}

export function createCircuitBuffer(capacity = DEFAULT_CAPACITY) {
  return new SharedArrayBuffer(HEADER_BYTES + capacity);
}

/** Write a snapshot. Throws RangeError if it does not fit. */
export function writeCircuit(buffer, snapshot) {
  const bytes = encoder.encode(JSON.stringify(snapshot));
  if (bytes.length > buffer.byteLength - HEADER_BYTES) throw new RangeError(`circuit of ${bytes.length} bytes does not fit the shared buffer`);
  const header = new Int32Array(buffer, 0, 4);
  Atomics.add(header, 0, 1);                                   // odd: writing
  new Uint8Array(buffer, HEADER_BYTES, bytes.length).set(bytes);
  Atomics.store(header, 1, bytes.length);
  Atomics.add(header, 0, 1);                                   // even: stable
  Atomics.notify(header, 0);                                   // wake a worker that is sleeping (it can then react at once)
}

export class CircuitReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.header = new Int32Array(buffer, 0, 4);
    this.seen = 0;                                             // sequence number of the snapshot last returned
  }

  /** The new snapshot if the writer published one since the last call, else null. */
  poll() {
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = Atomics.load(this.header, 0);
      if (before === this.seen) return null;
      if (before % 2 === 1) continue;                          // writer is mid-write: look again
      const length = Atomics.load(this.header, 1);
      const copy = new Uint8Array(length);
      copy.set(new Uint8Array(this.buffer, HEADER_BYTES, length));
      if (Atomics.load(this.header, 0) !== before) continue;   // changed while we copied: discard
      this.seen = before;
      return JSON.parse(decoder.decode(copy));
    }
    return null;                                               // keep what we have; try again at the next read
  }
}
