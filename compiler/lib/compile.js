/**
 * compile.js — compile one C program to a single-file WebAssembly module
 *
 * Pipeline for each request (every step has its own temporary workspace, deleted at the end):
 *   1. checkSource()   reject sources that name files outside the SDK / standard headers
 *   2. emcc -E         preprocess the user's file only, recording every file the preprocessor read
 *   3. backstops       (a) every file read must be inside the workspace, the SDK or the toolchain
 *                      (b) the user's preprocessed code must not contain inline assembly
 *   4. emcc            compile the PREPROCESSED text (so exactly what was checked is what is built)
 *                      together with the simulator bridge files, and link with the JS library
 *
 * emcc is run through execFile with an argument array (no shell). See lib/emcc.js.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkSource, containsInlineAsm, extractUserLines } from './source-policy.js';
import { resolveEmcc, runEmcc } from './emcc.js';

export class CompileError extends Error {
    /** @param {'rejected'|'build'|'unavailable'|'timeout'|'internal'} kind */
    constructor(kind, message) {
        super(message);
        this.name = 'CompileError';
        this.kind = kind;
    }
}

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const USER_FILE = 'user_main.c';

// Flags are constants; nothing a client sends is ever placed in this list.
const LINK_FLAGS = [
    '-sEXPORTED_FUNCTIONS=_main,_sim_irq_dispatch',   // _sim_irq_dispatch: how the simulator runs the program's GPIO interrupt handler
    '-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8',
    '-sMODULARIZE=1',
    '-sEXPORT_ES6=1',
    '-sEXPORT_NAME=createModule',
    '-sSINGLE_FILE=1',
    '-sENVIRONMENT=web,worker,node',   // the program runs inside a Web Worker (or a Node worker in the scenario runner)
    '-sALLOW_MEMORY_GROWTH=1',
    '-sINITIAL_MEMORY=16777216',
    '-sMAXIMUM_MEMORY=268435456',   // a runaway program cannot grow past 256 MB
    '-sNO_EXIT_RUNTIME=1',
    '-O2'
];

const isInside = (child, root) => {
    const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    const c = norm(child);
    const r = norm(root);
    return c === r || c.startsWith(r + path.sep);
};

/** Parse a Makefile-style dependency file (`target: dep dep \ dep`) into a list of paths. */
export function parseDepFile(text) {
    const joined = text.replace(/\\\r?\n/g, ' ');
    const colon = joined.indexOf(': ');
    const body = colon === -1 ? joined : joined.slice(colon + 2);
    const deps = [];
    let current = '';
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '\\' && body[i + 1] === ' ') { current += ' '; i++; continue; }   // escaped space
        if (/\s/.test(ch)) { if (current) { deps.push(current); current = ''; } continue; }
        current += ch;
    }
    if (current) deps.push(current);
    return deps;
}

function cleanDiagnostics(text, workDir) {
    const withoutPaths = String(text).split(workDir + path.sep).join('').split(workDir).join('');
    const lines = withoutPaths.split('\n');
    const interesting = lines.filter((l) => /error:|warning:|undefined symbol|fatal/.test(l));
    return (interesting.length ? interesting.join('\n') : withoutPaths).slice(0, 4000).trim();
}

/**
 * @param {string} code — user C source
 * @param {object} options
 * @param {string} options.baseDir — compiler directory (holds sdk/include and sdk/src)
 * @param {number} [options.timeoutMs]
 * @param {object|null} [options.emcc] — from resolveEmcc(); resolved on demand if omitted
 * @returns {Promise<{js: string}>}
 * @throws {CompileError}
 */
export async function compileC(code, { baseDir, timeoutMs = 60_000, emcc = resolveEmcc() }) {
    const sdkDir = path.join(baseDir, 'sdk', 'include');
    const simDir = path.join(baseDir, 'sdk', 'src');

    const policy = checkSource(code, { sdkDir });
    if (!policy.ok) throw new CompileError('rejected', policy.reason);
    if (!emcc) throw new CompileError('unavailable', 'The C compiler (Emscripten) is not installed or not on PATH');

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voltloom-build-'));
    try {
        const userC = path.join(workDir, USER_FILE);
        const userI = path.join(workDir, 'user_main.i');
        const depFile = path.join(workDir, 'deps.d');
        const appJs = path.join(workDir, 'main.js');
        await fs.writeFile(userC, code, 'utf-8');

        // 2. Preprocess only the user's file.
        const pre = await runEmcc(emcc, ['-E', '-I', 'sdk/include', '-MD', '-MF', depFile, '-o', userI, userC], { cwd: baseDir, timeoutMs });
        if (pre.timedOut) throw new CompileError('timeout', 'Compilation took too long and was stopped');
        if (pre.code !== 0) throw new CompileError('build', cleanDiagnostics(pre.stderr || pre.stdout, workDir) || 'Preprocessing failed');

        // 3a. Every file the preprocessor opened must be one we expect.
        const allowedRoots = [workDir, sdkDir, emcc.root];
        const deps = parseDepFile(await fs.readFile(depFile, 'utf-8'));
        for (const dep of deps) {
            const resolved = path.resolve(baseDir, dep);
            if (!allowedRoots.some((root) => isInside(resolved, root))) {
                throw new CompileError('rejected', 'The program reads a file outside the allowed headers');
            }
        }

        // 3b. No inline assembly in the user's own (expanded) code.
        const preprocessed = await fs.readFile(userI, 'utf-8');
        if (containsInlineAsm(extractUserLines(preprocessed, USER_FILE))) {
            throw new CompileError('rejected', 'Inline assembly is not allowed');
        }

        // 4. Compile the checked text with the bridge files and link.
        const simFiles = (await fs.readdir(simDir)).filter((f) => f.endsWith('.c')).sort().map((f) => `sdk/src/${f}`);
        const build = await runEmcc(emcc, [
            userI, ...simFiles, '-I', 'sdk/include', '-o', appJs, ...LINK_FLAGS, '--js-library', 'sdk/src/js-library.js'
        ], { cwd: baseDir, timeoutMs });
        if (build.timedOut) throw new CompileError('timeout', 'Compilation took too long and was stopped');

        let output = null;
        try { output = await fs.readFile(appJs, 'utf-8'); } catch { /* handled below */ }
        if (build.code !== 0 || output === null) {
            throw new CompileError('build', cleanDiagnostics(build.stderr || build.stdout, workDir) || 'Unknown compilation error');
        }
        if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) throw new CompileError('build', 'The compiled program is too large');
        return { js: output };
    } catch (err) {
        if (err instanceof CompileError) throw err;
        throw new CompileError('internal', 'Internal compiler error');
    } finally {
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}
