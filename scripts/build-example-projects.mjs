// Builds examples/projects/*.project.json from examples/examples.json (the programs in examples/python and examples/c plus
// the circuits defined here), in the same project format the app saves (see docs/project-format.md).
//
//   node scripts/build-example-projects.mjs           write the files
//   node scripts/build-example-projects.mjs --check   fail if a checked-in file differs from what would be written
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject } from '../src/project/project-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gpio = (pin) => ({ nodeType: 'gpio', pin });
const part = (componentId, pin) => ({ nodeType: 'component_pin', componentId, pin });
const wire = (id, start, end, color = '#15803d') => ({ id, start, end, color });

// Physical pins on the Pico header: GP0 = 1, GP15 = 20, GND.1 = 3.
const LED = { id: 'led_1', type: 'led', x: 300, y: 300, rotation: 0, color: '#ef4444' };
const RESISTOR = { id: 'res_1', type: 'resistor', x: 50, y: 300, rotation: 0, value: 330, unit: 1 };
const BUTTON = { id: 'btn_1', type: 'button', x: 100, y: 600, rotation: 0 };
const LED_WIRES = [
  wire('wire_1', gpio(20), part('res_1', '1')),     // GP15 -> 330 ohm
  wire('wire_2', part('res_1', '2'), part('led_1', 'A')),
  wire('wire_3', gpio(3), part('led_1', 'C')),      // LED cathode -> GND
];
const BUTTON_WIRES = [
  wire('wire_4', gpio(1), part('btn_1', '1')),      // GP0 -> button
  wire('wire_5', gpio(3), part('btn_1', '3')),      // button -> GND
];

// Traffic light: one row per light, each from a header pin on the right through a 220 ohm resistor to an LED turned to
// face it, with the LED's cathode wired to the GND pin just above that row (GP22/GND.7, GP19/GND.6, GP16/GND.5).
const TRAFFIC_ROWS = [
  { n: 1, pin: 29, gnd: 33, y: 620, led: '#ef4444', wire: '#ef4444' },
  { n: 2, pin: 25, gnd: 28, y: 820, led: '#facc15', wire: '#f59e0b' },
  { n: 3, pin: 21, gnd: 23, y: 1020, led: '#22c55e', wire: '#22c55e' },
];
const TRAFFIC_LIGHT = {
  components: TRAFFIC_ROWS.flatMap((r) => [
    { id: `res_${r.n}`, type: 'resistor', x: 470, y: r.y - 20, rotation: 0, value: 220, unit: 1 },
    { id: `led_${r.n}`, type: 'led', x: 775, y: r.y - 130, rotation: 90, color: r.led },
  ]),
  connections: TRAFFIC_ROWS.flatMap((r) => [
    wire(`wire_${r.n * 3 - 2}`, gpio(r.pin), part(`res_${r.n}`, '1'), r.wire),
    wire(`wire_${r.n * 3 - 1}`, part(`res_${r.n}`, '2'), part(`led_${r.n}`, 'A'), r.wire),
    wire(`wire_${r.n * 3}`, part(`led_${r.n}`, 'C'), gpio(r.gnd), '#1f2937'),
  ]),
};

export const CIRCUITS = {
  'traffic-light': TRAFFIC_LIGHT,
  led: { components: [RESISTOR, LED], connections: LED_WIRES },
  'led-button': { components: [RESISTOR, LED, BUTTON], connections: [...LED_WIRES, ...BUTTON_WIRES] },
};

export function loadManifest() {
  return JSON.parse(fs.readFileSync(path.join(root, 'examples', 'examples.json'), 'utf8')).examples;
}

export function buildProject(example) {
  // LF always: a Windows checkout (core.autocrlf) has CRLF files, and the projects must not depend on the checkout
  const code = fs.readFileSync(path.join(root, 'examples', example.file), 'utf8').replace(/\r\n/g, '\n');
  const circuit = CIRCUITS[example.circuit];
  if (!circuit) throw new Error(`example ${example.id}: unknown circuit "${example.circuit}"`);
  return createProject(code, example.language, circuit.components, circuit.connections, 'pico_w');
}

const check = process.argv.includes('--check');
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stale = 0;
  for (const example of loadManifest()) {
    const target = path.join(root, 'examples', 'projects', `${example.id}.project.json`);
    const text = JSON.stringify(buildProject(example), null, 2) + '\n';
    if (check) {
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text) { console.error(`out of date: examples/projects/${example.id}.project.json`); stale++; }
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
      console.log(`wrote examples/projects/${example.id}.project.json`);
    }
  }
  if (stale) { console.error('run: node scripts/build-example-projects.mjs'); process.exit(1); }
  if (check) console.log('example projects are up to date');
}
