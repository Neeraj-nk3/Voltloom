# Project file format

A project is JSON: what the share link (`?p=`, base64 of the URL-encoded JSON) carries and what autosave stores in the browser
(`localStorage` key `voltloom.project`, falling back to `sessionStorage`; a copy left under the key used by earlier builds, `circuitflow_project`, is still read when the new key is empty, and is never rewritten or deleted). Everything read from either place is untrusted
and goes through `validateProject()` (`src/project/project-schema.js`), which first **migrates** it to the current version
(`src/project/project-migrations.js`) and then checks it field by field. Nothing from a rejected project is used.

## Version 2 (current)
```jsonc
{
  "version": 2,
  "language": "python",                 // or "c"
  "board": "pico_w",
  "code": "…",                          // ≤ 200 000 characters
  "components": [ { "id": "led_1700000000001", "type": "led", "x": 120, "y": 340, "rotation": 0, "color": "#ef4444", "flipped": false },
                  { "id": "res_…", "type": "resistor", "value": 330, "unit": 1 },      // unit: 1 | 1000 | 1000000
                  { "id": "btn_…", "type": "button" } ],                               // pressed state is never saved
  "connections": [ { "id": "wire_1700000000500", "start": { "nodeType": "gpio", "pin": 20, "x": 1, "y": 2 },
                     "end": { "nodeType": "component_pin", "componentId": "res_…", "pin": "1" }, "color": "#15803d" } ],
  "meta": { "app": "voltloom", "savedAt": "2026-10-12T09:30:00.000Z" }                  // savedAt only in autosave copies
}
```
Limits: 100 components, 500 connections, coordinates within ±100 000, share-link parameter ≤ 400 000 characters.

A connection may also carry an optional `"route": [[x, y], ...]`: the bends of a wire the user shaped by hand (drawn with clicked corners or reshaped with its handles), in canvas units, without the two pin ends. It is only about how the wire is drawn and never changes what is connected. Without it, the wire is routed automatically. A malformed route (not an array of at most 64 coordinate pairs) is ignored rather than rejecting the project, and a copy of Voltloom that predates this field simply ignores it.

## What changed since version 1
| | v1 | v2 |
|---|---|---|
| Wire identity | none; an id was invented on every load (and wires loaded together shared one) | each connection has a unique `id` (`wire_<digits>`) that survives save and load |
| Provenance | none | `meta.app`, and `meta.savedAt` in autosave copies (used to pick the newest copy and to say when it was saved) |
| Duplicate / self connections | accepted, causing duplicate wires on the canvas | removed on load, with a note |

## Migration rules
* v1 → v2: wires get ids `wire_1`, `wire_2`, … in file order; `meta` is added. The original object is never modified; the result is
  identical on every run and re-validating a migrated project changes nothing.
* A version newer than this app understands, a missing/non-integer/zero version, or anything that is not a JSON object is refused with a
  message ("this project was saved by a newer version of Voltloom …"); it is never half-read.
* Migration does not launder bad data: a v1 project with a hostile colour, id or pin is rejected after migration exactly as in v2.
* To add version 3: bump `CURRENT_VERSION`, add `migrate2to3` to `STEPS`, add a real v2 fixture to `tests/fixtures/`.

Fixtures `tests/fixtures/project_v1_full.json` and `.link.txt` were produced by the version-1 code before the change.

## Autosave
Changes are written after one second without further changes, and at once when the page is hidden or closed. The header shows
the truth (`src/project/autosave.js`): *Unsaved changes* → *Saved 09:30* only after the stored text was read back identical;
*Not saved* with the reason (storage full / blocked) when the write failed; *Autosave off* when no storage is usable.
A project opened from a share link is stored by the next autosave. "Download" (the title-bar button) downloads only the program text as
`main.py` (also for C programs: a known inconsistency, not changed in this stage).
