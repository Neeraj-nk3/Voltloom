import { describe, it, expect, beforeEach } from 'vitest';
import { initSharedMemory, updateInputState } from '../../../src/hardware/gpio-bridge.js';
import { FLOATING } from '../../../src/worker-protocol/pin-levels.js';
import { resetAll, getPinState } from '../../../src/hardware/gpio-sim.js';

let shared;
beforeEach(() => {
  resetAll();
  shared = new Int32Array(new SharedArrayBuffer(1024));
  initSharedMemory(shared);
});

describe('shared input buffer', () => {
  it('starts with every pin floating (not a hard-coded 1)', () => {
    expect(shared[0]).toBe(FLOATING);
    expect(shared[29]).toBe(FLOATING);
  });

  it('publishes the DRIVE (0/1/floating), never the pull-resolved level', () => {
    updateInputState(4, 0, shared, null);    expect(shared[4]).toBe(0);
    updateInputState(4, 1, shared, null);    expect(shared[4]).toBe(1);
    updateInputState(4, null, shared, null); expect(shared[4]).toBe(FLOATING);
    expect(getPinState(4).externalDrive).toBeNull();
  });

  it('a fresh buffer is written again even if the value is unchanged since the last run', () => {
    updateInputState(7, 0, shared, null);
    const second = new Int32Array(new SharedArrayBuffer(1024));
    initSharedMemory(second);                // new run, new buffer
    updateInputState(7, 0, second, null);
    expect(second[7]).toBe(0);
  });

  it('falls back to a pin.input message when there is no shared buffer', () => {
    const sent = [];
    const worker = { postMessage: (m) => sent.push(m) };
    updateInputState(9, null, null, worker);
    updateInputState(9, 1, null, worker);
    expect(sent).toEqual([{ type: 'pin.input', pin: 9, value: FLOATING }, { type: 'pin.input', pin: 9, value: 1 }]);
  });
});
