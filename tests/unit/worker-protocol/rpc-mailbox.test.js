import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import {
  createMailbox, respond, prepare, waitForResponse, MAILBOX_PAYLOAD_BYTES,
} from '../../../src/worker-protocol/rpc-mailbox.js';

describe('rpc mailbox', () => {
  it('returns an answer that was written before the worker started waiting', () => {
    const box = createMailbox();
    prepare(box);
    respond(box, { status: 0, data: 'héllo ✓' });
    expect(waitForResponse(box, 100)).toEqual({ ok: true, value: { status: 0, data: 'héllo ✓' } });
  });

  it('times out instead of hanging when nobody answers', () => {
    const box = createMailbox();
    prepare(box);
    expect(waitForResponse(box, 30)).toEqual({ ok: false, error: 'timeout' });
  });

  it('replaces an oversized answer with an error rather than corrupting memory', () => {
    const box = createMailbox();
    prepare(box);
    respond(box, 'x'.repeat(MAILBOX_PAYLOAD_BYTES + 10));
    expect(waitForResponse(box, 100)).toEqual({ ok: true, value: { error: 'response too large' } });
  });

  it('can be reused for consecutive requests', () => {
    const box = createMailbox();
    for (const value of [1, 'two', [3]]) {
      prepare(box); respond(box, value);
      expect(waitForResponse(box, 100)).toEqual({ ok: true, value });
    }
  });

  it('wakes a genuinely blocked worker thread when the main thread answers later', async () => {
    const box = createMailbox();
    const code = `
      const { workerData, parentPort } = require('node:worker_threads');
      const ctrl = new Int32Array(workerData.box, 0, 2);
      Atomics.store(ctrl, 0, 0);
      parentPort.postMessage('waiting');
      const outcome = Atomics.wait(ctrl, 0, 0, 3000);
      const len = Atomics.load(ctrl, 1);
      const bytes = new Uint8Array(workerData.box, 16, len).slice();
      parentPort.postMessage({ outcome, text: new TextDecoder().decode(bytes) });
    `;
    const worker = new Worker(code, { eval: true, workerData: { box } });
    const result = await new Promise((resolve, reject) => {
      worker.on('message', (m) => { if (m === 'waiting') setTimeout(() => respond(box, { ok: 42 }), 50); else resolve(m); });
      worker.on('error', reject);
    });
    expect(result.outcome).toBe('ok');
    expect(JSON.parse(result.text)).toEqual({ ok: 42 });
    await worker.terminate();
  });
});
