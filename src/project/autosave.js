/**
 * autosave.js — saving the project in the browser, and telling the truth about it (DOM-free; storage and timers injected)
 *
 * What the status means:
 *   unsaved      you changed something and it has not been written yet
 *   saving       a write is in progress
 *   saved        the project was written AND read back identical; the status says where (this browser / this tab only)
 *   failed       the write was refused (storage full, blocked, ...); the project is NOT saved and the message says why
 *   unavailable  this page has no usable storage at all, so nothing can be autosaved (Share still works)
 *
 * "Saved" is only reported after the stored text is read back and compared, so a storage that silently drops writes can
 * never produce a "Saved" label. Writes happen shortly after the last change (debounced) and immediately when the page is
 * hidden or closed, so the last second of work is not lost to the debounce.
 *
 * Where it is kept: localStorage when it works (survives closing the browser), else sessionStorage (survives a refresh
 * but is cleared when the tab is closed), else nowhere.
 */

export const DEFAULT_KEY = 'voltloom.project';
/** Keys used by earlier builds. They are only READ (when the current key is empty), never written and never deleted. */
export const LEGACY_KEYS = ['circuitflow_project'];
export const DEFAULT_DELAY_MS = 1000;

/**
 * Pick the best storage that really works (a test write is made, because merely having the object proves nothing:
 * private windows and blocked cookies make setItem throw).
 * @returns {{kind: 'local'|'session'|'none', storage: Storage|null}}
 */
export function chooseStorage(host = globalThis) {
  const works = (getter) => {
    try {
      const storage = getter();
      if (!storage) return null;
      const probe = '__voltloom_probe__';
      storage.setItem(probe, '1');
      const ok = storage.getItem(probe) === '1';
      storage.removeItem(probe);
      return ok ? storage : null;
    } catch {
      return null;
    }
  };
  const local = works(() => host.localStorage);
  if (local) return { kind: 'local', storage: local };
  const session = works(() => host.sessionStorage);
  if (session) return { kind: 'session', storage: session };
  return { kind: 'none', storage: null };
}

const WHERE = { local: 'in this browser', session: 'in this tab only (cleared when the tab is closed)' };

/** A short, honest reason for a failed write. */
export function describeSaveError(error) {
  const name = (error && error.name) || '';
  const code = error && error.code;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014) {
    return 'browser storage is full';
  }
  if (name === 'SecurityError') return 'browser storage is blocked';
  return error && error.message ? `browser storage refused the write (${error.message})` : 'browser storage refused the write';
}

/**
 * @param {object} options
 * @param {(savedAt: string) => object|null} options.getProject  builds the project to store (savedAt goes into project.meta)
 * @param {{kind: string, storage: Storage|null}} options.store  from chooseStorage()
 * @param {(status: object) => void} options.onStatus
 * @param {string} [options.key]
 * @param {number} [options.delayMs]
 * @param {() => Date} [options.now]
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 */
export function createAutosave({ getProject, store, onStatus, key = DEFAULT_KEY, delayMs = DEFAULT_DELAY_MS,
  now = () => new Date(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h) }) {
  let timer = null;
  let dirty = false;
  let current = null;

  const publish = (status) => { current = status; onStatus(status); };

  if (!store || store.kind === 'none' || !store.storage) {
    publish({ state: 'unavailable', kind: 'none', message: 'Autosave unavailable: browser storage is blocked. Use Share to keep your work.' });
  } else {
    publish({ state: 'idle', kind: store.kind, message: 'Nothing changed yet' });
  }

  function writeNow() {
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (!store || !store.storage) return false;
    publish({ state: 'saving', kind: store.kind, message: 'Saving…' });
    const savedAt = now().toISOString();
    try {
      const project = getProject(savedAt);
      if (!project) { publish({ state: 'idle', kind: store.kind, message: 'Nothing to save' }); return false; }
      const json = JSON.stringify(project);
      store.storage.setItem(key, json);
      if (store.storage.getItem(key) !== json) throw new Error('the stored copy does not match');   // read it back: never claim a save we cannot see
      dirty = false;
      publish({ state: 'saved', kind: store.kind, savedAt, message: `Saved ${WHERE[store.kind]}` });
      return true;
    } catch (error) {
      publish({ state: 'failed', kind: store.kind, message: `Not saved: ${describeSaveError(error)}. Use Share to keep your work.` });
      return false;
    }
  }

  return {
    /** Something changed: show "unsaved" now, write after the debounce. */
    markDirty() {
      if (!store || !store.storage) return;
      dirty = true;
      publish({ state: 'unsaved', kind: store.kind, message: 'Unsaved changes' });
      if (timer !== null) clearTimer(timer);
      timer = setTimer(writeNow, delayMs);
    },
    /** A project that was just loaded FROM this storage is, by definition, already saved: show that, write nothing. */
    adoptSaved(savedAt) {
      if (!store || !store.storage) return;
      dirty = false;
      if (timer !== null) { clearTimer(timer); timer = null; }
      publish({ state: 'saved', kind: store.kind, savedAt: savedAt || null, message: `Restored from the copy saved ${WHERE[store.kind]}` });
    },
    /** Write immediately if there is anything unsaved (page hidden / closing). */
    flush() {
      if (dirty) writeNow();
    },
    /** Write immediately regardless (a manual "save now"). */
    saveNow: writeNow,
    status: () => current,
    isDirty: () => dirty
  };
}
