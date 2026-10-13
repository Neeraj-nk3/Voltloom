// One-step setup for a fresh checkout.
//
//   node scripts/setup.mjs             check Node/npm, install dependencies with `npm ci`, then run the environment check
//   node scripts/setup.mjs --dry-run   check Node/npm and show what `npm ci` would install, without installing anything
//
// It never touches anything outside this folder. Optional pieces (a browser for the browser tests, Emscripten for C) are
// reported by the environment check, not installed.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

const run = (commandLine) => spawnSync(commandLine, { cwd: root, shell: true, stdio: 'inherit' }).status ?? 1;

// 1. Node and npm must be usable before anything else.
const doctor = spawnSync(`"${process.execPath}" scripts/doctor.mjs --json`, { cwd: root, shell: true, encoding: 'utf8' });
const report = JSON.parse(doctor.stdout || '{"checks":[]}');
const blocked = report.checks.filter((c) => (c.id === 'node' || c.id === 'npm') && !c.ok);
if (blocked.length) {
  for (const c of blocked) console.error(`${c.detail}\n  -> ${c.fix}`);
  process.exit(1);
}

// 2. Install exactly what package-lock.json says.
const installCommand = dryRun ? 'npm ci --dry-run' : 'npm ci';
console.log(`\n> ${installCommand}\n`);
if (run(installCommand) !== 0) {
  console.error('\nnpm ci failed. Common causes: no network access, an old Node/npm, or a half-installed node_modules (delete it and retry).');
  process.exit(1);
}

// 3. Show the state of the machine.
console.log('\n> node scripts/doctor.mjs\n');
const finalCheck = run(`"${process.execPath}" scripts/doctor.mjs`);
if (!dryRun) {
  console.log(`
Next steps:
  npm run dev        the app, at http://localhost:5173/
  npm run compiler   (second terminal, only for C programs) the compile service, at http://127.0.0.1:3001/
  npm test           unit and scenario tests
  npm run demo       run the bundled examples headlessly and print what they do
See README.md for details.`);
}
process.exit(dryRun ? 0 : finalCheck);
