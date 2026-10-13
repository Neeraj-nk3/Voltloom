/**
 * fs-bridge.js — Filesystem Bridge Layer (Public API)
 *
 * This is the ONLY module that simulator-bridge.js and other parts of
 * the simulator should call for filesystem operations.
 *
 * DATA FLOW:
 *   User code → fs-bridge.fsWrite("config.txt", "data")
 *                 → fs-sim.writeFile("config.txt", "data")
 *                 → localStorage.setItem("pico_fs:config.txt", "data")
 *                 → serial-output.print("[FS] Wrote config.txt")
 *
 * RESPONSIBILITIES:
 *   - Provide SDK-named functions matching fs.h
 *   - Validate inputs before passing to fs-sim
 *   - Print status messages to Serial Monitor
 *   - Route cleanup calls to fs-sim on simulation stop
 *
 * DOES NOT:
 *   - Access localStorage directly (that's fs-sim.js)
 *   - Touch the DOM or UI
 *   - Modify GPIO, PWM or Wi-Fi state
 */

import {
    init,
    writeFile,
    readFile,
    fileExists,
    deleteFile,
    listFiles,
    formatAll,
    resetAll,
    FS_OK,
    FS_ERR_NOT_FOUND,
    FS_ERR_WRITE,
    FS_ERR_INIT
} from './fs-sim.js';

import { print, debug } from '../ui/panels/serial-output.js';

// ---------- SDK-Style Functions ----------

/**
 * Initialize the filesystem.
 * Mirrors: fs_init()
 *
 * @returns {number} — FS_OK (0) on success
 */
export function fsInit() {
    const result = init();
    if (result === FS_OK) {
        print('[FS] Filesystem initialized');
    } else {
        print('[FS] ERROR: localStorage unavailable');
    }
    return result;
}

/**
 * Write data to a file.
 * Mirrors: fs_write()
 *
 * @param {string} filename — file name
 * @param {string} data     — file contents
 * @returns {number} — FS_OK on success
 */
export function fsWrite(filename, data) {
    if (!filename || typeof filename !== 'string') {
        print('[FS] ERROR: Invalid filename');
        return FS_ERR_WRITE;
    }

    const result = writeFile(filename, data);

    if (result === FS_OK) {
        debug(`[FS] Wrote "${filename}" (${String(data).length} bytes)`);
    } else if (result === FS_ERR_INIT) {
        print('[FS] ERROR: Filesystem not initialized');
    } else {
        print(`[FS] ERROR: Write failed for "${filename}" (storage full?)`);
    }

    return result;
}

/**
 * Read data from a file.
 * Mirrors: fs_read()
 *
 * @param {string} filename — file name
 * @param {number} [maxLen] — max characters to return
 * @returns {{status: number, data: string}}
 */
export function fsRead(filename, maxLen) {
    if (!filename || typeof filename !== 'string') {
        print('[FS] ERROR: Invalid filename');
        return { status: FS_ERR_NOT_FOUND, data: '' };
    }

    const result = readFile(filename, maxLen);

    if (result.status === FS_OK) {
        debug(`[FS] Read "${filename}" (${result.data.length} bytes)`);
    } else if (result.status === FS_ERR_INIT) {
        print('[FS] ERROR: Filesystem not initialized');
    } else {
        print(`[FS] ERROR: File "${filename}" not found`);
    }

    return result;
}

/**
 * Check if a file exists.
 * Mirrors: fs_exists()
 *
 * @param {string} filename — file name
 * @returns {boolean}
 */
export function fsExists(filename) {
    if (!filename || typeof filename !== 'string') return false;
    return fileExists(filename);
}

/**
 * Delete a file.
 * Mirrors: fs_delete()
 *
 * @param {string} filename — file name
 * @returns {number} — FS_OK on success
 */
export function fsDelete(filename) {
    if (!filename || typeof filename !== 'string') {
        print('[FS] ERROR: Invalid filename');
        return FS_ERR_NOT_FOUND;
    }

    const result = deleteFile(filename);

    if (result === FS_OK) {
        print(`[FS] Deleted "${filename}"`);
    } else if (result === FS_ERR_INIT) {
        print('[FS] ERROR: Filesystem not initialized');
    } else {
        print(`[FS] ERROR: File "${filename}" not found`);
    }

    return result;
}

/**
 * List all files in the virtual filesystem.
 *
 * @returns {string[]}
 */
export function fsList() {
    const files = listFiles();
    debug(`[FS] ${files.length} file(s): ${files.join(', ') || '(empty)'}`);
    return files;
}

/**
 * Format the entire filesystem (delete all files).
 * Destructive — only for explicit user action.
 */
export function fsFormat() {
    formatAll();
    print('[FS] Filesystem formatted (all files deleted)');
}

// ---------- Lifecycle ----------

/**
 * Reset filesystem runtime state.
 * Clears init flag but preserves stored files (flash survives reset).
 * Called on simulation stop or system reset.
 */
export function resetFs() {
    resetAll();
}

// ---------- Re-export constants ----------

export {
    FS_OK,
    FS_ERR_NOT_FOUND,
    FS_ERR_WRITE,
    FS_ERR_INIT
};
