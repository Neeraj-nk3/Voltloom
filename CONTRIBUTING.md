# Contributing

Thank you for looking at Voltloom. This is a small project; the rules below are there to keep it trustworthy.

## First time here?

1. Follow the setup in the [README](README.md#getting-started-on-windows), then `npm run dev`.
2. Walk through [docs/getting-started.md](docs/getting-started.md) to learn the workbench.
3. Run `npm test` once so you know the suite is green on your machine before you change anything.

Good first contributions: a new example (see below), a clearer error message, or a doc that disagrees with what the app does.

## Set up

```bash
npm run setup      # Node ^24.12 and npm required; runs `npm ci`, then an environment check
npm run doctor     # at any time: what is missing, and how to fix it
```

C programs and C tests need the Emscripten SDK; set `EMCC_PATH` to `emcc` (or put it on `PATH`). Browser tests need `npx playwright install chromium-headless-shell`. Details: [docs/setup-and-troubleshooting.md](docs/setup-and-troubleshooting.md).

## Before you change anything

- Read [docs/architecture.md](docs/architecture.md): which folder owns what, and why most of `src/` has no DOM access.
- The packages are one npm workspace with **one lockfile** (`package-lock.json`). Do not add a second lockfile. Add a dependency only when it is clearly needed, with its licence checked ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) must stay accurate).
- Never edit `runtimes/micropython/` (a third-party binary with a recorded hash) or `tests/fixtures/` (frozen v1 project fixtures) as a side effect of another change.

## Making a change

1. Write or update the test first, and watch it fail for the right reason.
2. Make the change. Keep it readable; match the surrounding style (`.editorconfig`). File names are kebab-case and describe what the file does; official Pico SDK header names are kept as they are.
3. Run what applies:

   | Change | Run |
   |---|---|
   | anything | `npm test` (set `EMCC_PATH` so the C tests run instead of being skipped) |
   | UI, workers, bridge, project format | `npm run test:e2e` |
   | build, worker or asset URLs, CSP, anything served | `npm run build` then `npm run test:e2e:preview` |
   | examples or `examples/examples.json` | `npm run examples:check` and `npx vitest run tests/scenario/examples.test.js` |
   | docs | open every link you touched |

4. Do not delete or weaken a test to make a change pass. If a test covers behaviour you deliberately removed, say so in the change and name what covers it now.
5. Update the docs that describe the behaviour you changed. A README or guide that disagrees with the code is a bug.

## Adding an example

1. Put the program in `examples/python/` and, if it needs a circuit, add the layout to `scripts/build-example-projects.mjs`.
2. Add an entry to `examples/examples.json` with the output and LED behaviour you expect.
3. `npm run examples:build` writes the project file to `examples/projects/`; `npm run examples:check` and `npx vitest run tests/scenario/examples.test.js` check it.
4. List it in [docs/examples.md](docs/examples.md).

## Screenshots

The images in `docs/assets/` are captured from the running app, not drawn. With `npm run dev` running, `npm run docs:screenshots` regenerates all of them (set `VOLTLOOM_CHROMIUM` to a Chrome executable if Playwright's browser is not installed). Look at each image before committing it.

## Keeping claims honest

This project distinguishes **tested**, **reasoned** and **not verified**. Do not write "works on X" for something you did not run. New limitations go in [docs/limitations-and-roadmap.md](docs/limitations-and-roadmap.md); new electrical parameters need a source tag (`[datasheet]`, `[derived]` or `[assumed]`) in `src/electrical/board-params.js` and a line in [docs/electrical-model.md](docs/electrical-model.md).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md). The compile service runs a real compiler on received text: any change under `compiler/` needs a test and a note in [docs/deployment-and-security.md](docs/deployment-and-security.md).

## Licence

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
