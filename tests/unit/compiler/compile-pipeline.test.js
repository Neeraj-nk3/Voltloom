import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileC, CompileError, parseDepFile } from '../../../compiler/lib/compile.js';
import { resolveEmcc } from '../../../compiler/lib/emcc.js';

const baseDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../compiler');
const emcc = resolveEmcc();
const real = emcc ? it : it.skip;   // needs Emscripten on PATH (or EMCC_PATH); see README
const SLOW = 180_000;

const blink = fs.readFileSync(path.join(baseDir, '..', 'examples', 'c', 'blink.c'), 'utf8');
const failure = async (code, opts = {}) => {
  try { await compileC(code, { baseDir, emcc, ...opts }); } catch (e) { return e; }
  return null;
};
// With -sSINGLE_FILE the wasm bytes are embedded in the JS; printable data such as string literals stays readable.
const leftoverWorkDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('voltloom-build-')).length;

describe('parseDepFile', () => {
  it('parses make-style dependency lists with continuations and escaped spaces', () => {
    const text = 'out.i: a.c \\\n  sdk/pico/stdlib.h C:/some\\ dir/x.h\n';
    expect(parseDepFile(text)).toEqual(['a.c', 'sdk/pico/stdlib.h', 'C:/some dir/x.h']);
  });
});

describe('compileC: refusals that need no compiler', () => {
  it('rejects a host-file include before any process is started', async () => {
    const err = await failure('#include "/etc/passwd"\nint main(){return 0;}', { emcc: null });
    expect(err).toBeInstanceOf(CompileError);
    expect(err.kind).toBe('rejected');
  });

  it('reports "unavailable" when Emscripten is missing', async () => {
    const err = await failure('int main(){return 0;}', { emcc: null });
    expect(err.kind).toBe('unavailable');
  });
});

describe('compileC: real compiler', () => {
  real('compiles the unmodified blink example to a single-file ES module', async () => {
    const { js } = await compileC(blink, { baseDir, emcc });
    expect(js).toContain('createModule');
    expect(js.length).toBeGreaterThan(10_000);
    expect(js).toContain('WebAssembly');
  }, SLOW);

  real('reports ordinary compile errors without leaking temporary paths', async () => {
    const err = await failure('int main(){ undeclared_function(); return 0; }', {});
    expect(err.kind).toBe('build');
    expect(err.message).toMatch(/undeclared|implicit/i);
    expect(err.message).not.toMatch(/voltloom-build-/);
  }, SLOW);

  real('rejects inline assembly even when the keyword is built by the preprocessor', async () => {
    const code = '#define ASM __asm__\nASM(".inc" "bin \\"/etc/passwd\\"");\nint main(){return 0;}';
    const err = await failure(code);
    expect(err.kind).toBe('rejected');
    expect(err.message).toMatch(/assembly/i);
  }, SLOW);

  real('refuses to build when the preprocessor read a file outside the allowed roots (dependency backstop)', async () => {
    // A policy-clean program that includes <stdio.h> makes the preprocessor read the toolchain's own headers.
    // Telling the pipeline that the toolchain root is somewhere else makes those reads "outside", which
    // is exactly what the backstop must catch.
    const err = await failure(blink, { emcc: { ...emcc, root: os.tmpdir() } });
    expect(err.kind).toBe('rejected');
    expect(err.message).toMatch(/outside the allowed headers/);
  }, SLOW);

  real('a path-style include is already refused by the source policy', async () => {
    const err = await failure(['#include "../server.js"', 'int main(){return 0;}'].join('\n'));
    expect(err.kind).toBe('rejected');
  }, SLOW);

  real('cleans up its temporary workspace on success and on failure', async () => {
    const before = leftoverWorkDirs();
    await compileC(blink, { baseDir, emcc });
    await failure('int main(){ return }');
    expect(leftoverWorkDirs()).toBe(before);
  }, SLOW);

  real('simultaneous builds do not interfere with each other', async () => {
    const program = (tag) => `#include "pico/stdlib.h"\nint main(){ stdio_init_all(); printf("${tag}"); return 0; }`;
    const tags = ['UNIQUE_TAG_ALPHA', 'UNIQUE_TAG_BRAVO', 'UNIQUE_TAG_CHARLIE'];
    const results = await Promise.all(tags.map((t) => compileC(program(t), { baseDir, emcc })));
    results.forEach((r, i) => {
      expect(r.js).toContain(tags[i]);
      tags.filter((_, j) => j !== i).forEach((other) => expect(r.js).not.toContain(other));
    });
  }, SLOW * 2);

  real('stops a build that exceeds the time limit', async () => {
    const err = await failure(blink, { timeoutMs: 50 });
    expect(err.kind).toBe('timeout');
  }, SLOW);
});
