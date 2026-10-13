/**
 * source_policy.js — first line of defence for the compile service
 *
 * The service compiles C that arrives over HTTP. A real compiler reads whatever the source
 * asks it to: `#include "C:/Windows/win.ini"`, `__has_include`, `#embed`, or an assembler
 * `.incbin` would pull host files into the build. This module rejects such sources BEFORE any
 * compiler runs. It is deliberately strict and simple; compile.js adds two backstops that
 * work on what the preprocessor actually did (the dependency list, and a scan of the
 * preprocessed output for inline assembly).
 *
 * Rules:
 *   - source size limit, no NUL bytes
 *   - every #include must name a header directly (no macros), with no absolute path, drive
 *     letter, backslash, or ".." segment, and the header must be a standard C header from a
 *     short allow-list or exist in the simulator SDK directory
 *   - #include_next, #import, #embed, __has_include* and __has_embed are rejected
 *
 * This is best-effort hardening for a LOCAL service, not a sandbox. See docs in the README.
 */

import fs from 'node:fs';
import path from 'node:path';

export const MAX_SOURCE_BYTES = 200_000;

const STANDARD_HEADERS = new Set([
    'assert.h', 'ctype.h', 'errno.h', 'float.h', 'inttypes.h', 'limits.h', 'math.h', 'setjmp.h',
    'stdarg.h', 'stdbool.h', 'stddef.h', 'stdint.h', 'stdio.h', 'stdlib.h', 'string.h', 'strings.h',
    'time.h', 'stdatomic.h', 'stdnoreturn.h', 'iso646.h', 'emscripten.h'
]);

const SAFE_HEADER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/;
const BANNED_DIRECTIVES = new Set(['include_next', 'import', 'embed', 'include_macros']);
const BANNED_TOKENS = /__has_include(?:_next)?|__has_embed/;

/** Replace comments with a space, keeping string and character literals intact. */
export function stripComments(code) {
    let out = '';
    let i = 0;
    while (i < code.length) {
        const ch = code[i];
        const next = code[i + 1];
        if (ch === '/' && next === '/') {
            while (i < code.length && code[i] !== '\n') i++;
            out += ' ';
        } else if (ch === '/' && next === '*') {
            i += 2;
            while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) { if (code[i] === '\n') out += '\n'; i++; }
            i += 2;
            out += ' ';
        } else if (ch === '"' || ch === "'") {
            const quote = ch;
            out += ch; i++;
            while (i < code.length && code[i] !== quote && code[i] !== '\n') {
                if (code[i] === '\\' && i + 1 < code.length) { out += code[i] + code[i + 1]; i += 2; continue; }
                out += code[i++];
            }
            if (i < code.length && code[i] === quote) { out += quote; i++; }
        } else {
            out += ch; i++;
        }
    }
    return out;
}

/** Replace the contents of string and character literals with spaces (quotes kept). */
export function blankLiterals(code) {
    return stripComments(code).replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[0]);
}

function normalize(code) {
    return code
        .replace(/\\\r?\n/g, '')          // line splices: "#inc\<newline>lude" is "#include"
        .replace(/%:/g, '#')               // digraph for #
        .replace(/\?\?=/g, '#');           // trigraph for #
}

function headerAllowed(name, sdkDir) {
    if (!SAFE_HEADER_NAME.test(name)) return false;
    if (name.split('/').some((seg) => seg === '..' || seg === '' || seg === '.')) return false;
    if (STANDARD_HEADERS.has(name)) return true;
    if (!sdkDir) return false;
    const full = path.resolve(sdkDir, name);
    const root = path.resolve(sdkDir) + path.sep;
    return full.startsWith(root) && fs.existsSync(full);
}

/**
 * @param {string} code — user C source
 * @param {{sdkDir?: string}} [options]
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkSource(code, options = {}) {
    if (typeof code !== 'string' || code.length === 0) return { ok: false, reason: 'source code is empty' };
    if (Buffer.byteLength(code, 'utf8') > MAX_SOURCE_BYTES) return { ok: false, reason: `source is larger than ${MAX_SOURCE_BYTES} bytes` };
    if (code.includes('\0')) return { ok: false, reason: 'source contains a NUL byte' };

    const text = stripComments(normalize(code));

    if (BANNED_TOKENS.test(text)) return { ok: false, reason: '__has_include / __has_embed are not allowed' };

    for (const line of text.split('\n')) {
        const m = line.match(/^[ \t]*#[ \t]*([A-Za-z_]+)(.*)$/);
        if (!m) continue;
        const directive = m[1];
        if (BANNED_DIRECTIVES.has(directive)) return { ok: false, reason: `#${directive} is not allowed` };
        if (directive !== 'include') continue;

        const operand = m[2].trim();
        const named = operand.match(/^<([^<>]+)>$/) || operand.match(/^"([^"]+)"$/);
        if (!named) return { ok: false, reason: `#include must name a header directly: "${operand.slice(0, 40)}"` };
        if (!headerAllowed(named[1], options.sdkDir)) return { ok: false, reason: `include of "${named[1]}" is not allowed (only standard C headers and the simulator SDK headers)` };
    }
    return { ok: true };
}

/**
 * Backstop used after preprocessing: inline assembly (including forms built with macros or
 * string concatenation, e.g. an assembler ".incbin") cannot be recognised before expansion,
 * so reject it afterwards.
 *
 * @param {string} userText — the user's lines of the preprocessed output (see extractUserLines)
 */
export function containsInlineAsm(userText) {
    return /\b(?:asm|__asm__|__asm)\b/.test(blankLiterals(userText));
}

/**
 * From `emcc -E` output, keep only the lines that came from the user's own file. The output is
 * interleaved with `# <line> "<file>" <flags>` markers; library headers legitimately contain
 * `__asm__` and must not be scanned.
 */
export function extractUserLines(preprocessed, userFileName) {
    const kept = [];
    let inUserFile = false;
    for (const line of preprocessed.split('\n')) {
        const marker = line.match(/^#\s*\d+\s+"([^"]+)"/);
        if (marker) {
            inUserFile = path.basename(marker[1].replace(/\\/g, '/')) === userFileName;
            continue;
        }
        if (inUserFile) kept.push(line);
    }
    return kept.join('\n');
}
