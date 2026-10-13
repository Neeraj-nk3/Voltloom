/**
 * project-migrations.js — bringing older saved projects up to the current schema (pure)
 *
 * A project file (a share link, or what autosave stored) carries a `version`. Each step below turns version N into
 * version N+1 on a COPY of the data; nothing is validated here (project-schema.js does that afterwards, on the
 * current version only), and nothing is ever guessed: a project from a newer version of the app, or with no usable
 * version, is refused with a message instead of being half-read.
 *
 *   v1  original format. Wires ("connections") had no ids; the id was invented anew on every load.
 *   v2  wires carry their own ids (so identity survives a save/load), and a `meta` block records which app wrote the
 *       project and when it was saved.
 *
 * To add version 3: bump PROJECT_VERSION in project-schema.js, write `migrate2to3`, add it to STEPS, and add a fixture of
 * a real v2 project to tests/fixtures.
 */

export const CURRENT_VERSION = 2;
export const OLDEST_SUPPORTED_VERSION = 1;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** v1 -> v2: give every wire an id (wire_1, wire_2, ... in file order) and add the meta block. */
function migrate1to2(project) {
    const connections = Array.isArray(project.connections)
        ? project.connections.map((w, i) => (isPlainObject(w) ? { ...w, id: `wire_${i + 1}` } : w))
        : project.connections;
    return { ...project, version: 2, connections, meta: { app: 'voltloom' } };
}

const STEPS = { 1: migrate1to2 };

/**
 * @param {unknown} raw  parsed JSON
 * @returns {{ok: true, project: object, notes: string[]} | {ok: false, errors: string[]}}
 */
export function migrateProject(raw) {
    if (!isPlainObject(raw)) return { ok: false, errors: ['project must be an object'] };
    const version = raw.version;
    if (!Number.isInteger(version) || version < 1) {
        return { ok: false, errors: [`unsupported version (expected a whole number from ${OLDEST_SUPPORTED_VERSION} to ${CURRENT_VERSION})`] };
    }
    if (version > CURRENT_VERSION) {
        return { ok: false, errors: [`this project was saved by a newer version of Voltloom (project version ${version}; this one understands up to ${CURRENT_VERSION})`] };
    }

    const notes = [];
    let project = raw;
    for (let v = version; v < CURRENT_VERSION; v++) {
        project = STEPS[v](project);
        notes.push(`project upgraded from version ${v} to ${v + 1}`);
    }
    return { ok: true, project, notes };
}
