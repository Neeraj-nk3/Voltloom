/**
 * fs-sim.js — Filesystem Simulation Engine
 *
 * Simulates Pico W flash storage using browser localStorage.
 * All files are stored with a "pico_fs:" prefix to avoid collisions
 * with other localStorage data.
 *
 * RESPONSIBILITIES:
 *   - Read/write/delete files in localStorage
 *   - Check file existence
 *   - List all stored files
 *   - Track initialization state
 *   - Preserve files across simulation reset (flash behavior)
 *
 * DOES NOT:
 *   - Print to Serial Monitor (that's fs-bridge.js)
 *   - Touch the DOM or UI
 *   - Modify GPIO, PWM or Wi-Fi state
 *   - Clear files on simulation reset (flash survives reset)
 *
 * PERSISTENCE MODEL:
 *   - localStorage persists across page reloads (like flash)
 *   - resetAll() only clears the init flag, NOT stored files
 *   - formatAll() explicitly clears ALL files (user-triggered only)
 *   - localStorage quota is ~5-10MB depending on browser
 */

// ---------- Constants ----------

/** Prefix for all filesystem keys in localStorage */
const FS_PREFIX = 'pico_fs:';

/** Error codes matching compiler/sdk/include/fs/fs.h */
const FS_OK = 0;
const FS_ERR_NOT_FOUND = -1;
const FS_ERR_WRITE = -2;
const FS_ERR_INIT = -3;

// ---------- State ----------

/**
 * Runtime state (RAM — resets on simulation stop):
 *   initialized : boolean — has fs_init() been called this session?
 */
const state = {
    initialized: false
};

// ---------- Init ----------

/**
 * Initialize the filesystem.
 * Checks that localStorage is available.
 *
 * @returns {number} — FS_OK (0) on success, FS_ERR_INIT (-3) if unavailable
 */
export function init() {
    try {
        // Test localStorage availability
        const testKey = FS_PREFIX + '__test__';
        localStorage.setItem(testKey, '1');
        localStorage.removeItem(testKey);
        state.initialized = true;
        return FS_OK;
    } catch (err) {
        state.initialized = false;
        return FS_ERR_INIT;
    }
}

// ---------- Write ----------

/**
 * Write data to a file. Creates or overwrites.
 *
 * @param {string} filename — file name
 * @param {string} data     — file contents
 * @returns {number} — FS_OK on success, FS_ERR_WRITE on failure
 */
export function writeFile(filename, data) {
    if (!state.initialized) return FS_ERR_INIT;

    try {
        localStorage.setItem(FS_PREFIX + filename, String(data));
        return FS_OK;
    } catch (err) {
        // Most common: QuotaExceededError when localStorage is full
        return FS_ERR_WRITE;
    }
}

// ---------- Read ----------

/**
 * Read data from a file.
 *
 * @param {string} filename — file name
 * @param {number} [maxLen] — max characters to return (optional)
 * @returns {{status: number, data: string}}
 *   - status: FS_OK or FS_ERR_NOT_FOUND
 *   - data: file contents (possibly truncated) or empty string
 */
export function readFile(filename, maxLen) {
    if (!state.initialized) return { status: FS_ERR_INIT, data: '' };

    const value = localStorage.getItem(FS_PREFIX + filename);

    if (value === null) {
        return { status: FS_ERR_NOT_FOUND, data: '' };
    }

    // Truncate to maxLen if specified
    const data = (typeof maxLen === 'number' && maxLen > 0 && value.length > maxLen - 1)
        ? value.substring(0, maxLen - 1)
        : value;

    return { status: FS_OK, data: data };
}

// ---------- Exists ----------

/**
 * Check if a file exists.
 *
 * @param {string} filename — file name
 * @returns {boolean}
 */
export function fileExists(filename) {
    if (!state.initialized) return false;
    return localStorage.getItem(FS_PREFIX + filename) !== null;
}

// ---------- Delete ----------

/**
 * Delete a file.
 *
 * @param {string} filename — file name
 * @returns {number} — FS_OK on success, FS_ERR_NOT_FOUND if missing
 */
export function deleteFile(filename) {
    if (!state.initialized) return FS_ERR_INIT;

    if (localStorage.getItem(FS_PREFIX + filename) === null) {
        return FS_ERR_NOT_FOUND;
    }

    localStorage.removeItem(FS_PREFIX + filename);
    return FS_OK;
}

// ---------- List ----------

/**
 * List all files in the virtual filesystem.
 *
 * @returns {string[]} — array of file names (without prefix)
 */
export function listFiles() {
    const files = [];

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(FS_PREFIX)) {
            files.push(key.substring(FS_PREFIX.length));
        }
    }

    return files;
}

// ---------- Format ----------

/**
 * Delete ALL files from the virtual filesystem.
 * This is a destructive operation — only called by explicit user action.
 * NOT called during normal simulation reset.
 */
export function formatAll() {
    const keys = [];

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(FS_PREFIX)) {
            keys.push(key);
        }
    }

    keys.forEach(key => localStorage.removeItem(key));
}

// ---------- Lifecycle ----------

/**
 * Reset runtime state only.
 * DOES NOT clear stored files — flash survives reset.
 * Called on simulation stop or system reset.
 */
export function resetAll() {
    state.initialized = false;
    // NOTE: localStorage data is intentionally preserved.
    // This matches real Pico behavior where flash survives reset.
}

// ---------- Exported Constants ----------

export {
    FS_OK,
    FS_ERR_NOT_FOUND,
    FS_ERR_WRITE,
    FS_ERR_INIT
};
