# Third-party notices

Voltloom's own source code is released under the [MIT License](LICENSE) (Copyright (c) 2026 Neeraj Kumar).
This file lists the third-party software and assets that Voltloom redistributes, loads at run time, or depends on, with what has actually been verified and what has not. Nothing here is a legal opinion.

*Raspberry Pi and Pico are trademarks of Raspberry Pi Ltd. Voltloom is an independent project and is not affiliated with, sponsored by or endorsed by Raspberry Pi Ltd. Names of boards and software are used only to describe compatibility.*

## 1. Redistributed in this repository and in the built web app

### MicroPython 1.27.0 (WebAssembly build) — `runtimes/micropython/micropython.mjs`, `runtimes/micropython/micropython.wasm`
- **Licence:** MIT. Copyright (c) 2013-2025 Damien P. George and contributors. The licence text is in [`runtimes/micropython/LICENSE-MICROPYTHON`](runtimes/micropython/LICENSE-MICROPYTHON), copied verbatim from the upstream repository tag `v1.27.0`.
- **Version:** the binary reports `MicroPython v1.27.0 on 2025-12-10`.
- **Provenance (verified):** both files are byte-for-byte identical to the files of the npm package `@micropython/micropython-webassembly-pyscript@1.27.0` (declared licence `MIT`). SHA-256: `micropython.wasm` `06338c955b03c5700aa0069015d3e392d76836ef8e2ce25bedbe59b88ccd373c`, `micropython.mjs` `c2be87e7ba24e3b47d133022b009a66bff07f4720aa23d816d216ef8cc47014c`.
- **Not itemised:** the upstream licence file lists third-party code in other MicroPython ports (e.g. BSD-3-Clause and Apache-2.0 components under `drivers/` and `lib/`); which of those are linked into this WebAssembly port was not checked.
- The built app ships the `.wasm` file and a bundled copy of the `.mjs` glue code, so the licence file is copied into the production build (see "Notices in the built app").

### Voltloom board artwork — `src/ui/assets/pico-board.svg` (an SVG drawing of the Pico board)
- Created by hand for this project (stated by the project owner, 2026-10-12); treated as original project artwork under the project's MIT licence.
- It depicts the publicly documented pin layout of the board. It uses no Raspberry Pi logo or trademark artwork.

### Part artwork (LED, resistor, push button)
- SVG markup defined in `src/ui/parts/*.js`; part of the project source and covered by its MIT licence.

### Interface icons — the `<symbol>` sprite at the top of `index.html`
- Shapes in the style and with the names of **Lucide** (<https://lucide.dev>), licence **ISC**. Notice as published by the project: *"Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022."* Permission to use, copy, modify and/or distribute for any purpose with or without fee is granted provided the copyright notice and the permission notice appear in all copies; the software is provided "as is" without warranty.
- **Not verified:** the paths were typed into the sprite by hand from the Lucide set and may differ in small details from the upstream files; the notice is kept because they are derived from it. The brand mark in the title bar and the favicon are original to this project.

### Pico SDK-compatible C headers and C bridge — `compiler/sdk/include/`, `compiler/sdk/src/`
- These implement the *API* of the Raspberry Pi Pico SDK on top of Voltloom's simulator, so that programs written for a Pico compile unchanged. The real Pico SDK is licensed BSD-3-Clause (Copyright Raspberry Pi Ltd).
- **What was checked (executed):** each header was compared line by line with the corresponding file of the current upstream `pico-sdk` (`master`, fetched 2026-10-12). The only lines the files share are function and type *declarations* that must match for compatibility (for example `void gpio_set_irq_enabled(uint gpio, uint32_t event_mask, bool enabled);`). No documentation comments or prose from the SDK were found in them, and none of the headers carries a copyright notice. `pico/stdlib.h` could not be compared (the upstream file path was not found); it is six substantive lines.
- **What is not known:** who wrote the first version of these files and with which tools. The repository history starts with a single commit, so the earlier history cannot be traced. No SDK-derived text was found, so no SDK notice is added; **if any SDK text is ever found in them, the BSD-3-Clause notice of the Pico SDK must be added here.**
- `compiler/sdk/include/fs/fs.h` is a Voltloom-specific header (a small flash-filesystem API); it is not part of the Pico SDK.

## 2. Not included
Voltloom contains no firmware images for physical boards. (An unused MicroPython `.uf2` image that earlier sat in `public/` and was copied into every build has been removed from the project.)

## 3. Loaded from third-party servers at run time (not redistributed)
The page loads these from CDNs when opened in a browser; Voltloom does not include or modify them. Opening the page therefore sends requests (and the visitor's IP address) to those providers, and the page needs network access to them. Licences are the upstream projects' own; they were not re-verified for this file.
| Component | Loaded from | Upstream licence (as published by the project) |
|---|---|---|
| Monaco Editor 0.44.0 (`loader.min.js` and the editor files it loads) | `cdnjs.cloudflare.com` | MIT |
| IBM Plex Sans, JetBrains Mono (Google Fonts) | `fonts.googleapis.com`, `fonts.gstatic.com` | SIL Open Font License 1.1 |

The page styles are compiled into the app (no CSS framework is loaded at run time), and icons are inline SVG, so neither needs a third-party server.

## 4. Local compile service (installed with npm, not part of the browser bundle)
| Package | Version (lockfile) | Licence |
|---|---|---|
| express | 4.22.1 | MIT |
| cors | 2.8.6 | MIT |
| qs (transitive, pinned by an `overrides` entry) | 6.16.0 | BSD-3-Clause |
The service also needs the **Emscripten SDK** (`emcc`, installed separately by the user; version 6.0.12 was used for testing). Emscripten is available under the MIT or the University of Illinois/NCSA licence (Copyright (c) 2010-2014 Emscripten authors). Compiled C programs contain Emscripten's runtime and parts of its libraries; Voltloom does not distribute compiled programs — they are produced on the user's own machine — so no compiled output is shipped. Anyone who publishes compiled output must follow Emscripten's licence notes.

## 5. Development tools (not shipped)
`rolldown-vite` 7.2.5 (MIT, installed through the `vite` alias), `vitest` 5.0.3 (MIT), `@playwright/test` and `playwright` 1.63.0 (Apache-2.0), plus their transitive dependencies. The root lockfile lists 0 production dependencies. Licence fields recorded in the lockfile: MIT (51 packages), Apache-2.0 (5), MPL-2.0 (12, all `lightningcss` build-tool binaries, used only during builds and not redistributed), ISC (1), BSD-3-Clause (1), 0BSD (1).

## 6. Notices in the built app
`vite build` copies `LICENSE`, this file and `runtimes/micropython/LICENSE-MICROPYTHON` into the output as `LICENSE.txt`, `THIRD_PARTY_NOTICES.txt` and `LICENSE-MICROPYTHON.txt`, so a deployed copy of Voltloom carries them.
