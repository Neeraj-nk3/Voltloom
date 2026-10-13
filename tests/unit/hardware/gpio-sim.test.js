import { describe, it, expect, beforeEach } from 'vitest';
import {
  GPIO_IN, GPIO_OUT, PULL_NONE, PULL_UP, PULL_DOWN,
  initPin, setDirection, writePin, readPin, setInputValue, setPull,
  resetAll, getPinState, isPinHigh,
} from '../../../src/hardware/gpio-sim.js';

beforeEach(() => resetAll());

describe('gpio-sim output', () => {
  it('stores written values and reports them for output pins', () => {
    initPin(15); setDirection(15, GPIO_OUT);
    writePin(15, 1);
    expect(readPin(15)).toBe(1);
    expect(isPinHigh(15)).toBe(true);
    writePin(15, 0);
    expect(readPin(15)).toBe(0);
  });

  it('ignores out-of-range pins without throwing', () => {
    expect(() => { writePin(-1, 1); writePin(30, 1); setInputValue(99, 1); }).not.toThrow();
    expect(readPin(30)).toBe(0);
    expect(getPinState(30)).toBeNull();
  });
});

describe('gpio-sim input and pulls', () => {
  it('floating input follows the pull resistor', () => {
    setDirection(5, GPIO_IN);
    setPull(5, PULL_UP);   expect(readPin(5)).toBe(1);
    setPull(5, PULL_DOWN); expect(readPin(5)).toBe(0);
    setPull(5, PULL_NONE); expect(readPin(5)).toBe(0);
  });

  it('external drive overrides the pull; null releases it', () => {
    setDirection(5, GPIO_IN); setPull(5, PULL_UP);
    setInputValue(5, 0); expect(readPin(5)).toBe(0);
    setInputValue(5, null); expect(readPin(5)).toBe(1);
  });
});

// Interrupts are not the main-thread state engine's job: edge detection and delivery live in the firmware workers and are
// tested in tests/unit/runtime/irq.test.js, tests/unit/runtime/pin-model.test.js and tests/scenario/interrupts.test.js (Python and C).
