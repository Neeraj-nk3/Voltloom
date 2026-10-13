import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  createCircuitBuffer, writeCircuit, CircuitReader, snapshotCircuit, HEADER_BYTES,
} from '../../../src/electrical/circuit-channel.js';

const gpio = (pin) => ({ nodeType: 'gpio', pin, x: 1, y: 2 });
const cp = (componentId, pin) => ({ nodeType: 'component_pin', componentId, pin, x: 5, y: 6 });

describe('snapshotCircuit', () => {
  it('keeps only the electrical fields and drops DOM nodes, positions and wire visuals', () => {
    const div = { not: 'serialisable' };
    const snap = snapshotCircuit(
      [{ id: 'res_1', value: 330, unit: 1, div, x: 10, y: 20 }, { id: 'btn_1', isPressed: true, div }, { id: 'led_1', color: '#ef4444', flipped: true, div }],
      [{ id: 'w1', color: 'red', pathElement: div, start: gpio(36), end: cp('res_1', '1') }, null, { start: null, end: null }]
    );
    expect(snap).toEqual({
      components: [
        { id: 'res_1', color: undefined, value: 330, unit: 1, isPressed: false },
        { id: 'btn_1', color: undefined, value: undefined, unit: undefined, isPressed: true },
        { id: 'led_1', color: '#ef4444', value: undefined, unit: undefined, isPressed: false },
      ],
      wires: [{ start: { nodeType: 'gpio', pin: 36 }, end: { nodeType: 'component_pin', componentId: 'res_1', pin: '1' } }],
    });
    expect(() => JSON.stringify(snap)).not.toThrow();
  });
});

describe('circuit channel', () => {
  const snapshot = (n) => ({ components: [{ id: 'res_1', value: n, unit: 1, isPressed: false }], wires: [] });

  it('a reader sees nothing before the first write, the snapshot after it, and nothing new until the next write', () => {
    const buffer = createCircuitBuffer(4096);
    const reader = new CircuitReader(buffer);
    expect(reader.poll()).toBeNull();
    writeCircuit(buffer, snapshot(1));
    expect(reader.poll()).toEqual(snapshot(1));
    expect(reader.poll()).toBeNull();
    writeCircuit(buffer, snapshot(2));
    writeCircuit(buffer, snapshot(3));          // two writes between polls: the reader gets the latest
    expect(reader.poll()).toEqual(snapshot(3));
  });

  it('two readers are independent', () => {
    const buffer = createCircuitBuffer(4096);
    const a = new CircuitReader(buffer); const b = new CircuitReader(buffer);
    writeCircuit(buffer, snapshot(7));
    expect(a.poll()).toEqual(snapshot(7));
    expect(b.poll()).toEqual(snapshot(7));
  });

  it('refuses a snapshot that does not fit, and leaves the previous one intact', () => {
    const buffer = createCircuitBuffer(256);
    const reader = new CircuitReader(buffer);
    writeCircuit(buffer, snapshot(1));
    const huge = { components: Array.from({ length: 100 }, (_, i) => ({ id: `res_${i}`, value: i })), wires: [] };
    expect(() => writeCircuit(buffer, huge)).toThrow(RangeError);
    expect(reader.poll()).toEqual(snapshot(1));
  });

  it('a reader never returns a half-written snapshot (odd sequence number)', () => {
    const buffer = createCircuitBuffer(4096);
    const reader = new CircuitReader(buffer);
    writeCircuit(buffer, snapshot(1));
    expect(reader.poll()).toEqual(snapshot(1));
    const header = new Int32Array(buffer, 0, 4);
    Atomics.add(header, 0, 1);                   // the writer starts writing... and has not finished
    new Uint8Array(buffer, HEADER_BYTES, 4).set([0x7b, 0x22, 0x7a, 0x7a]);   // garbage mid-write
    expect(reader.poll()).toBeNull();            // keeps what it had instead of parsing garbage
    Atomics.add(header, 0, 1);
  });

  it('survives unicode', () => {
    const buffer = createCircuitBuffer(4096);
    writeCircuit(buffer, { components: [{ id: 'res_1', note: 'Ω µ — 日本' }], wires: [] });
    expect(new CircuitReader(buffer).poll().components[0].note).toBe('Ω µ — 日本');
  });

  it('across real threads: a reader polling while the writer rewrites the circuit never sees a torn snapshot', async () => {
    const buffer = createCircuitBuffer(64 * 1024);
    const done = new Int32Array(new SharedArrayBuffer(8));
    const moduleUrl = pathToFileURL(path.resolve('src/electrical/circuit-channel.js')).href;
    const source = `
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { CircuitReader } = await import(${JSON.stringify(moduleUrl)});
        const reader = new CircuitReader(workerData.buffer);
        const done = new Int32Array(workerData.done);
        let seen = 0, torn = 0, last = 0;
        while (Atomics.load(done, 0) === 0) {
          const s = reader.poll();
          if (!s) continue;
          seen++;
          const n = s.components[0].value;
          if (s.components.length !== (n % 50) + 1 || !s.components.every((c) => c.value === n) || n < last) torn++;
          last = n;
        }
        parentPort.postMessage({ seen, torn });
      })();
    `;
    const worker = new Worker(source, { eval: true, workerData: { buffer, done: done.buffer } });
    const result = new Promise((resolve, reject) => { worker.on('message', resolve); worker.on('error', reject); });
    for (let n = 1; n <= 4000; n++) {
      writeCircuit(buffer, { components: Array.from({ length: (n % 50) + 1 }, () => ({ id: 'res_1', value: n })), wires: [] });
    }
    await new Promise((r) => setTimeout(r, 50));
    Atomics.store(done, 0, 1);
    const { seen, torn } = await result;
    expect(torn).toBe(0);
    expect(seen).toBeGreaterThan(0);
  }, 30_000);
});
