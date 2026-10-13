
export const gpio = (pin) => ({ nodeType: 'gpio', pin, x: 0, y: 0 });
export const cp = (componentId, pin) => ({ nodeType: 'component_pin', componentId, pin });
export const wire = (a, b) => ({ start: a, end: b, color: '#15803d' });

export const LED = { id: 'led_1', type: 'led', x: 100, y: 300, rotation: 0, color: '#ef4444', flipped: false };
export const BUTTON = { id: 'btn_1', type: 'button', x: 100, y: 600, rotation: 0 };
// Physical pin numbers: GP0 = 1, GP15 = 20, GND.1 = 3, 3V3(OUT) = 36.
export const LED_ON_GP15 = [wire(gpio(20), cp('led_1', 'A')), wire(gpio(3), cp('led_1', 'C'))];

export function makeProject({ code, language = 'python', components = [], connections = [] }) {
  return { version: 1, language, code, board: 'pico_w', components, connections };
}

/** Same encoding as src/project/project-store.js#encodeProject (JSON -> encodeURIComponent -> base64). */
export function shareUrl(project) {
  const b64 = Buffer.from(encodeURIComponent(JSON.stringify(project))).toString('base64');
  return '/?p=' + encodeURIComponent(b64);
}

export async function openProject(page, project) {
  await page.goto(shareUrl(project), { waitUntil: 'load' });
  // The board SVG is fetched asynchronously and the project is restored after it loads.
  await page.waitForFunction(() => document.querySelectorAll('#board-container [data-is-port]').length > 0);
  await page.waitForTimeout(300);
}

export const consoleLines = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#output > div')].map((d) => d.innerText.replace(/\s+/g, ' ').trim()));

/** Console lines without the [hh:mm:ss] prefix that serial-monitor adds. */
export async function programOutput(page) {
  return (await consoleLines(page)).map((l) => l.replace(/^\[\d\d:\d\d:\d\d\]\s*/, ''));
}

export const ledIsOn = (page, id = 'led_1') =>
  page.evaluate((i) => { const s = document.querySelector('#' + i + ' svg'); return !!(s && s.style.filter); }, id);

/** True when the compile service is running AND has a working Emscripten. C tests skip (not fail) when it is not. */
export async function compilerReady() {
  try { return (await (await fetch('http://127.0.0.1:3001/health')).json()).compiler === 'available'; } catch { return false; }
}

/** Click a part the way the app sees it (mousedown + mouseup) and let the circuit settle. */
export const press = async (page, id) => {
  await page.dispatchEvent('#' + id, 'mousedown');
  await page.dispatchEvent('#' + id, 'mouseup');
  await page.waitForTimeout(200);
};

/** Record when (wall clock, in the page) each console line appears; read the result with timed(). */
export async function watchLines(page) {
  await page.evaluate(() => {
    window.__lineTimes = [];
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) window.__lineTimes.push({ t: performance.now(), text: (n.innerText || '').replace(/\s+/g, ' ').trim().replace(/^\[\d\d:\d\d:\d\d\]\s*/, '') });
    }).observe(document.getElementById('output'), { childList: true });
  });
}
export const timed = (page) => page.evaluate(() => window.__lineTimes);
