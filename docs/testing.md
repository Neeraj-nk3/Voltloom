# Testing

Voltloom has four kinds of automated checks. All of them run on the real code; nothing is mocked except where a test says so.

| Layer | Tool | Where | Command | Needs |
|---|---|---|---|---|
| Unit | Vitest | `tests/unit/<area>/` (mirrors `src/`) | `npm test` | Node |
| Scenario | Vitest | `tests/scenario/` | `npm test` | Node; C scenarios also need Emscripten |
| Browser | Playwright (Chromium) | `tests/e2e/` | `npm run test:e2e` | a Playwright browser; C tests also need Emscripten |
| Production build | Playwright against `vite preview` | the same `tests/e2e/` | `npm run build` then `npm run test:e2e:preview` | as above |

`npm test` runs unit and scenario tests together (one file at a time: some tests count temp folders or compile). `npm run test:all` runs everything except the production-build run.

## What the layers cover

- **Unit** (`tests/unit/`): the solver against hand calculations, the netlist and board model, limits and warnings, LED model, circuit channel (including a real second thread), pin model, interrupts, watchdog and PWM-frequency maths, event batching, the virtual clock, project schema and v1 → v2 migration (with frozen v1 fixtures), autosave honesty, the compile pipeline and source policy, the compile service's host/origin checks, the scripts, and *architecture* tests: the part-id boundary, removed features staying removed, licence and notice consistency, build configuration (production CSP, dev-server file access).
- **Differential** (`tests/unit/electrical/differential-vs-legacy.test.js`): the electrical engine is compared with the original graph-walking logic (`tests/support/legacy-connectivity.js`) on thousands of random circuits. Where they are meant to agree they must agree exactly; where they differ, the difference must fall in a documented hazard class.
- **Scenario** (`tests/scenario/`): programs in Python and C run headlessly on the virtual clock with scripted button presses: timing, interrupt delivery, resets and watchdog, SDK/MicroPython compatibility idioms, PWM function select, and the [examples](examples.md). The same inputs always give the same trace.
- **Browser** (`tests/e2e/`): the real page. Run / Stop / re-run for both languages, wire drawing and part editing, LED brightness and warnings, autosave and migration, the debugger, the security checks (HTML escaping, hostile projects), deployment without isolation headers, and Python/C parity of the pin model.
- **Interface** (`tests/e2e/ui_layout.spec.js`, `tests/unit/ui/`): the layout at several window sizes and emulated browser zoom levels (nothing clipped, covered or scrolling the page), wheel and button zoom, wires ending on the pins they were drawn from after zooming, panning, rotating and flipping, the floating card and tooltips staying inside the window, panels and splitters, dialogs, menus and keyboard use, the narrow-window Code/Circuit switch, and the page when the editor or board drawing cannot load. The pure geometry (`geometry.test.js`), the colour contrast of the design tokens (`design-tokens.test.js`) and the icon sprite (`icons.test.js`) are unit tests. Browser zoom is emulated with a smaller viewport and a larger device pixel ratio; it is not the real browser zoom control.

## C and Emscripten

Tests that compile C use the Emscripten SDK. Set `EMCC_PATH` to the `emcc` executable (or put `emcc` on `PATH`) before running:

```bash
EMCC_PATH=/path/to/emsdk/upstream/emscripten/emcc npm test          # bash
$env:EMCC_PATH = "C:/path/to/emsdk/upstream/emscripten/emcc.exe"; npm test  # PowerShell
```

**Without Emscripten those tests are skipped, not failed**, so a green run without it says nothing about the C path. `npm run doctor` tells you whether Emscripten is visible.

## Stress and repeat runs

Run/Stop/reset lifecycle tests are the ones most sensitive to timing. To repeat them:

```bash
npx playwright test tests/e2e/python_lifecycle.spec.js tests/e2e/c.spec.js --repeat-each 10
```

(Intermittent failures found earlier were test-timing problems, fixed by waiting for the expected output instead of sleeping; they were not hidden by retries, and the configuration uses no retries.)

## Production-build check

```bash
npm run build
npm run test:e2e:preview                              # all browser tests against dist/ on port 4173
npm run test:e2e:preview -- tests/e2e/python.spec.js  # or a subset
```

This exists because some failures only appear in the built app (worker file URLs, asset URLs, the production CSP).

## Writing tests

- Prefer testing behaviour through the scenario runner (`runScenario`) over reaching into modules.
- A new test must be able to fail: change the thing it checks and watch it fail before trusting it.
- Never delete a test to make a refactor pass. If a test targets behaviour that was deliberately removed, say so in the change and name the replacement coverage.
- Shared helpers: `tests/e2e/helpers.js` (browser), `tests/support/` (C header text, Emscripten detection, the legacy analysis oracle).

## What is not tested

Firefox and Safari; Linux and macOS (only Windows was run here; [the CI workflow](../.github/workflows/ci.yml) has never been executed); touch input; screen-reader behaviour (the interface has accessible names, roles and keyboard paths, checked by tests and an axe-core run, but not with an actual screen reader); wiring and moving parts without a mouse; performance beyond the lifecycle stress runs.
