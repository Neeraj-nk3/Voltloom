# Deployment and security

## What the app needs
Live input reaches a running program through `SharedArrayBuffer` (the circuit channel, pin levels, the debugger, the
wake-up when a button is pressed while the program sleeps). Browsers only provide it on a **cross-origin-isolated** page,
which the server must ask for with two response headers on the page itself:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

The Vite dev and preview servers send them (`vite.config.js`). `public/_headers` carries the same two lines for Netlify
and Cloudflare Pages. Other hosts:

| Host | How |
|---|---|
| Netlify / Cloudflare Pages | `public/_headers` (already in the build output) |
| Vercel | `vercel.json`: `{ "headers": [{ "source": "/(.*)", "headers": [{ "key": "Cross-Origin-Opener-Policy", "value": "same-origin" }, { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" }] }] }` |
| nginx | `add_header Cross-Origin-Opener-Policy same-origin always; add_header Cross-Origin-Embedder-Policy credentialless always;` |
| Apache | `Header always set Cross-Origin-Opener-Policy "same-origin"` and `Header always set Cross-Origin-Embedder-Policy "credentialless"` |
| GitHub Pages | cannot set headers. Needs a service-worker shim that re-serves the page with the headers (not included; see "Decision") |

## Evidence (executed 2026-10-12 against the production build in Chromium; Safari and Firefox NOT tested here)

| Hosting headers | `crossOriginIsolated` | Page (Tailwind, Monaco, fonts) | Python program | Button pressed during a running Python program | Pin interrupt |
|---|---|---|---|---|---|
| none | false | loads | runs (sleep, print, timing correct; the sleep is a busy spin) | **never seen** (reads stay 1) | **never fires** |
| COOP only | false | loads | as above | as above | as above |
| COOP + COEP `credentialless` | **true** | loads fully (0 blocked requests) | runs | seen at once (1, 0, 1) | fires |
| COOP + COEP `require-corp` | true | **breaks**: `cdn.tailwindcss.com` is blocked (`NotSameOriginAfterDefaultedToSameOriginByCoep`), so the page loses its styles and 6 of 7 web fonts | runs | seen | fires |

* The table was measured when the page still loaded Tailwind from a CDN. Since then the styles are compiled into the app
  (there is no Tailwind CDN), so the loss of styles in the `require-corp` row no longer applies. The Monaco editor and the
  fonts are still CDN-hosted and were **not** re-measured under `require-corp`; `credentialless` is the setting that has been
  verified. Only Chromium was tested. Firefox and Safari were **not** tested here, so their support for `credentialless` is
  unverified; if a browser only supports `require-corp`, the editor and fonts would have to be vendored.
* The C path cannot be static-hosted anyway: it needs the compile service (`compiler/`, Emscripten). That service
  binds to loopback, allow-lists the dev origin only (set `ALLOWED_ORIGINS` for any other origin, e.g.
  `ALLOWED_ORIGINS=http://localhost:4173` for `vite preview`) and is not hardened for exposure to the internet.
* The page loads Monaco (`cdnjs.cloudflare.com`) and Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) from CDNs;
  the CSP allows exactly those hosts. The interface styles and icons are part of the build.

## What "limited mode" is
Without isolation the app does not stop; it runs Python in a reduced mode, and says so: a **Limited mode** badge in the
header and a warning at every run. In limited mode C programs are refused, and button presses, interrupts and the
debugger do not reach a running Python program (the table above). Output, LEDs and timing still work.

## Decision: keep the announced limited mode
The Python no-SharedArrayBuffer path is kept. It is not dead code (a host without the headers still runs Python demos), and what it loses, live input, is announced instead of failing silently: the badge, the run-time warning, and the test `tests/e2e/deployment.spec.js`. A service-worker shim for header-less hosts such as GitHub Pages is not included; it would be third-party code, and no hosting target has been chosen.

## Security model and safe operating assumptions

**What the app protects against**
- A hostile **share link or stored project** is untrusted input: it goes through a strict schema, is migrated and validated field by field, and nothing from a rejected project is used. Component ids carrying markup do not execute (`tests/e2e/security.spec.js`).
- Program output is rendered as text, never HTML. Output that looks like a command is only text: protocol messages are typed objects, not strings.
- The page sets a Content-Security-Policy that allows only its own origin, the CDNs it uses, and WebAssembly compilation; inline event handlers are blocked. The production page does not allow the Vite hot-reload WebSocket (the source page does, for development).
- Programs run in their own Web Worker; Stop is `Worker.terminate()`.

**What it does not protect against**
- Hostile code is **not sandboxed** beyond what the browser gives a worker. C programs cannot grow past 256 MB of memory; nothing else limits CPU or memory except the browser.
- **The compile service runs a real compiler on text it receives.** It is meant for your own machine:
  - it binds to `127.0.0.1` only (`HOST` can override this, which you should not do);
  - it checks the `Host` header (so a page that rebinds its DNS name to 127.0.0.1 is refused) and the `Origin` header against an allow-list (default: the dev server; `ALLOWED_ORIGINS` to change);
  - it limits source size, runs one build at a time with a short queue, and gives each build a temporary workspace that is deleted afterwards;
  - it refuses `#include`s outside the standard headers and Voltloom's SDK-compatible headers, refuses inline assembly, and checks that the preprocessor read only allowed files;
  - none of this makes it safe to expose to a network or to run as a privileged user. Do not host it on the internet.
- The page depends on Monaco and Google Fonts served from third-party CDNs. A compromise or outage there is outside this project's control, and the editor cannot be used offline (the circuit and the styles still load; the editor area says why it is empty).

**Reporting a problem:** see [SECURITY.md](../SECURITY.md).
