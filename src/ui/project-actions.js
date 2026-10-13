/**
 * project-actions.js
 *
 * Handles strictly UI-layer actions for saving and sharing projects.
 * Does not modify internal state or serialization logic.
 */

import { printError } from './panels/serial-output.js';
import { setIcon } from './icons.js';

/**
 * Triggers a browser download of the provided string content.
 *
 * @param {string} code - The source code to save
 * @param {string} filename - The name of the file to save (default: main.py; the app passes main.c for C code)
 */
export function handleSaveCode(code, filename = 'main.py') {
    if (!code) {
        console.warn('No code to save.');
        return;
    }

    try {
        const blob = new Blob([code], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;

        // Append to DOM, click, and cleanup
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);

        console.log(`[Project Actions] Saved code to ${filename}`);
    } catch (err) {
        console.error('[Project Actions] Failed to save code:', err);
        printError(`Could not download ${filename}: ${err.message || err}`);
    }
}

// A link this long still works in a browser, but chat apps and some servers cut long links.
const LONG_LINK_CHARS = 8000;

/**
 * Shows the share link in a dialog (Escape closes it; the browser returns focus to the Share button).
 *
 * @param {string} shareUrl - The fully assembled URL containing the project data
 */
export function handleShareProject(shareUrl) {
    if (!shareUrl) return;

    const modal = document.getElementById('share-modal');
    const input = document.getElementById('share-modal-input');
    const copyBtn = document.getElementById('share-modal-copy-btn');
    const copyText = document.getElementById('share-modal-copy-text');
    const note = document.getElementById('share-modal-note');
    const closeBtn = document.getElementById('share-modal-close-btn');
    const closeIcon = document.getElementById('share-modal-close-icon');

    if (!modal || !input || !copyBtn) {
        console.error('[Project Actions] Missing share dialog elements in the DOM.');
        return;
    }

    const resetCopyButton = () => {
        copyText.textContent = 'Copy';
        copyBtn.classList.remove('copy-ok');
        setIcon(copyBtn.querySelector('svg'), 'copy');
    };

    input.value = shareUrl;
    resetCopyButton();
    note.textContent = shareUrl.length > LONG_LINK_CHARS
        ? `This link is ${shareUrl.length.toLocaleString()} characters long. Some chat apps cut long links; for a large project, send the code with Download as well.`
        : `${shareUrl.length.toLocaleString()} characters.`;

    if (!modal.open) modal.showModal();
    input.select();                                       // so the link can also be copied by hand

    let resetTimer = null;
    copyBtn.onclick = async () => {
        try {
            if (!navigator.clipboard) throw new Error('clipboard unavailable');
            await navigator.clipboard.writeText(shareUrl);
            copyText.textContent = 'Copied';
            copyBtn.classList.add('copy-ok');
            setIcon(copyBtn.querySelector('svg'), 'check');
            clearTimeout(resetTimer);
            resetTimer = setTimeout(resetCopyButton, 1800);
        } catch (err) {
            console.error('[Project Actions] Could not copy text: ', err);
            input.focus();
            input.select();
            note.textContent = 'The browser did not allow copying. The link is selected: press Ctrl+C (⌘C on a Mac).';
        }
    };

    const hideModal = () => modal.close();
    if (closeBtn) closeBtn.onclick = hideModal;
    if (closeIcon) closeIcon.onclick = hideModal;

    // A click on the dimmed area around the dialog closes it
    modal.onclick = (e) => {
        if (e.target === modal) hideModal();
    };
}
