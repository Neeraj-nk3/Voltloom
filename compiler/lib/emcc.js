/**
 * emcc.js — locate and run the Emscripten compiler without a shell
 *
 * Arguments are always passed as an array to execFile, never concatenated into a command line,
 * so nothing a client sends can be interpreted by a shell.
 *
 * On Windows `emcc` is a .bat wrapper, which Node refuses to spawn without a shell; the wrapper
 * only forwards to `python emcc.py`, so we call that directly.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';

function findOnPath(names, env) {
    const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        for (const name of names) {
            const candidate = path.join(dir, name);
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return null;
}

/**
 * @returns {{file: string, prefixArgs: string[], root: string} | null}
 *   file/prefixArgs — what to pass to execFile; root — directory tree that holds the toolchain and
 *   its system headers (used to decide which header files a build may legitimately read).
 */
export function resolveEmcc(env = process.env) {
    let emccPath = env.EMCC_PATH || null;
    if (!emccPath) emccPath = findOnPath(isWindows ? ['emcc.bat', 'emcc.cmd', 'emcc.exe'] : ['emcc'], env);
    if (!emccPath || !fs.existsSync(emccPath)) return null;

    const emscriptenDir = path.dirname(emccPath);
    // emsdk layout: <emsdk>/upstream/emscripten/emcc  with headers under <emsdk>/upstream
    const root = path.resolve(emscriptenDir, '..');

    if (/\.(bat|cmd)$/i.test(emccPath)) {
        const emccPy = path.join(emscriptenDir, 'emcc.py');
        if (!fs.existsSync(emccPy)) return null;
        return { file: env.EMSDK_PYTHON || 'python', prefixArgs: [emccPy], root };
    }
    return { file: emccPath, prefixArgs: [], root };
}

/**
 * Run emcc with an argument array. Never rejects: resolves with the exit status and output.
 *
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function runEmcc(emcc, args, { cwd, timeoutMs, env = process.env }) {
    return new Promise((resolve) => {
        execFile(emcc.file, [...emcc.prefixArgs, ...args], {
            cwd,
            env,
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true
        }, (err, stdout, stderr) => {
            resolve({
                code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
                stdout: stdout || '',
                stderr: stderr || '',
                timedOut: Boolean(err && err.killed)
            });
        });
    });
}
