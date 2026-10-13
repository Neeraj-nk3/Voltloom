# Setup and troubleshooting

## Prerequisites

| Needed for | What | Notes |
|---|---|---|
| everything | **Node.js `^24.12`** and npm | Unit and scenario tests were run on 24.12.0 and 24.19.0. Other versions are untested (`.node-version` records 24.12.0). |
| everything | internet access on first load | The page loads the Monaco editor and fonts from CDNs ([THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)). |
| C programs, C tests | the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) | Tested with 6.0.12. Python programs need no compiler. |
| browser tests | a Chromium for Playwright | `npx playwright install chromium-headless-shell` |

A modern Chromium-based browser is the only one tested. Firefox and Safari are untested.

## First run

```bash
npm run setup        # checks Node/npm, runs `npm ci`, then runs the environment check
npm run dev          # the app at http://localhost:5173/
```

`npm run setup -- --dry-run` shows what would be installed without installing anything. On a machine that already has `node_modules`, `npm run doctor` is the quick check; it prints one line per check and, for anything wrong, what to do:

```
  [OK  ] Node v24.12.0 (needs ^24.12.0)
  [FAIL] dependencies are not installed
         -> Run: npm ci
  [WARN] emcc not found
         -> Install the Emscripten SDK ... or set EMCC_PATH. Only C programs and C tests need it.
```

`FAIL` means Voltloom cannot run; `WARN` only affects an optional feature (browser tests, C, or a port that is already in use). `npm run doctor -- --json` prints the same checks as JSON.

For C programs, in a second terminal:

```bash
npm run compiler     # the compile service at http://127.0.0.1:3001/
```

If `emcc` is not on `PATH`, set `EMCC_PATH` to the executable first (PowerShell: `$env:EMCC_PATH = "C:/emsdk/upstream/emscripten/emcc.exe"`; bash: `export EMCC_PATH=...`).

To try an example without typing it in, print its link and open it:

```bash
node scripts/share-link.mjs examples/projects/python-blink.project.json
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npm ci` fails with `EBADENGINE` or syntax errors | Node is too old | Install Node 24.12 or newer in the 24 line (`node -v`). |
| `npm run doctor` says *dependencies are not installed* | `node_modules` missing or half-installed | Delete `node_modules`, run `npm ci`. |
| Header shows a **Limited mode** badge; buttons and interrupts do nothing in a running program; C refuses to run | The page is not cross-origin isolated (the server did not send the two COOP/COEP headers) | `npm run dev` and `npm run preview` send them. On any other host see [deployment-and-security.md](deployment-and-security.md). |
| Running C fails with *Compiler server error: 500* (or another network error) | The compile service is not running; the app forwards `/compile` to `http://127.0.0.1:3001` | `npm run compiler` in a second terminal. |
| Running C shows *The C compiler (Emscripten) is not installed or not on PATH* | Service is up but `emcc` is not found | Activate Emscripten in that terminal, or set `EMCC_PATH`. `GET http://127.0.0.1:3001/health` reports `"compiler": "available"` or `"missing"`. |
| `EMCC_PATH` is set but `npm run doctor` says it is not a working emcc | Pointing at a wrapper (`emcc.bat`, `emcc.py`) or a folder | Point at `emcc.exe` (Windows) or the `emcc` executable. |
| Running C fails with *Origin not allowed* (HTTP 403) | You opened the app from an origin it does not allow (for example `vite preview` on 4173) | Start it with `ALLOWED_ORIGINS=http://localhost:4173` (comma-separate several). Default: `http://localhost:5173` and `http://127.0.0.1:5173`. |
| *include of "…" is not allowed* | The program includes a header that is neither a standard C header nor one Voltloom provides | Use only the headers listed in [sdk-compatibility.md](sdk-compatibility.md). |
| C compile error mentions a Pico function that does not exist | That API is not implemented | Same list. Unimplemented APIs fail to compile; they are never silently ignored. |
| Port 5173 or 3001 *in use* | Another server (or Voltloom itself) is running | Stop it, or reuse it. `npx vite --port 5174` changes the app port (then set `ALLOWED_ORIGINS` for the compile service). |
| The editor area says it could not be loaded, or text is in a fallback font | No access to the CDNs (offline, a firewall, an ad blocker) | Allow `cdnjs.cloudflare.com` (editor), `fonts.googleapis.com` and `fonts.gstatic.com` (fonts). The circuit and the page styles do not depend on them. Vendoring is not done yet. |
| Header says autosave is unavailable | The browser blocks `localStorage` and `sessionStorage` (private mode, blocked site data) | Use **Share** to keep your work; the link contains the whole project. |
| Browser tests: *Executable doesn't exist* | No Playwright browser | `npx playwright install chromium-headless-shell`, or set `VOLTLOOM_CHROMIUM` to a Chrome/Chromium executable. |
| C tests are *skipped* | No Emscripten visible to the tests | Set `EMCC_PATH` before `npm test`. A green run with skips says nothing about C. |

## Windows notes

- Paths with spaces work, but keep the project path short; a path without spaces is the most tested setup (the fresh-copy check was run there).
- Several source files use CRLF line endings and others LF; this is intentional and no tool here rewrites them.
