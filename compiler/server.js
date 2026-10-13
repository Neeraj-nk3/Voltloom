/**
 * server.js — local C → WebAssembly compile service
 *
 * POST /compile   body: { "code": "<C source>" }
 *   200 { js, size }            compiled single-file module (WASM embedded in the JS)
 *   200 { error }               the program did not compile (diagnostics)
 *   400/415/422 { error }       bad request, wrong content type, or source rejected by policy
 *   503 { error }               busy, or the compiler is not installed
 *   504 { error }               compilation took too long
 * GET  /health
 *
 * SECURITY MODEL (read before changing anything):
 *   This service runs a real compiler on text it receives, so it is meant for the developer's own
 *   machine only. It is NOT a sandbox.
 *   - Binds to 127.0.0.1 by default (HOST to override - do not expose it to a network).
 *   - Requests whose Host header is not a loopback name are refused (DNS-rebinding defence).
 *   - Requests carrying an Origin header must come from an allow-listed origin
 *     (default: the Vite dev server on port 5173; ALLOWED_ORIGINS to override).
 *   - One build at a time, a short waiting line, per-build time and output limits.
 *   - Every build uses its own temporary directory; see lib/compile.js for the compile pipeline
 *     and lib/source_policy.js for what a source may include.
 *
 * REQUIRES: Emscripten (emcc) on PATH or EMCC_PATH, and `npm install` (express, cors).
 */

import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileC, CompileError } from './lib/compile.js';
import { resolveEmcc } from './lib/emcc.js';
import { createJobQueue, QueueFullError } from './lib/job-queue.js';
import { MAX_SOURCE_BYTES } from './lib/source-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const csv = (value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);

/** "localhost:3001" -> "localhost", "[::1]:3001" -> "[::1]" */
const hostName = (hostHeader) => String(hostHeader || '').replace(/:\d+$/, '').toLowerCase();

/**
 * @param {object} [options]
 * @param {string}   [options.baseDir]        directory holding sdk/include and sdk/src
 * @param {string[]} [options.allowedOrigins]
 * @param {string[]} [options.allowedHosts]   extra host names accepted besides loopback
 * @param {Function} [options.compile]        (code) => Promise<{js}>; replaceable in tests
 * @param {object}   [options.queue]          job queue; replaceable in tests
 * @param {object|null} [options.emcc]        resolved compiler, or null if not installed
 * @param {number}   [options.timeoutMs]
 */
export function createApp(options = {}) {
    const baseDir = options.baseDir ?? __dirname;
    const allowedOrigins = options.allowedOrigins ?? (csv(process.env.ALLOWED_ORIGINS).length ? csv(process.env.ALLOWED_ORIGINS) : DEFAULT_ORIGINS);
    const allowedHosts = [...LOOPBACK_HOSTS, ...(options.allowedHosts ?? csv(process.env.ALLOWED_HOSTS))];
    const emcc = options.emcc === undefined ? resolveEmcc() : options.emcc;
    const queue = options.queue ?? createJobQueue({ concurrency: 1, maxWaiting: 4 });
    const timeoutMs = options.timeoutMs ?? 60_000;
    const compile = options.compile ?? ((code) => compileC(code, { baseDir, timeoutMs, emcc }));

    const app = express();
    app.disable('x-powered-by');

    // 1. Host check: a page on another site that rebinds its DNS name to 127.0.0.1 still sends its own Host.
    app.use((req, res, next) => {
        if (!allowedHosts.includes(hostName(req.headers.host))) {
            return res.status(403).json({ error: 'Host not allowed' });
        }
        next();
    });

    // 2. Origin check: browsers add Origin to cross-site requests. Requests without one (curl, the Vite proxy) are fine.
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin !== undefined && !allowedOrigins.includes(origin)) {
            return res.status(403).json({ error: 'Origin not allowed' });
        }
        next();
    });

    app.use(cors({ origin: allowedOrigins, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'], maxAge: 600 }));

    app.get('/health', (req, res) => {
        res.json({ status: 'ok', service: 'voltloom-compiler', compiler: emcc ? 'available' : 'missing' });
    });

    app.post('/compile', (req, res, next) => {
        if (!req.is('application/json')) return res.status(415).json({ error: 'Content-Type must be application/json' });
        next();
    }, express.json({ limit: Math.ceil(MAX_SOURCE_BYTES * 1.2) }), async (req, res) => {
        const code = req.body && req.body.code;
        if (typeof code !== 'string' || code.length === 0) {
            return res.status(400).json({ error: 'Missing or invalid "code" field' });
        }

        const started = Date.now();
        try {
            const { js } = await queue.run(() => compile(code));
            console.log(`[Compiler] ok (${js.length} bytes, ${Date.now() - started} ms)`);
            res.json({ js, size: { js: js.length } });
        } catch (err) {
            const kind = err instanceof CompileError ? err.kind : err instanceof QueueFullError ? 'busy' : 'internal';
            console.log(`[Compiler] ${kind} (${Date.now() - started} ms)`);
            switch (kind) {
                case 'build': return res.json({ error: err.message });                       // compile errors: the editor shows them
                case 'rejected': return res.status(422).json({ error: err.message });
                case 'busy': return res.status(503).json({ error: err.message });
                case 'unavailable': return res.status(503).json({ error: err.message });
                case 'timeout': return res.status(504).json({ error: err.message });
                default: return res.status(500).json({ error: 'Internal compiler error' });  // details stay in the server log
            }
        }
    });

    // Body-parser errors (too large, malformed JSON) -> short JSON, no stack traces.
    app.use((err, req, res, next) => {
        if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
        if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
        console.error('[Compiler] Unexpected error:', err && err.message);
        res.status(500).json({ error: 'Internal compiler error' });
    });

    return app;
}

export function startServer({ port = Number(process.env.PORT) || 3001, host = process.env.HOST || '127.0.0.1' } = {}) {
    const emcc = resolveEmcc();
    const app = createApp({ emcc });
    return new Promise((resolve) => {
        const server = app.listen(port, host, () => {
            console.log(`[Compiler] Voltloom C compiler listening on http://${host}:${port}`);
            console.log(emcc
                ? `[Compiler] emcc found: ${emcc.file} ${emcc.prefixArgs.join(' ')}`
                : '[Compiler] WARNING: emcc not found. Install the Emscripten SDK and put emcc on PATH (or set EMCC_PATH).');
            resolve(server);
        });
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    startServer();
}
