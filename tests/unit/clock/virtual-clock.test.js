import { describe, it, expect } from 'vitest';
import { VirtualClock } from '../../../src/clock/virtual-clock.js';

/** A fake wall clock whose waits move it forward, so the tests are exact and instant. */
function fakeWall() {
  const wall = { ms: 1000, waits: [] };
  wall.now = () => wall.ms;
  wall.wait = (ms) => { wall.waits.push(ms); wall.ms += ms; };
  return wall;
}

describe('fast mode', () => {
  it('sleep advances virtual time exactly and never waits', () => {
    const wall = fakeWall();
    const clock = new VirtualClock({ mode: 'fast', wallNowMs: wall.now, waitMs: wall.wait });
    clock.sleepUs(500_000); clock.sleepUs(250_000);
    expect(clock.nowUs()).toBe(750_000);
    expect(wall.waits).toEqual([]);
  });

  it('every read costs 1 us, so busy-wait loops progress and end at the same virtual time', () => {
    const run = () => {
      const clock = new VirtualClock({ mode: 'fast' });
      let reads = 0;
      while (clock.tick() < 1000) reads++;          // while (time_us_64() < 1000) {}
      return [reads, clock.nowUs()];
    };
    expect(run()).toEqual(run());
    expect(run()).toEqual([999, 1000]);
  });

  it('nowUs() itself is free', () => {
    const clock = new VirtualClock({ mode: 'fast' });
    for (let i = 0; i < 100; i++) clock.nowUs();
    expect(clock.nowUs()).toBe(0);
  });

  it('bad sleep arguments count as zero (they never move time backwards or to NaN)', () => {
    const clock = new VirtualClock({ mode: 'fast' });
    clock.sleepUs(-5); clock.sleepUs(NaN); clock.sleepUs(Infinity); clock.sleepUs(undefined);
    expect(clock.nowUs()).toBe(0);
  });

  it('listeners see every advance as (from, to), in order, before the program resumes', () => {
    const clock = new VirtualClock({ mode: 'fast' });
    const seen = [];
    clock.onAdvance((from, to) => seen.push([from, to]));
    clock.sleepUs(100); clock.tick(); clock.sleepUs(50);
    expect(seen).toEqual([[0, 100], [100, 101], [101, 151]]);
  });

  it('the identical sequence of calls gives the identical timeline (determinism)', () => {
    const trace = () => {
      const clock = new VirtualClock({ mode: 'fast' });
      const out = [];
      for (let i = 0; i < 50; i++) { clock.sleepUs(1000 * (i % 7)); out.push(clock.tick()); }
      return out;
    };
    expect(trace()).toEqual(trace());
  });
});

describe('realtime mode', () => {
  it('a sleep waits until the wall clock reaches the virtual time', () => {
    const wall = fakeWall();
    const clock = new VirtualClock({ mode: 'realtime', wallNowMs: wall.now, waitMs: wall.wait });
    clock.sleepUs(500_000);
    expect(wall.waits.reduce((a, b) => a + b, 0)).toBeCloseTo(500, 6);
    expect(wall.ms - 1000).toBeCloseTo(500, 6);
    clock.sleepUs(250_000);
    expect(wall.ms - 1000).toBeCloseTo(750, 6);       // total elapsed wall time equals total virtual time
    expect(clock.nowUs()).toBe(750_000);
  });

  it('time the program spent computing counts toward its sleep (no drift)', () => {
    const wall = fakeWall();
    const clock = new VirtualClock({ mode: 'realtime', wallNowMs: wall.now, waitMs: wall.wait });
    wall.ms += 100;                                     // the program computed for 100 ms of wall time
    clock.sleepUs(500_000);
    expect(wall.ms - 1000).toBeGreaterThanOrEqual(500); // the period is still 500 ms in total, not 600
    expect(wall.ms - 1000).toBeLessThan(700);
  });

  it('after a long stall (debugger pause, heavy computation) it jumps forward instead of replaying a burst', () => {
    const wall = fakeWall();
    const clock = new VirtualClock({ mode: 'realtime', wallNowMs: wall.now, waitMs: wall.wait });
    wall.ms += 10_000;                                  // 10 s paused at a breakpoint
    clock.sleepUs(100_000);
    expect(clock.nowUs()).toBeGreaterThan(10_000_000);  // virtual time resynchronised
    expect(wall.waits.reduce((a, b) => a + b, 0)).toBeLessThan(150);   // and the next sleep still lasts about 100 ms
  });

  it('pin reads only wait once the virtual clock is more than 1 ms ahead (no wait per read)', () => {
    const wall = fakeWall();
    const clock = new VirtualClock({ mode: 'realtime', wallNowMs: wall.now, waitMs: wall.wait });
    for (let i = 0; i < 500; i++) clock.tick();         // 500 us of virtual time, well under the threshold
    expect(wall.waits).toEqual([]);
    for (let i = 0; i < 1000; i++) clock.tick();        // now 1.5 ms ahead: it has to wait
    expect(wall.waits.length).toBeGreaterThan(0);
  });

  it('a busy-wait on the clock lasts about as long as it says in real time', () => {
    const wall = fakeWall();
    const clock = new VirtualClock({ mode: 'realtime', wallNowMs: wall.now, waitMs: wall.wait });
    while (clock.tick() < 20_000) { /* busy_wait 20 ms */ }
    expect(wall.ms - 1000).toBeGreaterThan(18);
    expect(wall.ms - 1000).toBeLessThan(22);
  });

  it('the same program has the same virtual timeline in both modes', () => {
    const timeline = (mode) => {
      const wall = fakeWall();
      const clock = new VirtualClock({ mode, wallNowMs: wall.now, waitMs: wall.wait });
      const out = [];
      for (let i = 0; i < 20; i++) { clock.sleepUs(10_000 * (i % 3)); out.push(clock.tick()); }
      return out;
    };
    expect(timeline('realtime')).toEqual(timeline('fast'));
  });
});

describe('configuration', () => {
  it('rejects an unknown mode', () => {
    expect(() => new VirtualClock({ mode: 'turbo' })).toThrow(/unknown clock mode/);
  });
  it('uses real waiting and the real wall clock by default (a 30 ms sleep really takes about 30 ms)', () => {
    const clock = new VirtualClock({ mode: 'realtime' });
    const t = performance.now();
    clock.sleepUs(30_000);
    const took = performance.now() - t;
    expect(took).toBeGreaterThan(25);
    expect(took).toBeLessThan(200);
  });
});

describe('beforeWait', () => {
  it('is called right before every blocking wait (a worker flushes its pending events first), never in fast mode', () => {
    const wall = fakeWall();
    const calls = [];
    const real = new VirtualClock({ mode: 'realtime', wallNowMs: wall.now, waitMs: (ms) => { calls.push('wait'); wall.wait(ms); }, beforeWait: () => calls.push('flush') });
    real.sleepUs(100_000);
    expect(calls.slice(0, 2)).toEqual(['flush', 'wait']);
    const fast = new VirtualClock({ mode: 'fast', beforeWait: () => { throw new Error('should not be called'); } });
    expect(() => fast.sleepUs(1_000_000)).not.toThrow();
  });
});

describe('wake points and the interrupt hook', () => {
  it('a sleep is split at wake points: listeners and the hook run at exactly that time, and the sleep still ends on time', () => {
    const clock = new VirtualClock({ mode: 'fast' });
    const events = [{ atUs: 300_000 }, { atUs: 700_000 }];
    let next = 0;
    const seen = [];
    clock.addWakeSource(() => (next < events.length ? events[next].atUs : Infinity));
    clock.onAdvance((from, to) => { while (next < events.length && events[next].atUs <= to) { seen.push(['event', to]); next++; } });
    clock.setInterruptHook(() => seen.push(['hook', clock.nowUs()]));
    clock.sleepUs(1_000_000);
    expect(seen).toEqual([['event', 300_000], ['hook', 300_000], ['event', 700_000], ['hook', 700_000], ['hook', 1_000_000]]);
    expect(clock.nowUs()).toBe(1_000_000);
  });

  it('the hook runs after every read, never re-entrantly, and may sleep and read itself (a handler that takes time)', () => {
    const clock = new VirtualClock({ mode: 'fast' });
    let depth = 0; let maxDepth = 0; let calls = 0;
    clock.setInterruptHook(() => {
      depth++; maxDepth = Math.max(maxDepth, depth); calls++;
      if (calls === 1) { clock.sleepUs(50); clock.tick(); }       // the handler takes 51 us
      depth--;
    });
    clock.tick();
    expect(maxDepth).toBe(1);
    expect(clock.nowUs()).toBe(1 + 50 + 1);
  });

  it('a handler that runs during a sleep delays the program but not the wake-up time of the sleep', () => {
    const clock = new VirtualClock({ mode: 'fast' });
    let fired = false;
    clock.addWakeSource(() => (fired ? Infinity : 400));
    clock.onAdvance((from, to) => { if (to >= 400) fired = true; });
    clock.setInterruptHook(() => { if (fired && !clock.handlerRan) { clock.handlerRan = true; clock.sleepUs(100); } });
    clock.sleepUs(1000);
    expect(clock.nowUs()).toBe(1000);              // 400 + the 100 us the handler took is inside the 1000 us sleep
  });

  it('wake points in the past or at the current time are ignored (no endless loop)', () => {
    const clock = new VirtualClock({ mode: 'fast' });
    clock.addWakeSource(() => 0);
    clock.sleepUs(500);
    expect(clock.nowUs()).toBe(500);
  });

  it('realtime: an early wake-up (a notify from the main thread) runs the hook at the current time and the sleep continues', () => {
    const wall = fakeWall();
    const hookTimes = [];
    let waitCalls = 0;
    const clock = new VirtualClock({
      mode: 'realtime', wallNowMs: wall.now,
      waitMs: (ms) => { waitCalls++; wall.ms += waitCalls === 1 ? ms / 4 : ms; },     // the first wait is cut short after a quarter
    });
    clock.setInterruptHook(() => hookTimes.push(Math.round(clock.nowUs())));
    clock.sleepUs(400_000);
    expect(hookTimes[0]).toBe(100_000);                // woke at 100 ms of wall time and the clock followed it
    expect(clock.nowUs()).toBe(400_000);
    expect(wall.ms - 1000).toBeCloseTo(400, 6);        // total real time is still the sleep length
  });
});
