/**
 * compile-client.js — talking to the local compile service, and recognising C source
 *
 * The compiled program is NOT loaded here any more: it runs inside src/runtime/c/worker.js, so that
 * stopping it is Worker.terminate(). SimulatorBridge.runC() calls compileCode() and hands the
 * result to that worker.
 */

/**
 * Compile C code via the compile service (POST /compile, proxied to http://127.0.0.1:3001).
 *
 * @param {string} code — user C source code
 * @param {{signal?: AbortSignal}} [options] — abort to cancel the request (Stop while compiling)
 * @returns {Promise<{js: string, size: {js: number}} | {error: string}>}
 *   `error` holds compiler diagnostics when the program does not compile.
 * @throws if the service is unreachable or refuses the request (the message explains why)
 */
export async function compileCode(code, { signal } = {}) {
    const response = await fetch('/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        signal
    });

    if (!response.ok) {
        // The service explains refusals ("busy", "include not allowed", ...) in a JSON body.
        let detail = '';
        try { detail = (await response.json()).error || ''; } catch { /* not JSON */ }
        throw new Error(detail || `Compiler server error: ${response.status}`);
    }

    return response.json();
}

/**
 * Detect if code is C (vs Python).
 *
 * @param {string} code — source code text
 * @returns {boolean} — true if code appears to be C
 */
export function isCCode(code) {
    const trimmed = code.trim();
    return (
        trimmed.includes('#include') ||
        /\bint\s+main\s*\(/.test(trimmed) ||
        /\bvoid\s+main\s*\(/.test(trimmed) ||
        trimmed.includes('stdio_init_all') ||
        trimmed.includes('gpio_init(')
    );
}
