import { test, expect } from '@playwright/test';
import { makeProject, openProject, programOutput, LED } from './helpers.js';

// Light and dark themes: first visit follows the operating system, an explicit choice is kept across reloads, nothing is
// lost or restarted by a switch, the editor follows, there is no flash of the wrong theme, and blocked storage is fine.

const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);
const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const editorTheme = (page) => page.evaluate(() => {
  const el = document.querySelector('.monaco-editor');
  return el && (el.classList.contains('vs-dark') ? 'dark' : el.classList.contains('vs') ? 'light' : 'other');
});
const choose = async (page, choice) => {
  await page.click('#theme-btn');
  await page.click(`#theme-menu [data-theme-choice="${choice}"]`);
};
const project = makeProject({ code: 'import time\nwhile True:\n    print("tick")\n    time.sleep(0.2)\n', components: [{ ...LED, id: 'led_1' }] });

test.describe('themes', () => {
  for (const scheme of ['light', 'dark']) {
    test(`a first visit follows the system preference (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openProject(page, project);
      expect(await theme(page)).toBe(scheme);
      await expect(page.locator('#theme-btn')).toHaveAttribute('aria-label', new RegExp(`${scheme === 'light' ? 'Light' : 'Dark'} \\(follows the system\\)`));
      await expect.poll(() => editorTheme(page)).toBe(scheme);
    });
  }

  test('"System" keeps following the operating system when it changes', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openProject(page, project);
    expect(await theme(page)).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => theme(page)).toBe('light');
  });

  test('an explicit choice wins over the system and survives a reload; the menu shows which one is chosen', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openProject(page, project);
    const darkBg = await bg(page);
    await choose(page, 'light');
    expect(await theme(page)).toBe('light');
    expect(await bg(page)).not.toBe(darkBg);
    await page.click('#theme-btn');
    await expect(page.locator('#theme-menu [data-theme-choice="light"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#theme-menu [data-theme-choice="system"]')).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
    await expect(page.locator('#theme-btn')).toHaveAttribute('aria-label', 'Theme: Light');

    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
    expect(await theme(page)).toBe('light');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await theme(page)).toBe('light');                                    // a fixed choice ignores the system

    await choose(page, 'system');
    expect(await theme(page)).toBe('dark');
  });

  test('the theme is set before anything is painted (no flash of the wrong theme)', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('voltloom.ui.theme', JSON.stringify('light'));
      window.__firstTheme = null;
      new MutationObserver(() => {}).observe(document, { childList: true, subtree: true });
      document.addEventListener('readystatechange', () => { if (window.__firstTheme === null) window.__firstTheme = document.documentElement.dataset.theme || 'unset'; });
      document.addEventListener('DOMContentLoaded', () => { window.__atDomReady = document.documentElement.dataset.theme || 'unset'; });
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    expect(await page.evaluate(() => window.__firstTheme)).toBe('light');
    expect(await page.evaluate(() => window.__atDomReady)).toBe('light');
  });

  test('switching while editing and while a program runs loses nothing and restarts nothing', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openProject(page, project);
    await page.evaluate(() => {
      const e = window.monaco.editor.getEditors()[0];
      e.executeEdits('t', [{ range: new window.monaco.Range(1, 1, 1, 1), text: '# edited\n' }]);
      e.setPosition({ lineNumber: 3, column: 4 });
    });
    await page.click('#run-btn');
    await expect.poll(async () => (await programOutput(page)).filter((l) => l === 'tick').length).toBeGreaterThan(1);
    const before = (await programOutput(page)).length;

    await choose(page, 'light');
    await choose(page, 'dark');
    await choose(page, 'light');

    await expect(page.locator('#run-status-text')).toHaveText('Running · Python');
    await expect.poll(async () => (await programOutput(page)).length).toBeGreaterThan(before);     // still printing
    expect((await programOutput(page)).filter((l) => /Initializing Worker/.test(l)).length).toBe(1);  // never restarted
    expect(await page.evaluate(() => window.monaco.editor.getEditors()[0].getValue())).toMatch(/^# edited\n/);
    expect(await page.evaluate(() => { const p = window.monaco.editor.getEditors()[0].getPosition(); return [p.lineNumber, p.column]; })).toEqual([3, 4]);
    expect(await page.evaluate(() => window.monaco.editor.getEditors()[0].getModel().canUndo())).toBe(true);
    expect(await page.evaluate(() => window.__voltloom.bridge.canvasManager.components.length)).toBe(1);
    await expect.poll(() => editorTheme(page)).toBe('light');
    await page.click('#stop-btn');
  });

  test('blocked browser storage: the theme still works for this page and nothing breaks', async ({ page }) => {
    await page.addInitScript(() => {
      for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(window, name, { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
    expect(await theme(page)).toBe('light');
    await choose(page, 'dark');
    expect(await theme(page)).toBe('dark');
    expect(errors).toEqual([]);
  });

  test('the theme menu works from the keyboard', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openProject(page, project);
    await page.focus('#theme-btn');
    await page.keyboard.press('Enter');
    await expect(page.locator('#theme-menu [data-theme-choice="system"]')).toBeFocused();   // starts on the current choice
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expect(await theme(page)).toBe('light');
    await expect(page.locator('#theme-btn')).toBeFocused();
  });
});
