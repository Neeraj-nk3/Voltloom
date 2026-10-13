import { describe, it, expect } from 'vitest';
import { createEventBatcher } from '../../../src/runtime/common/event-batcher.js';

/** A batcher driven by a fake clock and a fake timer so timing is exact. */
function harness(options = {}) {
  const sent = [];
  let time = 1000;
  let scheduled = null;
  const b = createEventBatcher({
    send: (m) => sent.push(m),
    now: () => time,
    setTimer: (fn, ms) => { scheduled = { fn, at: time + ms }; return scheduled; },
    clearTimer: () => { scheduled = null; },
    ...options,
  });
  return {
    b, sent,
    advance(ms) { time += ms; if (scheduled && time >= scheduled.at) { const { fn } = scheduled; scheduled = null; fn(); } },
    timerArmed: () => scheduled !== null,
  };
}
const write = (pin, value) => ({ type: 'pin.write', pin, value });
const flat = (sent) => sent.flatMap((m) => m.events);

describe('event batcher: normal use is not delayed', () => {
  it('sends the first event of a quiet period immediately', () => {
    const h = harness();
    h.b.push({ type: 'stdout', text: 'hello' });
    expect(h.sent).toEqual([{ type: 'events', events: [{ type: 'stdout', text: 'hello' }] }]);
  });

  it('sends a burst up to the limit immediately and in order', () => {
    const h = harness({ burstLimit: 4 });
    for (let i = 0; i < 4; i++) h.b.push({ type: 'stdout', text: String(i) });
    expect(flat(h.sent).map((e) => e.text)).toEqual(['0', '1', '2', '3']);
    expect(h.b.pending()).toBe(0);
  });

  it('immediate: true flushes even beyond the burst limit (used before a worker blocks)', () => {
    const h = harness({ burstLimit: 1 });
    h.b.push({ type: 'stdout', text: 'a' });
    h.b.push({ type: 'stdout', text: 'b' });                  // over the limit: buffered
    expect(h.b.pending()).toBe(1);
    h.b.push({ type: 'debug.paused', line: 3 }, { immediate: true });
    expect(flat(h.sent).map((e) => e.text ?? e.type)).toEqual(['a', 'b', 'debug.paused']);
  });
});

describe('event batcher: floods are throttled', () => {
  it('buffers beyond the burst limit and flushes when the window rolls over', () => {
    const h = harness({ burstLimit: 2, intervalMs: 16 });
    for (let i = 0; i < 6; i++) h.b.push({ type: 'stdout', text: String(i) });
    expect(flat(h.sent)).toHaveLength(2);
    expect(h.timerArmed()).toBe(true);
    h.advance(16);                                             // timer fires
    expect(flat(h.sent).map((e) => e.text)).toEqual(['0', '1', '2', '3', '4', '5']);
  });

  it('collapses consecutive writes to the same pin to the newest', () => {
    const h = harness({ burstLimit: 1 });
    h.b.push(write(15, 1));                                    // sent
    for (let i = 0; i < 100; i++) h.b.push(write(15, i % 2));  // collapse into one pending write
    expect(h.b.pending()).toBe(1);
    h.advance(16);
    expect(flat(h.sent).at(-1)).toEqual(write(15, 1));         // i = 99 -> value 1
  });

  it('does not collapse writes to different pins or non-adjacent writes', () => {
    const h = harness({ burstLimit: 1 });
    h.b.push(write(1, 1));
    h.b.push(write(1, 0)); h.b.push(write(2, 1)); h.b.push(write(1, 1));
    h.advance(16);
    expect(flat(h.sent).slice(1)).toEqual([write(1, 0), write(2, 1), write(1, 1)]);
  });

  it('is bounded: when full it keeps the newest write per pin and counts dropped output', () => {
    const h = harness({ burstLimit: 0, maxPending: 3 });
    ['a', 'b', 'c'].forEach((t) => h.b.push({ type: 'stdout', text: t }));   // fills the buffer
    h.b.push({ type: 'stdout', text: 'lost-1' });
    h.b.push({ type: 'stdout', text: 'lost-2' });
    h.b.push(write(15, 1)); h.b.push(write(15, 0)); h.b.push(write(16, 1));  // newest per pin survives
    h.advance(16);
    const events = flat(h.sent);
    expect(events.filter((e) => e.type === 'stdout').map((e) => e.text)).toEqual(['a', 'b', 'c']);
    expect(events).toContainEqual({ type: 'overflow', dropped: 2 });
    expect(events).toContainEqual(write(15, 0));
    expect(events).toContainEqual(write(16, 1));
    expect(events).not.toContainEqual(write(15, 1));
  });

  it('sends nothing when there is nothing pending', () => {
    const h = harness();
    h.b.flush();
    expect(h.sent).toEqual([]);
  });
});
