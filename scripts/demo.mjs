// A repeatable demonstration of what Voltloom does, with no browser and no clicking.
//
//   node scripts/demo.mjs            run every example in examples/examples.json and print what it did
//   node scripts/demo.mjs --json     the same, as JSON (identical on every run: the clock is virtual)
//
// Each example is run by the scenario runner (src/scenario/runner.js) on the same firmware runtimes, pin model and
// circuit solver the browser uses, against the circuit named in the manifest, with the scripted button presses listed there.
// C examples need Emscripten (EMCC_PATH or emcc on PATH); without it they are reported as skipped, never as passed.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, pinWrites } from '../src/scenario/runner.js';
import { ledBrightness } from '../src/electrical/led-model.js';
import { CIRCUITS, loadManifest } from './build-example-projects.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');

export const hasEmcc = () => {
  if (process.env.EMCC_PATH) return true;
  try { execSync('emcc --version', { stdio: 'ignore' }); return true; } catch { return false; }
};

/** Run one manifest entry and return everything the demo and the examples test look at. */
export async function runExample(example) {
  const circuit = CIRCUITS[example.circuit];
  const result = await runScenario({
    language: example.language,
    code: fs.readFileSync(path.join(root, 'examples', example.file), 'utf8'),
    components: circuit.components,
    connections: circuit.connections,
    script: example.script || [],
    untilMs: example.untilMs,
    followResets: !!example.followResets
  });
  const led = result.electrical && result.electrical.parts && result.electrical.parts.led_1;
  return {
    ended: result.ended,
    stdout: result.stdout,
    ledLevels: pinWrites(result, 15).map((w) => w.value).filter((v, i, all) => i === 0 || v !== all[i - 1]),   // GP15 level changes
    ledMilliamps: led ? Math.round(led.current * 1e5) / 100 : null,
    ledLit: led ? ledBrightness(led.current) > 0 : null,
    boots: result.boots ? result.boots.length : 1,
    warnings: (result.electrical && result.electrical.warnings ? result.electrical.warnings : []).map((w) => w.message || String(w)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const emcc = hasEmcc();
  const report = [];
  for (const example of loadManifest()) {
    if (example.language === 'c' && !emcc) { report.push({ id: example.id, skipped: 'needs Emscripten (EMCC_PATH or emcc on PATH)' }); continue; }
    report.push({ id: example.id, language: example.language, summary: example.summary, ...(await runExample(example)) });
  }
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Voltloom demo: each example runs headlessly on the virtual clock (identical output on every run)\n');
    for (const r of report) {
      if (r.skipped) { console.log(`- ${r.id}: SKIPPED, ${r.skipped}\n`); continue; }
      console.log(`- ${r.id} (${r.language}): ${r.summary}`);
      console.log(`    ended: ${r.ended}${r.boots > 1 ? ` after ${r.boots} boots` : ''}`);
      if (r.stdout.length) console.log(`    console: ${r.stdout.join(' | ')}`);
      console.log(`    GP15 changes: [${r.ledLevels.join(', ')}]   LED at the end: ${r.ledLit ? `lit, ${r.ledMilliamps} mA` : 'dark'}\n`);
    }
  }
}
