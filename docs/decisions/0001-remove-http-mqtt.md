# HTTP and MQTT removal — APPROVED AND DONE (2026-10-12)

This began as a proposal; the removal (option 1) was approved and carried out in R6. The evidence below is why. After removal: the four
JS modules, `sdk/net/`, `http_client.c`, `mqtt_client.c`, the library entries, the `mqtt` dependency and its Vite line are gone; a C program that
includes `net/http_client.h` or `net/mqtt_client.h` is refused at compile time ("include of ... is not allowed"); the main bundle is
112 KB (35 KB gzip) instead of 471 KB (138 KB gzip).

## What exists
| Part | Files |
|---|---|
| Main-thread simulators | `src/sim/http_sim.js` (177 lines), `http_bridge.js` (128), `mqtt_sim.js` (376), `mqtt_bridge.js` (219) |
| C SDK | `compiler-server/sdk/net/http_client.h`, `mqtt_client.h`; `compiler-server/sim/http_client.c`, `mqtt_client.c`; the HTTP/MQTT entries in `compiler-server/sim/js_library.js` |
| Dependency | `mqtt` 5.15.0 (`package.json`), pre-bundled in `vite.config.js` (`optimizeDeps.include`) |
| Kept either way | `wifi-sim.js` / `wifi-bridge.js` and `cyw43_arch` (Wi-Fi association; used by tests) |

## Evidence (executed 2026-10-12)
1. **Nothing connects them to a running program.** `src/runtime/c/runtime.js` defines no `_sim_http_*` or `_sim_mqtt_*` hook (its comment says
   so on purpose) and Python has no `urequests`/`umqtt`. The only imports of the four JS modules are `resetHttp()` and
   `resetMqtt()` in `simulator-bridge.js`, which reset state that is never set.
2. **What a C program sees today.** I compiled and ran a program that calls the API (scenario runner):
   `http_get -> -1`, `mqtt_init -> 0` (success!), `mqtt_connect -> -1`, `mqtt_is_connected -> 0`. So `mqtt_init()` reports success for a
   feature that cannot work, and every other call fails with a generic error code.
3. **They could not work as shipped even if wired.** The page's Content-Security-Policy allows `connect-src 'self'` plus the CDNs only; a
   `fetch()` to a real URL or a WebSocket to a broker is blocked by it.
4. **No tests cover them.** No unit or browser test touches `http_sim`, `mqtt_sim` or the C APIs.
5. **They are expensive.** I built the app with `mqtt` replaced by a stub (a scratch build, nothing kept): the main bundle goes from
   **471 KB (138 KB gzip) to 114 KB (36 KB gzip)**. The MQTT library is about **three quarters of the app's JavaScript**.
6. **The Asyncify leftovers.** Since R3e there is no Asyncify, but `js_library.js` still marks `js_http_get` (and the MQTT calls) `__async`; calling them
   in a real network setup would not work as written.
7. **`npm audit --omit=dev`: 0 vulnerabilities** today, so this is about size, honesty and attack surface, not a known vulnerability.

## Recommendation: remove them (option 1)
| Option | Effect | Cost |
|---|---|---|
| **1. Remove (recommended)** | Delete the four JS modules, the two headers and two C files, the JS-library entries, the `mqtt` dependency and its Vite line; drop `resetHttp/resetMqtt` from the bridge; document "no networking beyond Wi-Fi association". A C program that includes `net/http_client.h` or `net/mqtt_client.h` then fails to compile with a clear "not available" message instead of silently returning errors. Bundle: about -358 KB (-103 KB gzip). | small; reversible from your folder copy; no tests to rewrite |
| 2. Keep as is | Misleading `mqtt_init() == OK`; 75 % of the JS for nothing; two stubs to maintain | none, but it is the credibility gap the project is trying to close |
| 3. Make them real | Worker RPC for HTTP, a CSP change, broker URL allow-listing, timeouts, tests, a security review | large, and a new attack surface; only worth it if networking is a goal of the project |
| 4. Keep the code, drop only the `mqtt` dependency | stub the MQTT client | halves the problem; leaves dead code |

What the removal consisted of: remove exactly the files and entries listed above, rebuild, run every suite (unit, scenario, browser,
production build), confirm the bundle size, and report. 
