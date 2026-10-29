import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, api, httpBase, ApiError } from '../../net-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MOCK = path.join(ROOT, 'tools/mock-server.mjs');
const CHROME = '/home/bluongo/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(20); }
  throw new Error('timeout waiting for ' + what);
}
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    s.on('error', rej);
  });
}
function startMock(port) {
  const child = spawn(process.execPath, [MOCK], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = new Promise((res, rej) => {
    child.once('error', rej);
    child.once('exit', (c) => rej(new Error('mock exited ' + c)));
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); });
  });
  const stop = () => new Promise((res) => { if (child.exitCode !== null) return res(); child.once('exit', res); child.kill('SIGTERM'); });
  return ready.then(() => ({ child, stop }));
}

test('hello, snaps, interpolation, sendCmd, REST, reconnect', async (t) => {
  const port = await freePort();
  let mock = await startMock(port);
  t.after(() => mock.stop());
  const url = `ws://127.0.0.1:${port}/live`;

  const statuses = [];
  const hellos = [];
  const logs = [];
  const net1 = connect(url, { onStatus: (s) => statuses.push(s), onHello: (h) => hellos.push(h), onLog: (l) => logs.push(l) });
  t.after(() => net1.close());

  // independent raw socket to capture the exact snaps the server sent
  const raw = [];
  const rws = new WebSocket(url);
  rws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'snap') raw.push(m); };
  t.after(() => rws.close());

  await t.test('hello', async () => {
    await until(() => hellos.length, 5000, 'hello');
    assert.equal(net1.status, 'open');
    assert.equal(net1.lastHello.type, 'hello');
    assert.equal(net1.lastHello.snapHz, 10);
    assert.ok(Array.isArray(net1.lastHello.obstacles));
    assert.equal(statuses[0], 'open'); // initial 'connecting' is the starting value, no event
  });

  await t.test('>= 5 snaps at ~10 Hz and sample() interpolates', async () => {
    await until(() => net1.snapCount >= 5 && raw.length >= 5, 5000, '5 snaps');
    const n = raw.length;
    const a = raw[n - 3], b = raw[n - 2];
    assert.ok(b.t > a.t && b.t - a.t < 0.25, `snap spacing ${b.t - a.t}`);
    await until(() => net1.latest.t >= b.t, 2000, 'client has snaps');
    const mid = (a.t + b.t) / 2;
    const s = net1.sampleAt(mid);
    assert.ok(Math.abs(s.t - mid) < 1e-9);
    assert.equal(s.drones.size, 20);
    const ia = new Map(a.drones.map((r) => [r[0], r])), ib = new Map(b.drones.map((r) => [r[0], r]));
    let strict = 0;
    for (const [id, d] of s.drones) {
      const ra = ia.get(id), rb = ib.get(id);
      for (const [key, idx] of [['x', 2], ['y', 3], ['z', 4]]) {
        const lo = Math.min(ra[idx], rb[idx]), hi = Math.max(ra[idx], rb[idx]);
        if (hi - lo < 1e-6) continue;
        assert.ok(d[key] > lo && d[key] < hi, `${id}.${key}=${d[key]} not in (${lo},${hi})`);
        assert.ok(Math.abs(d[key] - (ra[idx] + rb[idx]) / 2) < 1e-6, 'midpoint');
        strict++;
      }
      assert.equal(d.swarm, 'A');
      assert.equal(typeof d.battery, 'number');
      assert.equal(typeof d.state, 'string');
    }
    assert.ok(strict > 20, 'enough moving components checked: ' + strict);
    assert.ok(s.swarms.A && s.swarms.A.mode);
    // sample() (client clock) lags the newest snap by about RENDER_LAG and is non-null
    const live = net1.sample();
    assert.ok(live && live.drones.size === 20);
    const lag = net1.latest.t - live.t;
    assert.ok(lag > 0.0 && lag < 0.4, `render lag ${lag}`);
    // no extrapolation beyond 0.1 s
    const far = net1.sampleAt(net1.latest.t + 5);
    assert.ok(far.t <= net1.latest.t + 0.1 + 1e-9);
    // drone only in one snap is taken as-is
    assert.ok(net1.serverTime() > 0);
  });

  await t.test('sendCmd round trip', async () => {
    const ok = await net1.sendCmd('mode', ['ORBIT']);
    assert.deepEqual(ok, { ok: true, msg: 'mode=ORBIT' });
    const bad = await net1.sendCmd('mode', ['NOPE']);
    assert.equal(bad.ok, false);
    const unk = await net1.sendCmd('frobnicate', []);
    assert.equal(unk.ok, false);
    const [r1, r2] = await Promise.all([net1.sendCmd('drones', [25]), net1.sendCmd('drones', [20])]);
    assert.equal(r1.msg, 'drones=25');
    assert.equal(r2.msg, 'drones=20');
  });

  await t.test('log events delivered', async () => {
    await until(() => logs.length, 6000, 'log event');
    assert.equal(logs[0].type, 'log');
  });

  await t.test('REST helpers', async () => {
    assert.equal(httpBase(url), `http://127.0.0.1:${port}`);
    assert.equal(httpBase('wss://example.org:8443/live'), 'https://example.org:8443');
    const rest = api(httpBase(url));
    const h = await rest.health();
    assert.equal(h.ok, true);
    const demo = await rest.demoMission();
    assert.equal(demo.status, 'PLANNED');
    await rest.startMission(demo.id);
    await rest.abortMission(demo.id);
    const list = await rest.missions();
    assert.ok(list.some((m) => m.id === demo.id && m.status === 'ABORTED'));
    await assert.rejects(rest.createMission({ siteId: 'valencia', swarm: 'A', name: 'x', waypoints: [] }), (e) => e instanceof ApiError && e.status === 422 && Array.isArray(e.body.conflicts));
    const w = await rest.siteWorld('valencia');
    assert.ok(Array.isArray(w.obstacles));
    assert.equal((await rest.site('valencia')).id, 'valencia');
  });

  await t.test('reconnect after mock restart', async () => {
    const helloCount = hellos.length;
    await mock.stop();
    await until(() => net1.status === 'closed', 5000, 'status closed');
    assert.equal((await net1.sendCmd('mode', ['PATROL'])).ok, false); // not connected -> resolves, no hang
    mock = await startMock(port);
    await until(() => net1.status === 'open' && hellos.length > helloCount, 10000, 'reconnect');
    await until(() => net1.snapCount >= 3, 5000, 'snaps after reconnect');
    const s = net1.sample();
    assert.ok(s && s.drones.size > 0);
    assert.ok(net1.latest.t < 30, 'server clock restarted and client resynced');
    assert.deepEqual((await net1.sendCmd('mode', ['SCAN'])), { ok: true, msg: 'mode=SCAN' });
  });

  await t.test('close() stops reconnect', async () => {
    const c = connect(url, {});
    await until(() => c.status === 'open', 5000, 'open');
    c.close();
    assert.equal(c.status, 'closed');
    await mock.stop();
    await sleep(1500);
    assert.equal(c.status, 'closed');
  });
});

test('connect to nothing: status cycles, backoff retries, no throw', async () => {
  const port = await freePort();
  const st = [];
  const c = connect(`ws://127.0.0.1:${port}/live`, { onStatus: (s) => st.push(s) });
  await sleep(1800); // attempts at ~0, 0.5, 1.5 s
  c.close();
  assert.equal(c.status, 'closed');
  assert.ok(st.filter((s) => s === 'connecting').length >= 2, JSON.stringify(st));
  assert.equal(c.sample(), null);
  assert.deepEqual(await c.sendCmd('x'), { ok: false, msg: 'not connected' });
});

test('net-client.js is browser-valid (Playwright, served on 8704)', { skip: !existsSync(CHROME) && 'chromium not found', timeout: 60000 }, async (t) => {
  const { chromium } = await import('playwright');
  const port = await freePort();
  const mock = await startMock(port);
  t.after(() => mock.stop());
  const web = spawn('python3', ['-m', 'http.server', '8704', '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  t.after(() => web.kill('SIGTERM'));
  await until(async () => { try { return (await fetch('http://127.0.0.1:8704/net-client.js')).ok; } catch { return false; } }, 5000, 'static server');

  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:8704/net-client.js'); // same origin; any page works for dynamic import
  const out = await page.evaluate(async (wsUrl) => {
    const m = await import('/net-client.js');
    const hellos = [];
    const c = m.connect(wsUrl, { onHello: (h) => hellos.push(h) });
    const t0 = performance.now();
    while ((c.status !== 'open' || c.snapCount < 4) && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
    const s = c.sample();
    const cmd = await c.sendCmd('mode', ['ORBIT']);
    const health = await m.api(m.httpBase(wsUrl)).health();
    c.close();
    const first = s ? [...s.drones.entries()][0] : null;
    return { exports: Object.keys(m).sort(), status: c.status, hello: hellos.length, snapCount: c.snapCount, sampleT: s && s.t, size: s && s.drones.size, first, cmd, health };
  }, `ws://127.0.0.1:${port}/live`);
  console.log('browser result:', JSON.stringify(out));
  assert.deepEqual(errors, []);
  assert.equal(out.hello, 1);
  assert.ok(out.snapCount >= 4);
  assert.equal(out.size, 20);
  assert.ok(typeof out.first[1].x === 'number' && out.first[1].swarm === 'A');
  assert.deepEqual(out.cmd, { ok: true, msg: 'mode=ORBIT' });
  assert.equal(out.health.ok, true);
});
