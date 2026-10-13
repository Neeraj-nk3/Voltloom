import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../../../compiler/server.js';
import { CompileError } from '../../../compiler/lib/compile.js';
import { createJobQueue } from '../../../compiler/lib/job-queue.js';

const ORIGIN = 'http://localhost:5173';

function start(options) {
  return new Promise((resolve) => {
    const server = createApp({ emcc: null, ...options }).listen(0, '127.0.0.1', () => resolve(server));
  });
}
const urlOf = (server, p) => `http://127.0.0.1:${server.address().port}${p}`;
const post = (server, body, headers = {}) => fetch(urlOf(server, '/compile'), {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

/** fetch cannot override Host; use raw http for the DNS-rebinding case. */
function rawRequest(server, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/health', headers }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
}

describe('compile service HTTP surface', () => {
  let server;
  let behaviour = () => Promise.resolve({ js: 'JS' });
  beforeAll(async () => { server = await start({ compile: (code) => behaviour(code) }); });
  afterAll(() => new Promise((r) => server.close(r)));

  it('serves health without a compiler dependency', async () => {
    const body = await (await fetch(urlOf(server, '/health'))).json();
    expect(body).toMatchObject({ status: 'ok', service: 'voltloom-compiler', compiler: 'missing' });
  });

  it('returns the compile result in the documented shape', async () => {
    behaviour = () => Promise.resolve({ js: 'MODULE' });
    const res = await post(server, { code: 'int main(){}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ js: 'MODULE', size: { js: 6 } });
  });

  it('refuses a foreign Origin and a foreign Host, allows the app origin', async () => {
    expect((await post(server, { code: 'x' }, { Origin: 'http://evil.example' })).status).toBe(403);
    expect(await rawRequest(server, { Host: 'evil.example' })).toBe(403);
    const ok = await post(server, { code: 'x' }, { Origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('does not answer a preflight for a foreign origin', async () => {
    const res = await fetch(urlOf(server, '/compile'), {
      method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('validates the request', async () => {
    expect((await fetch(urlOf(server, '/compile'), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status).toBe(415);
    expect((await post(server, {})).status).toBe(400);
    expect((await post(server, { code: 123 })).status).toBe(400);
    expect((await post(server, '{not json')).status).toBe(400);
    expect((await post(server, { code: 'x'.repeat(400_000) })).status).toBe(413);
  });

  it('maps compiler outcomes to status codes without leaking internals', async () => {
    behaviour = () => Promise.reject(new CompileError('build', 'user_main.c:1: error: boom'));
    let res = await post(server, { code: 'x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ error: 'user_main.c:1: error: boom' });

    behaviour = () => Promise.reject(new CompileError('rejected', 'include not allowed'));
    expect((await post(server, { code: 'x' })).status).toBe(422);
    behaviour = () => Promise.reject(new CompileError('timeout', 'too slow'));
    expect((await post(server, { code: 'x' })).status).toBe(504);
    behaviour = () => Promise.reject(new CompileError('unavailable', 'no compiler'));
    expect((await post(server, { code: 'x' })).status).toBe(503);

    behaviour = () => Promise.reject(new Error('C:\\Users\\secret\\path exploded'));
    res = await post(server, { code: 'x' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });
});

describe('queueing under load', () => {
  it('runs one build at a time and refuses requests when the waiting line is full', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let active = 0; let peak = 0;
    const server = await start({
      queue: createJobQueue({ concurrency: 1, maxWaiting: 1 }),
      compile: async () => { active++; peak = Math.max(peak, active); await gate; active--; return { js: 'OK' }; },
    });
    try {
      const first = post(server, { code: 'a' });      // running
      await new Promise((r) => setTimeout(r, 50));
      const second = post(server, { code: 'b' });     // waiting
      await new Promise((r) => setTimeout(r, 50));
      const third = await post(server, { code: 'c' }); // line is full
      expect(third.status).toBe(503);
      release();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect(peak).toBe(1);
    } finally {
      release();
      await new Promise((r) => server.close(r));
    }
  });
});
