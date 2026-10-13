import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runExample } from '../../scripts/demo.mjs';
import { buildProject, loadManifest } from '../../scripts/build-example-projects.mjs';
import { validateProject } from '../../src/project/project-schema.js';
import { cIt } from '../support/emcc.js';

// Every program in examples/ is listed in examples/examples.json with the behaviour it is documented to have, and this
// test runs each one on the real firmware runtimes and circuit solver and checks that behaviour. An example that is not
// listed, or that no longer does what the manifest says, fails here.

const examples = loadManifest();
const listed = (dir) => fs.readdirSync(path.join('examples', dir)).filter((f) => /\.(py|c)$/.test(f)).map((f) => `${dir}/${f}`).sort();
const observed = (got) => ({ ended: got.ended, boots: got.boots, stdout: got.stdout, ledLevels: got.ledLevels, ledLitAtEnd: got.ledLit });

describe('examples manifest', () => {
  it('lists every program under examples/python and examples/c, and nothing else', () => {
    expect(examples.map((e) => e.file).sort()).toEqual([...listed('python'), ...listed('c')].sort());
  });

  it('has a checked-in project file for each example that is exactly what the build script produces, and the app accepts it', () => {
    for (const example of examples) {
      const target = path.join('examples', 'projects', `${example.id}.project.json`);
      const stored = JSON.parse(fs.readFileSync(target, 'utf8'));
      expect(stored, `${target} is out of date: run node scripts/build-example-projects.mjs`).toEqual(JSON.parse(JSON.stringify(buildProject(example))));
      const checked = validateProject(stored);
      expect(checked.ok, `${target}: ${JSON.stringify(checked.errors)}`).toBe(true);
      expect(stored.code).toBe(fs.readFileSync(path.join('examples', example.file), 'utf8'));
    }
    expect(fs.readdirSync('examples/projects').filter((f) => f.endsWith('.project.json')).length).toBe(examples.length);
  });
});

describe('Python examples do what examples/examples.json says', () => {
  for (const example of examples.filter((e) => e.language === 'python')) {
    it(`${example.id}: ${example.summary}`, async () => {
      expect(observed(await runExample(example))).toEqual(example.expect);
    }, 60_000);
  }
});

describe('C examples do what examples/examples.json says (needs Emscripten)', () => {
  for (const example of examples.filter((e) => e.language === 'c')) {
    cIt(`${example.id}: ${example.summary}`, async () => {
      expect(observed(await runExample(example))).toEqual(example.expect);
    }, 180_000);
  }
});

describe('the demo is repeatable', () => {
  it('running the same example twice gives identical results', async () => {
    const example = examples.find((e) => e.id === 'python-button-irq');
    expect(await runExample(example)).toEqual(await runExample(example));
  }, 60_000);
});
