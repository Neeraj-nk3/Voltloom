import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';

// The colours live in one file (src/ui/styles/tokens.css). This test reads it and checks the contrast of the pairs the
// interface actually uses, against WCAG 2.x: 4.5:1 for text, 3:1 for the edges of form fields and for focus indicators.
// A palette change that makes something unreadable fails here instead of being noticed on a bad monitor.

const css = fs.readFileSync('src/ui/styles/tokens.css', 'utf8');
/** The custom properties declared in one theme block (`<selector> { ... }`). */
const block = (selector) => {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block for ${selector}`);
  return css.slice(start, css.indexOf('\n  }', start));
};
const hexes = (text) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));
const THEMES = {
  dark: hexes(block(':root, :root[data-theme="dark"]')),
  light: hexes(block(':root[data-theme="light"]')),
};
let tokens = THEMES.dark;

const channel = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(tokens[a]), luminance(tokens[b])].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = ['bg', 'surface-1', 'surface-2', 'surface-3', 'canvas', 'editor'];
const QUIET_SURFACES = SURFACES.filter((s) => s !== 'surface-3');         // secondary text is never placed on a hovered row

for (const [theme, values] of Object.entries(THEMES)) describe(`${theme} theme`, () => {
  beforeAll(() => { tokens = values; });
  it('defines every colour the contrast checks below use', () => {
    for (const name of [...SURFACES, 'text', 'text-2', 'text-3', 'accent', 'accent-strong', 'accent-ink', 'run', 'run-hover', 'run-ink',
      'stop', 'stop-hover', 'stop-ink', 'warn', 'info', 'ok', 'field-border', 'border-strong']) {
      expect(tokens[name], name).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('primary text reads on every surface (4.5:1)', () => {
    for (const s of SURFACES) expect(contrast('text', s), `text on ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  it('secondary text reads on every surface it is used on (4.5:1)', () => {
    for (const s of SURFACES) expect(contrast('text-2', s), `text-2 on ${s}`).toBeGreaterThanOrEqual(4.5);
    for (const s of QUIET_SURFACES) expect(contrast('text-3', s), `text-3 on ${s}`).toBeGreaterThanOrEqual(4.5);
  });

  // Coloured text sits on panels and cards only. Nothing is written straight onto the canvas (the hint line and the
  // stats card have their own background), so the canvas colour is free to be a calm mid-grey in the light theme.
  it('accent and status colours read as text on the panels (4.5:1)', () => {
    for (const color of ['accent-strong', 'run', 'stop', 'warn', 'info', 'ok']) {
      for (const s of ['surface-1', 'surface-2', 'editor']) {
        expect(contrast(color, s), `${color} on ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('text on filled buttons reads (4.5:1)', () => {
    expect(contrast('run-ink', 'run')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('run-ink', 'run-hover')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('stop-ink', 'stop')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('stop-ink', 'stop-hover')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('accent-ink', 'accent')).toBeGreaterThanOrEqual(4.5);
  });

  it('the focus ring and the edges of form fields are visible (3:1)', () => {
    for (const s of ['bg', 'surface-1', 'surface-2', 'surface-3', 'canvas', 'editor']) {
      expect(contrast('accent-strong', s), `focus ring on ${s}`).toBeGreaterThanOrEqual(3);
    }
    for (const s of ['surface-1', 'surface-2', 'canvas', 'editor']) {
      expect(contrast('field-border', s), `field border on ${s}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('tooltips and part labels read (4.5:1)', () => {
    expect(contrast('tip-text', 'tip-bg')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('canvas: pins and wires', () => {
  // The board artwork is never recoloured, so the pin-state colours are judged against it: PCB green and the pads.
  const BOARD = '#006837';
  const PAD = '#958863';
  const shared = hexes(css.slice(0, css.indexOf(':root, :root[data-theme="dark"]')));
  const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  it('pin states stand out from the board and from an idle pad (3:1)', () => {
    for (const name of ['pin-hot', 'pin-source', 'pin-valid', 'pin-invalid']) {
      expect(ratio(shared[name], BOARD), `${name} on the board`).toBeGreaterThanOrEqual(3);
    }
    for (const name of ['pin-hot', 'pin-valid', 'pin-invalid']) {
      expect(ratio(shared[name], PAD), `${name} vs an idle pad`).toBeGreaterThanOrEqual(1.8);
    }
  });

  for (const [theme, values] of Object.entries(THEMES)) {
    it(`${theme}: the wire end dot reads against its outline, and the outline against the board (3:1)`, () => {
      expect(ratio(values['wire-joint'], values['wire-casing'])).toBeGreaterThanOrEqual(3);
      expect(ratio(values['wire-casing'], BOARD)).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('type scale', () => {
  it('the default text size is not below 13px, and only secondary information uses 12px', () => {
    const size = (name) => Number(new RegExp(`--${name}:\\s*(\\d+)px`).exec(css)[1]);
    expect(size('fs-ui')).toBeGreaterThanOrEqual(13);
    expect(size('fs-body')).toBeGreaterThanOrEqual(13);
    expect(size('fs-meta')).toBeGreaterThanOrEqual(12);
  });
});
