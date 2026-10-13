import { test, expect } from '@playwright/test';
import { makeProject, openProject, programOutput } from './helpers.js';

// A loop whose body spans several lines, so these tests also prove the checkpoint injection
// leaves multi-line statements intact while the debugger is active.
const LOOP = [
  'import time',
  'values = [10,',
  '          20,',
  '          30]',
  'i = 0',
  'while True:',
  '    print("tick", i, sum(values))',
  '    i += 1',
  '    time.sleep(0.2)',
  '',
].join('\n');

const ticks = async (page) => (await programOutput(page)).filter((l) => /^tick \d+ 60$/.test(l)).length;

test.describe('Python debugger', () => {
  test('Pause stops execution at the next statement, Step advances, Resume continues', async ({ page }) => {
    await openProject(page, makeProject({ code: LOOP }));
    await page.click('#run-btn');
    await expect.poll(() => ticks(page), { timeout: 15_000 }).toBeGreaterThan(2);

    await page.click('#pause-btn');
    await expect(page.locator('#resume-btn')).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(400);
    const paused = await ticks(page);
    await page.waitForTimeout(1200);
    expect(await ticks(page)).toBe(paused);          // really stopped

    await page.click('#step-btn');                    // runs up to the next checkpoint, then pauses again
    await page.waitForTimeout(600);
    await expect(page.locator('#resume-btn')).toBeVisible();

    await page.click('#resume-btn');
    await expect.poll(() => ticks(page), { timeout: 10_000 }).toBeGreaterThan(paused + 1);

    await page.click('#stop-btn');
  });

  test('Stop while paused ends the program cleanly', async ({ page }) => {
    await openProject(page, makeProject({ code: LOOP }));
    await page.click('#run-btn');
    await expect.poll(() => ticks(page), { timeout: 15_000 }).toBeGreaterThan(1);
    await page.click('#pause-btn');
    await expect(page.locator('#resume-btn')).toBeVisible({ timeout: 5_000 });
    await page.click('#stop-btn');
    await page.waitForTimeout(500);
    const after = await ticks(page);
    await page.waitForTimeout(1200);
    expect(await ticks(page)).toBe(after);
    expect((await programOutput(page)).join('\n')).toContain('Simulation Stopped');
  });
});
