/**
 * line-checkpoints.js — debugger checkpoint injection for user Python code
 *
 * The debugger works by inserting `sim_debug.checkpoint(<line>)` before each statement the user wrote.
 * That is only valid where a NEW statement starts. Inserting a line inside a bracketed expression,
 * a multi-line string, a backslash continuation, or between a decorator and its `def` produces
 * a SyntaxError, so we first find the real statement boundaries with a small scanner.
 *
 * The scanner understands: (), [], {} nesting; '...' and "..." strings; triple-quoted strings;
 * backslash escapes and backslash line continuations; # comments. It does not parse Python, so
 * genuinely malformed input is left alone (MicroPython then reports the real SyntaxError).
 *
 * Pure functions, no DOM or worker APIs, so they are unit-tested in Node.
 */

/**
 * @param {string} code
 * @returns {boolean[]} starts[i] is true if line i (0-based) begins a new logical line
 */
export function logicalLineStarts(code) {
    const starts = [true];
    let depth = 0;
    let str = null;                       // { quote, triple } while inside a string literal
    let backslashContinuation = false;    // previous line ended with "\"
    let escapedNewlineInString = false;   // a "\" escaped the newline inside a string

    for (let i = 0; i < code.length; i++) {
        const ch = code[i];

        if (ch === '\n') {
            // An unterminated single-line string ends at the newline (MicroPython will report it),
            // unless the newline was escaped with a backslash, which continues the string.
            if (str && !str.triple && !escapedNewlineInString) str = null;
            escapedNewlineInString = false;
            const continues = depth > 0 || str !== null || backslashContinuation;
            starts.push(!continues);
            backslashContinuation = false;
            continue;
        }

        if (str) {
            if (ch === '\\') {
                // Skip the escaped character. If it is a newline, leave it for the branch above to count.
                if (code[i + 1] === '\r' && code[i + 2] === '\n') i++;
                if (code[i + 1] === '\n') escapedNewlineInString = true;
                else i++;
                continue;
            }
            if (ch === str.quote) {
                if (!str.triple) str = null;
                else if (code[i + 1] === str.quote && code[i + 2] === str.quote) { str = null; i += 2; }
            }
            continue;
        }

        if (ch === '#') {                                 // comment: skip to end of line
            while (i + 1 < code.length && code[i + 1] !== '\n') i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            if (code[i + 1] === ch && code[i + 2] === ch) { str = { quote: ch, triple: true }; i += 2; }
            else str = { quote: ch, triple: false };
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
        if (ch === ')' || ch === ']' || ch === '}') { if (depth > 0) depth--; continue; }
        if (ch === '\\') {
            // A backslash right before the newline (allowing a CR) joins the next line to this one.
            const next = code[i + 1] === '\r' ? code[i + 2] : code[i + 1];
            if (next === '\n') backslashContinuation = true;
        }
    }
    return starts;
}

const NEVER_PRECEDED = /^(else|elif|except|finally)(\s*:|\s+)/;

/**
 * Insert a checkpoint call before every statement that can safely take one.
 *
 * @param {string} code — the user's source
 * @returns {{code: string, lineMap: Object<number, number>}}
 *   code    — instrumented source
 *   lineMap — instrumented line number (1-based) -> user's line number (1-based)
 */
export function injectCheckpoints(code) {
    const lines = code.split('\n');
    const starts = logicalLineStarts(code);
    const lineMap = {};
    const out = [];
    let outLine = 1;
    let previousStatementWasDecorator = false;

    lines.forEach((line, idx) => {
        const realLine = idx + 1;
        const clean = line.trim();
        const isStatementStart = starts[idx] && clean !== '' && !clean.startsWith('#');

        const injectable =
            isStatementStart &&
            !NEVER_PRECEDED.test(clean) &&
            !clean.startsWith('@') &&
            !previousStatementWasDecorator;

        if (isStatementStart) previousStatementWasDecorator = clean.startsWith('@');

        if (!injectable) {
            lineMap[outLine++] = realLine;
            out.push(line);
            return;
        }

        const indent = line.match(/^(\s*)/)[1];
        lineMap[outLine++] = realLine;   // the checkpoint line
        lineMap[outLine++] = realLine;   // the user's line
        out.push(`${indent}import sim_debug; sim_debug.checkpoint(${realLine})`, line);
    });

    return { code: out.join('\n'), lineMap };
}

/**
 * Rewrite "line N" references in a MicroPython error message from instrumented to user line numbers.
 */
export function remapErrorLines(message, lineMap) {
    return String(message).replace(/line\s+(\d+)/g, (match, num) => {
        const mapped = lineMap[parseInt(num, 10)];
        return mapped ? `line ${mapped}` : match;
    });
}
