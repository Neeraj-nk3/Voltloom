// Captures the screenshots used by README.md and the guides (docs/assets/*.png) from the real, running app.
//
//   npm run dev                        in one terminal (the app at http://localhost:5173/)
//   npm run docs:screenshots           in another; or: node scripts/capture-screenshots.mjs --url http://localhost:4173/
//
// Every image comes from the live page driven by Playwright: the traffic-light example
// (examples/projects/python-traffic-light.project.json) is opened from a share link and run. Nothing is mocked.
// Set VOLTLOOM_CHROMIUM to a Chrome/Chromium executable if Playwright's own browser is not installed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'docs', 'assets');
const urlArg = process.argv.indexOf('--url');
const base = (urlArg > 0 ? process.argv[urlArg + 1] : 'http://localhost:5173/').replace(/\/?$/, '/');

const project = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'projects', 'python-traffic-light.project.json'), 'utf8'));
const link = `${base}?p=${encodeURIComponent(Buffer.from(encodeURIComponent(JSON.stringify(project))).toString('base64'))}`;

const executablePath = process.env.VOLTLOOM_CHROMIUM || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
fs.mkdirSync(OUT, { recursive: true });

/** A fresh page in one theme, with the traffic light loaded, the restore notice dismissed and the circuit framed. */
async function open(theme) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: theme, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(link);
    await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
    await page.waitForFunction(() => window.monaco && document.fonts.status === 'loaded', null, { timeout: 30_000 });
    await page.waitForTimeout(800);
    if (await page.locator('#notice-close-btn').isVisible()) await page.click('#notice-close-btn');
    await fit(page);
    return { page, context, errors };
}
const fit = async (page) => { await page.click('#zoom-fit-btn'); await page.mouse.move(5, 300); await page.waitForTimeout(300); };
const output = (page, text) => page.waitForFunction((t) => document.getElementById('output').innerText.includes(t), text, { timeout: 20_000 });
const canvas = (page) => page.locator('#simulation-area').boundingBox();
const save = async (page, name, clip) => {
    await page.screenshot({ path: path.join(OUT, name), ...(clip ? { clip } : {}) });
    console.log(`wrote docs/assets/${name}`);
};
const shots = [];

// 1. The workspace, running: code, the lit traffic light, console output and the state inspector (dark theme)
shots.push(async () => {
    const { page, context, errors } = await open('dark');
    await page.click('#run-btn');
    await output(page, 'Light: red');                    // the program has set up its pins: the inspector lists them
    await page.click('#inspector-toggle-btn');
    await fit(page);
    await output(page, 'Light: green');
    await page.waitForTimeout(500);
    await save(page, 'voltloom-workspace.png');
    await page.click('#stop-btn');
    await context.close();
    return errors;
});

// 2. The circuit itself, close up, with red + yellow lit (light theme)
shots.push(async () => {
    const { page, context, errors } = await open('light');
    await page.click('#run-btn');
    await fit(page);
    await output(page, 'red + yellow');
    await page.waitForTimeout(500);
    await save(page, 'traffic-light-circuit.png', await canvas(page));
    await page.click('#stop-btn');
    await context.close();
    return errors;
});

// 3. The Python debugger, paused on a line, with the inspector open (dark theme)
shots.push(async () => {
    const { page, context, errors } = await open('dark');
    await page.click('#run-btn');
    await output(page, 'Light: red');
    await page.click('#pause-btn');
    await page.waitForFunction(() => /Paused · line/.test(document.getElementById('run-status-text').textContent), null, { timeout: 10_000 });
    await page.click('#inspector-toggle-btn');
    await fit(page);
    await save(page, 'debugger-paused.png');
    await page.click('#stop-btn');
    await context.close();
    return errors;
});

// 4. A selected wire with its reshaping handles and colour card (light theme)
shots.push(async () => {
    const { page, context, errors } = await open('light');
    await page.evaluate(() => {
        const cm = window.__voltloom.bridge.canvasManager;
        cm.wireManager.selectWire(cm.wires.find((w) => w.id === 'wire_6'));       // the yellow LED's cathode to GND
    });
    await page.waitForTimeout(400);
    await save(page, 'wire-editing.png', await canvas(page));
    await context.close();
    return errors;
});

// 5. The whole workspace in the light theme, idle
shots.push(async () => {
    const { page, context, errors } = await open('light');
    await save(page, 'light-theme.png');
    await context.close();
    return errors;
});

let failed = false;
for (const shot of shots) {
    const errors = await shot();
    if (errors.length) { failed = true; console.error('page errors:', errors.join('; ')); }
}
await browser.close();
process.exit(failed ? 1 : 0);
