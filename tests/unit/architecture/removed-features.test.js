import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// HTTP and MQTT were removed (R6): they were never connected to a program, could not work under the page's CSP,
// and the MQTT library was three quarters of the app's JavaScript. This keeps them from creeping back in unnoticed.

const read = (p) => fs.readFileSync(p, 'utf8');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));

describe('HTTP and MQTT stay removed', () => {
  it('their source files are gone', () => {
    for (const f of ['src/sim/http_sim.js', 'src/sim/http_bridge.js', 'src/sim/mqtt_sim.js', 'src/sim/mqtt_bridge.js',
      'compiler/sdk/src/http_client.c', 'compiler/sdk/src/mqtt_client.c', 'compiler/sdk/include/net']) {
      expect(fs.existsSync(f), f).toBe(false);
    }
  });

  it('the mqtt dependency is not declared or locked, and nothing in the app imports it', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('mqtt');
    expect(read('package-lock.json')).not.toMatch(/"node_modules\/mqtt"/);
    const imports = walk('src').filter((f) => f.endsWith('.js')).filter((f) => /from\s+['"]mqtt['"]|require\(['"]mqtt['"]\)/.test(read(f)));
    expect(imports).toEqual([]);
  });

  it('the C JavaScript library has no HTTP or MQTT entries, and the SDK has no net headers', () => {
    const library = read('compiler/sdk/src/js-library.js');
    expect(library).not.toMatch(/js_http_|js_mqtt_|__async/);
    expect(fs.readdirSync('compiler/sdk/include')).not.toContain('net');
  });

  it('the simulator bridge no longer resets them', () => {
    expect(read('src/bridge/simulator-bridge.js')).not.toMatch(/resetHttp|resetMqtt/);
  });
});
