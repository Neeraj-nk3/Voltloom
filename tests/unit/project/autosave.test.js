import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { chooseStorage, createAutosave, describeSaveError, DEFAULT_KEY, LEGACY_KEYS } from '../../../src/project/autosave.js';
import { load, save, createProject, getLastLoadedFrom, getLastImportNotes } from '../../../src/project/project-store.js';

/** A Storage-like object; `behavior` lets a test make it refuse, drop or corrupt writes. */
function fakeStorage(behavior = {}) {
  const data = new Map();
  return {
    data,
    getItem: (k) => (behavior.getThrows ? (() => { throw behavior.getThrows; })() : data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      if (behavior.setThrows) throw behavior.setThrows;
      if (behavior.dropWrites) return;                          // pretends to work, stores nothing
      data.set(k, behavior.corrupt ? v + 'x' : String(v));
    },
    removeItem: (k) => data.delete(k),
  };
}
const domError = (name, code) => Object.assign(new Error(name), { name, code });

function fakeTimers() {
  const t = { queue: [], now: 0 };
  t.setTimer = (fn, ms) => { const h = { fn, at: t.now + ms }; t.queue.push(h); return h; };
  t.clearTimer = (h) => { t.queue = t.queue.filter((x) => x !== h); };
  t.advance = (ms) => { t.now += ms; const due = t.queue.filter((h) => h.at <= t.now); t.queue = t.queue.filter((h) => h.at > t.now); due.forEach((h) => h.fn()); };
  return t;
}

function setup({ storage = fakeStorage(), kind = 'local', project = (savedAt) => ({ version: 2, code: 'x', meta: { savedAt } }) } = {}) {
  const timers = fakeTimers();
  const statuses = [];
  const autosave = createAutosave({
    getProject: project, store: { kind, storage }, onStatus: (s) => statuses.push(s), delayMs: 1000,
    now: () => new Date('2026-10-12T09:30:00.000Z'), setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  return { autosave, storage, timers, statuses, states: () => statuses.map((s) => s.state) };
}

describe('autosave: states and honesty', () => {
  it('starts idle; a change shows "unsaved" at once and "saved" only after the write and read-back', () => {
    const { autosave, timers, states, storage } = setup();
    expect(states()).toEqual(['idle']);
    autosave.markDirty();
    expect(states()).toEqual(['idle', 'unsaved']);
    expect(storage.data.size).toBe(0);                                  // nothing written yet: the label does not claim otherwise
    timers.advance(999); expect(storage.data.size).toBe(0);
    timers.advance(1);
    expect(states()).toEqual(['idle', 'unsaved', 'saving', 'saved']);
    expect(autosave.status()).toMatchObject({ state: 'saved', kind: 'local', savedAt: '2026-10-12T09:30:00.000Z', message: 'Saved in this browser' });
    expect(JSON.parse(storage.data.get(DEFAULT_KEY)).meta.savedAt).toBe('2026-10-12T09:30:00.000Z');   // the stored copy carries its time
  });

  it('many quick changes cause one write (debounce), counted from the LAST change', () => {
    const { autosave, timers, storage } = setup();
    let writes = 0; const set = storage.setItem; storage.setItem = (k, v) => { writes++; set(k, v); };
    autosave.markDirty(); timers.advance(600); autosave.markDirty(); timers.advance(600); autosave.markDirty();
    expect(writes).toBe(0);
    timers.advance(1000);
    expect(writes).toBe(1);
  });

  it('session storage says "this tab only", and that it is cleared when the tab closes', () => {
    const { autosave, timers } = setup({ kind: 'session' });
    autosave.markDirty(); timers.advance(1000);
    expect(autosave.status().message).toBe('Saved in this tab only (cleared when the tab is closed)');
  });

  it('a storage that silently drops writes never produces a "saved" status', () => {
    const { autosave, timers, states } = setup({ storage: fakeStorage({ dropWrites: true }) });
    autosave.markDirty(); timers.advance(1000);
    expect(states()).not.toContain('saved');
    expect(autosave.status().state).toBe('failed');
    expect(autosave.status().message).toMatch(/^Not saved: /);
  });

  it('a storage that corrupts what it stores is caught by the read-back', () => {
    const { autosave, timers } = setup({ storage: fakeStorage({ corrupt: true }) });
    autosave.markDirty(); timers.advance(1000);
    expect(autosave.status().state).toBe('failed');
  });

  it.each([
    [domError('QuotaExceededError', 22), 'browser storage is full'],
    [domError('NS_ERROR_DOM_QUOTA_REACHED', 1014), 'browser storage is full'],
    [domError('SecurityError', 18), 'browser storage is blocked'],
    [new Error('disk on fire'), 'browser storage refused the write (disk on fire)'],
  ])('a refused write is reported with its reason: %#', (error, reason) => {
    expect(describeSaveError(error)).toBe(reason);
    const { autosave, timers } = setup({ storage: fakeStorage({ setThrows: error }) });
    autosave.markDirty(); timers.advance(1000);
    expect(autosave.status()).toMatchObject({ state: 'failed', message: `Not saved: ${reason}. Use Share to keep your work.` });
    expect(autosave.isDirty()).toBe(true);                                 // still unsaved: the next change tries again
  });

  it('after a failure the next change tries again and can succeed', () => {
    const storage = fakeStorage({ setThrows: domError('QuotaExceededError', 22) });
    const { autosave, timers } = setup({ storage });
    autosave.markDirty(); timers.advance(1000);
    expect(autosave.status().state).toBe('failed');
    storage.setItem = fakeStorage().setItem.bind(storage);                  // space freed up
    const working = fakeStorage();
    storage.setItem = working.setItem; storage.getItem = working.getItem;
    autosave.markDirty(); timers.advance(1000);
    expect(autosave.status().state).toBe('saved');
  });

  it('with no storage at all it says so up front and never pretends', () => {
    const timers = fakeTimers(); const statuses = [];
    const autosave = createAutosave({ getProject: () => ({}), store: { kind: 'none', storage: null }, onStatus: (s) => statuses.push(s), setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    expect(statuses[0]).toMatchObject({ state: 'unavailable', kind: 'none' });
    expect(statuses[0].message).toMatch(/Use Share to keep your work/);
    autosave.markDirty(); timers.advance(5000);
    expect(statuses).toHaveLength(1);
  });

  it('flush() writes at once when something is unsaved (page closing) and does nothing when clean', () => {
    const { autosave, timers, storage } = setup();
    autosave.flush();
    expect(storage.data.size).toBe(0);
    autosave.markDirty();
    autosave.flush();
    expect(autosave.status().state).toBe('saved');
    expect(timers.queue).toHaveLength(0);                                   // the pending debounce was cancelled
    const writes = storage.data.size;
    autosave.flush();
    expect(storage.data.size).toBe(writes);
  });

  it('adoptSaved() marks a just-loaded project as saved without writing', () => {
    const { autosave, storage } = setup();
    autosave.adoptSaved('2026-10-11T08:00:00.000Z');
    expect(autosave.status()).toMatchObject({ state: 'saved', savedAt: '2026-10-11T08:00:00.000Z' });
    expect(storage.data.size).toBe(0);
    expect(autosave.isDirty()).toBe(false);
  });

  it('nothing to save (getProject returns null) is not reported as saved', () => {
    const { autosave, timers } = setup({ project: () => null });
    autosave.markDirty(); timers.advance(1000);
    expect(autosave.status().state).toBe('idle');
  });
});

describe('chooseStorage', () => {
  it('prefers localStorage, falls back to sessionStorage, then to nothing', () => {
    const ok = () => fakeStorage();
    expect(chooseStorage({ localStorage: ok(), sessionStorage: ok() }).kind).toBe('local');
    const blocked = { get localStorage() { throw domError('SecurityError', 18); }, sessionStorage: ok() };
    expect(chooseStorage(blocked).kind).toBe('session');
    expect(chooseStorage({ localStorage: fakeStorage({ setThrows: domError('QuotaExceededError', 22) }), sessionStorage: ok() }).kind).toBe('session');
    expect(chooseStorage({ localStorage: fakeStorage({ setThrows: new Error('x') }), sessionStorage: fakeStorage({ setThrows: new Error('y') }) }).kind).toBe('none');
    expect(chooseStorage({}).kind).toBe('none');
  });

  it('a storage that accepts writes but never returns them does not count as working', () => {
    expect(chooseStorage({ localStorage: fakeStorage({ dropWrites: true }), sessionStorage: fakeStorage() }).kind).toBe('session');
  });

  it('leaves no probe key behind', () => {
    const local = fakeStorage();
    chooseStorage({ localStorage: local });
    expect(local.data.size).toBe(0);
  });
});

describe('project-store: save() reports what happened, load() takes the newest valid copy', () => {
  const comps = [{ id: 'led_1700000000001', color: '#ef4444', flipped: false, x: 1, y: 2, rotation: 0 }];
  const project = (savedAt, code = 'print(1)') => createProject(code, 'python', comps, [], 'pico_w', savedAt ? { savedAt } : {});

  it('save() returns ok with the storage kind, or the error', () => {
    const local = fakeStorage();
    expect(save(project(), { kind: 'local', storage: local })).toEqual({ ok: true, kind: 'local' });
    const full = fakeStorage({ setThrows: domError('QuotaExceededError', 22) });
    const result = save(project(), { kind: 'local', storage: full });
    expect(result.ok).toBe(false);
    expect(describeSaveError(result.error)).toBe('browser storage is full');
    expect(save(project(), { kind: 'none', storage: null }).ok).toBe(false);
  });

  it('load() picks the copy with the later timestamp, whichever storage holds it', () => {
    const local = fakeStorage(); const session = fakeStorage();
    save(project('2026-10-10T00:00:00.000Z', 'older'), { kind: 'local', storage: local });
    save(project('2026-10-12T00:00:00.000Z', 'newer'), { kind: 'session', storage: session });
    expect(load({ localStorage: local, sessionStorage: session }).code).toBe('newer');
    expect(getLastLoadedFrom()).toBe('session');
    expect(load({ localStorage: session, sessionStorage: local }).code).toBe('newer');
    expect(getLastLoadedFrom()).toBe('local');
  });

  it('a copy without a timestamp (old app) loses to one with a timestamp, and ties go to localStorage', () => {
    const local = fakeStorage(); const session = fakeStorage();
    save(project(null, 'unstamped-local'), { kind: 'local', storage: local });
    save(project(null, 'unstamped-session'), { kind: 'session', storage: session });
    expect(load({ localStorage: local, sessionStorage: session }).code).toBe('unstamped-local');
    save(project('2026-10-12T00:00:00.000Z', 'stamped'), { kind: 'session', storage: session });
    expect(load({ localStorage: local, sessionStorage: session }).code).toBe('stamped');
  });

  it('a stored VERSION 1 project (left by the old app) loads and is upgraded', () => {
    const session = fakeStorage();
    session.data.set(DEFAULT_KEY, fs.readFileSync('tests/fixtures/project_v1_full.json', 'utf8'));
    const loaded = load({ localStorage: fakeStorage(), sessionStorage: session });
    expect(loaded.version).toBe(2);
    expect(loaded.connections).toHaveLength(5);
    expect(getLastImportNotes()).toContain('project upgraded from version 1 to 2');
    expect(getLastLoadedFrom()).toBe('session');
  });

  it('the storage key is Voltloom\'s own, and a copy left under the previous key (circuitflow_project) is still found, never rewritten or deleted', () => {
    expect(DEFAULT_KEY).toBe('voltloom.project');
    expect(LEGACY_KEYS).toEqual(['circuitflow_project']);
    const local = fakeStorage();
    const legacyJson = fs.readFileSync('tests/fixtures/project_v1_full.json', 'utf8');
    local.data.set('circuitflow_project', legacyJson);
    const loaded = load({ localStorage: local, sessionStorage: fakeStorage() });
    expect(loaded.version).toBe(2);
    expect(getLastLoadedFrom()).toBe('local');
    expect(local.data.get('circuitflow_project')).toBe(legacyJson);          // read-only access to the old key
    expect(local.data.has(DEFAULT_KEY)).toBe(false);                         // loading alone does not write the new key
  });

  it('when both keys exist in one storage the current key wins', () => {
    const local = fakeStorage();
    local.data.set('circuitflow_project', fs.readFileSync('tests/fixtures/project_v1_full.json', 'utf8'));
    save(project('2026-10-12T00:00:00.000Z', 'current'), { kind: 'local', storage: local });
    expect(load({ localStorage: local, sessionStorage: fakeStorage() }).code).toBe('current');
  });

  it('garbage or hostile stored data is ignored, not loaded; a good copy in the other storage still wins', () => {
    const local = fakeStorage(); const session = fakeStorage();
    local.data.set(DEFAULT_KEY, '{not json');
    session.data.set(DEFAULT_KEY, JSON.stringify({ version: 2, components: [{ id: 'led_1', type: 'led' }] }));
    expect(load({ localStorage: local, sessionStorage: session })).toBeNull();
    save(project('2026-10-12T00:00:00.000Z', 'good'), { kind: 'session', storage: session });
    expect(load({ localStorage: local, sessionStorage: session }).code).toBe('good');
  });

  it('a throwing storage does not break load()', () => {
    expect(load({ get localStorage() { throw new Error('blocked'); }, sessionStorage: fakeStorage({ getThrows: new Error('also') }) })).toBeNull();
  });
});
