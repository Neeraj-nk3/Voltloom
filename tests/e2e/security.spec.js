import { test, expect } from '@playwright/test';
import { makeProject, shareUrl, openProject, consoleLines, LED } from './helpers.js';

const EVIL_LED = { ...LED, id: 'led_1"><img src=x onerror="window.__pwn=1">' };

test.describe('share-link / project import safety', () => {
  test('a component id carrying markup does not execute script', async ({ page }) => {
    await page.goto(shareUrl(makeProject({ code: 'print(1)', components: [EVIL_LED] })), { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    expect(await page.evaluate(() => window.__pwn)).toBeUndefined();
  });

  test('an invalid project is rejected with a visible message and nothing is restored', async ({ page }) => {
    await page.goto(shareUrl(makeProject({ code: 'print(1)', components: [EVIL_LED] })), { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
    await page.waitForTimeout(500);
    expect((await consoleLines(page)).join('\n')).toMatch(/Project (import|link) rejected/i);
    expect(await page.evaluate(() => document.querySelectorAll('#board-container [id^=led_]').length)).toBe(0);
  });

  test('the page policy blocks injected inline event handlers (defence in depth)', async ({ page }) => {
    await openProject(page, makeProject({ code: 'print(1)' }));
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.innerHTML = '<img src=x onerror="window.__csp=1">';
      document.body.appendChild(d);
    });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__csp)).toBeUndefined();
  });

  test('program output is rendered as text, not HTML', async ({ page }) => {
    await openProject(page, makeProject({ code: 'print("<img src=x onerror=window.__pwn2=1>")\n' }));
    await page.click('#run-btn');
    await page.waitForTimeout(3000);
    expect(await page.evaluate(() => window.__pwn2)).toBeUndefined();
    expect((await consoleLines(page)).join('\n')).toContain('<img src=x onerror=window.__pwn2=1>');
  });
});
