import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { PICO_ENV, buildDiagram } from '../../../src/circuit/diagram.js';

// The exported diagram says which MicroPython runtime it was made for. That must be the runtime that is actually bundled.

describe('diagram runtime version', () => {
  it('PICO_ENV names the version and build date reported by the bundled MicroPython binary', () => {
    const binary = fs.readFileSync('runtimes/micropython/micropython.wasm').toString('latin1');
    const match = /MicroPython v(\d+\.\d+\.\d+) on (\d{4})-(\d\d)-(\d\d)/.exec(binary);
    expect(match, 'version string inside runtimes/micropython/micropython.wasm').not.toBeNull();
    const [, version, year, month, day] = match;
    expect(PICO_ENV).toBe(`micropython-${year}${month}${day}-v${version}`);
  });

  it('the exported diagram carries it', () => {
    const diagram = buildDiagram([], [], []);
    expect(diagram.parts[0].attrs.env).toBe(PICO_ENV);
    expect(diagram.editor).toBe('Voltloom');
  });
});
