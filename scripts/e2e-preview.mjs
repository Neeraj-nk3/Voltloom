// Runs the browser tests against the production build (`npm run build` first), served by `vite preview` on port 4173.
// Extra arguments go to Playwright:  npm run test:e2e:preview -- tests/e2e/python.spec.js
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2).map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
const result = spawnSync(`npx playwright test ${args}`, { shell: true, stdio: 'inherit', env: { ...process.env, VOLTLOOM_PREVIEW: '1' } });
process.exit(result.status ?? 1);
