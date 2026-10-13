// Checks that this machine can run Voltloom, and says what to do about anything that cannot.
//
//   node scripts/doctor.mjs            human-readable report; exit code 1 if something REQUIRED is missing
//   node scripts/doctor.mjs --json     the same checks as JSON
//
// Required: Node.js in the supported range, npm, installed dependencies, the bundled MicroPython runtime.
// Optional: a Playwright browser (browser tests), Emscripten (C programs and C tests), free ports 5173 and 3001.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { satisfies } from './lib/semver-lite.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const json = process.argv.includes('--json');

const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
const tryRun = (command, args) => {
  try {
    const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    // On Windows npm is npm.cmd, which only a shell can start; build one quoted command line instead of passing args with shell:true.
    return (process.platform === 'win32' ? execSync([command, ...args].map(quote).join(' '), options) : execFileSync(command, args, options)).trim();
  } catch { return null; }
};

const portFree = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

const checks = [];
const add = (id, required, ok, detail, fix) => checks.push({ id, required, ok, detail, fix: ok ? undefined : fix });

// Node
const range = pkg.engines && pkg.engines.node;
add('node', true, !range || satisfies(process.version, range), `Node ${process.version}${range ? ` (needs ${range})` : ''}`,
  `Install a Node.js version matching ${range} (https://nodejs.org). This project has been tested on 24.12.0 and 24.19.0.`);

// npm
const npmVersion = tryRun('npm', ['--version']);
add('npm', true, !!npmVersion, npmVersion ? `npm ${npmVersion}` : 'npm not found', 'Install npm (it ships with Node.js).');

// dependencies
const depsOk = fs.existsSync(path.join(root, 'node_modules', 'vite')) && fs.existsSync(path.join(root, 'node_modules', 'express'));
add('dependencies', true, depsOk, depsOk ? 'node_modules is installed' : 'dependencies are not installed', 'Run: npm ci');

// bundled runtime
const wasm = path.join(root, 'runtimes', 'micropython', 'micropython.wasm');
add('micropython', true, fs.existsSync(wasm), fs.existsSync(wasm) ? 'bundled MicroPython runtime found' : 'runtimes/micropython/micropython.wasm is missing',
  'Restore runtimes/micropython/ from your copy of the project; Python programs cannot run without it.');

// Playwright browser (optional): the browser tests use Playwright's headless shell, or any Chrome set in VOLTLOOM_CHROMIUM
const customBrowser = process.env.VOLTLOOM_CHROMIUM || process.env.PICOLAB_CHROMIUM;
const browsersRoot = process.env.PLAYWRIGHT_BROWSERS_PATH
  || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
    : process.platform === 'darwin' ? path.join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright')
      : path.join(process.env.HOME || '', '.cache', 'ms-playwright'));
let browser = null;
if (customBrowser) browser = fs.existsSync(customBrowser) ? customBrowser : null;
else if (fs.existsSync(browsersRoot)) browser = fs.readdirSync(browsersRoot).find((name) => /^chromium(_headless_shell)?-\d+/.test(name)) || null;
add('browser', false, !!browser, browser ? `browser for the browser tests: ${customBrowser || path.join(browsersRoot, browser)}` : (customBrowser ? `VOLTLOOM_CHROMIUM is set to "${customBrowser}" but that file does not exist` : 'no Playwright browser installed'),
  'Run: npx playwright install chromium-headless-shell   (or set VOLTLOOM_CHROMIUM to a Chrome/Chromium executable). Only needed for npm run test:e2e.');

// Emscripten (optional)
const emccPath = process.env.EMCC_PATH;
let emccVersion = null;
if (emccPath) emccVersion = fs.existsSync(emccPath) ? tryRun(emccPath, ['--version']) : null;
else emccVersion = tryRun('emcc', ['--version']);
const emccLine = emccVersion ? emccVersion.split('\n')[0] : null;
add('emscripten', false, !!emccLine, emccLine ? `emcc: ${emccLine}` : (emccPath ? `EMCC_PATH is set to "${emccPath}" but that is not a working emcc` : 'emcc not found'),
  emccPath ? 'Fix EMCC_PATH so it points at the emcc executable (emcc.bat / emcc.py wrappers are not enough on Windows; use emcc.exe or emcc).'
    : 'Install the Emscripten SDK (https://emscripten.org/docs/getting_started/downloads.html) and activate it, or set EMCC_PATH. Only C programs and C tests need it.');

// ports (optional: only matters when starting the servers)
for (const [port, what] of [[5173, 'the app (npm run dev)'], [3001, 'the compile service (npm run compiler)']]) {
  const free = await portFree(port);
  add(`port-${port}`, false, free, free ? `port ${port} is free` : `port ${port} is in use (${what} may already be running)`,
    `Stop whatever uses port ${port}, or ignore this if it is Voltloom's own server already running.`);
}

const requiredFailed = checks.filter((c) => c.required && !c.ok);
if (json) {
  console.log(JSON.stringify({ ok: requiredFailed.length === 0, checks }, null, 2));
} else {
  console.log('Voltloom environment check\n');
  for (const c of checks) {
    const mark = c.ok ? 'OK  ' : c.required ? 'FAIL' : 'WARN';
    console.log(`  [${mark}] ${c.detail}`);
    if (c.fix) console.log(`         -> ${c.fix}`);
  }
  console.log(requiredFailed.length
    ? `\n${requiredFailed.length} required check(s) failed.`
    : '\nEverything required is in place.' + (checks.some((c) => !c.required && !c.ok) ? ' Warnings above only affect optional features.' : ''));
}
process.exitCode = requiredFailed.length ? 1 : 0;
