// WP3 server skeleton tests (node:test). Run: node --test server/test/
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { buildServer } from '../src/index.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { createDb } from '../src/db.ts';
import { parseFix } from '../src/ingest.ts';
import * as core from '../../sim-core.js';

try { process.loadEnvFile(new URL('../../.env', import.meta.url)); } catch { /* no .env: DB tests are skipped */ }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const hasSim = !!(core as any).SimWorld;
const closers: Array<() => Promise<void>> = [];
after(async () => { for (const c of closers.reverse()) await c().catch(() => {}); });

const track = <T extends { close(): Promise<void> } | null>(db: T): T => { if (db) closers.push(() => db.close()); return db; };

async function start(over: Partial<Config> = {}, opts: { forceFake?: boolean; db?: any } = {}) {
  const cfg = loadConfig({}, { port: 0, host: '127.0.0.1', logLevel: 'silent', drones: 8, persistHz: 0, ...over });
  const { app, ctx } = await buildServer(cfg, { forceFake: true, db: null, ...opts });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as any).port as number;
  closers.push(() => app.close());
  return { app, ctx, port, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}

interface Client { ws: WebSocket; msgs: Array<{ at: number; m: any }>; wait(pred: (m: any) => boolean, ms?: number): Promise<any>; close(): void }
function connect(url: string, headers?: Record<string, string>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const msgs: Client['msgs'] = [];
    const waiters: Array<() => void> = [];
    ws.on('message', d => { msgs.push({ at: performance.now(), m: JSON.parse(d.toString()) }); waiters.forEach(w => w()); });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on('open', () => resolve({
      ws, msgs,
      wait: (pred, ms = 3000) => new Promise((res, rej) => {
        const check = () => { const f = msgs.find(x => pred(x.m)); if (f) { clear(); res(f.m); } };
        const t = setTimeout(() => { clear(); rej(new Error('timeout waiting for message')); }, ms);
        const clear = () => { clearTimeout(t); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1); };
        waiters.push(check); check();
      }),
      close: () => ws.close(),
    }));
  });
}
const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('GET /api/health shape', async () => {
  const s = await start();
  await sleep(300);
  const h: any = await (await fetch(`${s.http}/api/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(typeof h.db, 'boolean');
  assert.ok(h.tickMs.p95 >= 0 && h.tickMs.p50 >= 0);
  assert.equal(h.drones, 8);
  assert.deepEqual(Object.keys(h.telemetry).sort(), ['dropped', 'queued', 'written']);
  assert.equal(h.clients, 0);
});

test('WS /live: hello, then >= 5 snaps within 1 s at ~10 Hz', async () => {
  const s = await start();
  const c = await connect(`${s.ws}/live`);
  const hello = await c.wait(m => m.type === 'hello');
  assert.equal(hello.tickHz, 30); assert.equal(hello.snapHz, 10);
  assert.equal(hello.seed, loadConfig({}).seed);
  assert.ok(hello.site.id && Array.isArray(hello.site.origin));
  assert.equal(hello.site.short, 'Ciutat'); assert.equal(hello.site.shapesGlobal, 'CAC');
  assert.ok(Array.isArray(hello.obstacles) && Array.isArray(hello.landmarks));
  assert.ok(hello.landmarks.every((l: any) => !('mesh' in l)));
  const t0 = c.msgs.find(x => x.m.type === 'hello')!.at;
  await sleep(2100);
  const snaps = c.msgs.filter(x => x.m.type === 'snap');
  const within1s = snaps.filter(x => x.at - t0 <= 1000).length;
  assert.ok(within1s >= 5, `only ${within1s} snaps in the first second`);
  const span = (snaps.at(-1)!.at - snaps[0].at) / 1000, rate = (snaps.length - 1) / span;
  assert.ok(rate > 8 && rate < 12, `snap rate ${rate.toFixed(2)} Hz`);
  const m = snaps[0].m;
  assert.equal(m.drones.length, 8);
  assert.equal(m.drones[0].length, 14);
  assert.ok(m.swarms.A && Array.isArray(m.ext) && 'mission' in m);
  assert.ok(snaps.at(-1)!.m.seq > snaps[0].m.seq);
  c.close();
});

test('POST /ingest shows up in the next snap ext; validation rejects bad fixes', async () => {
  const s = await start();
  const c = await connect(`${s.ws}/live`);
  await c.wait(m => m.type === 'hello');
  const r = await postJson(`${s.http}/ingest`, { droneId: 'EXT-1', lat: 39.45472, lon: -0.3525, alt_m: 50, vx: 3, vz: -4, battery: 80, state: 'ACTIVE' });
  assert.equal(r.status, 202);
  const snap = await c.wait(m => m.type === 'snap' && m.ext.some((e: any) => e[0] === 'EXT-1'));
  const e = snap.ext.find((x: any) => x[0] === 'EXT-1');
  // [id, x, y, z, heading, battery, state]; origin lat/lon -> site metres (0,0); base (180,240) m -> scene (-90, +120)
  assert.ok(Math.abs(e[1] - -90) < 0.1 && Math.abs(e[3] - 120) < 0.1, `scene xz ${e[1]},${e[3]}`);
  assert.equal(e[2], 25);                       // 50 m * SC 0.5
  assert.ok(Math.abs(e[4] - 36.87) < 0.1);      // atan2(3, 4) deg, velocity-derived heading
  assert.equal(e[5], 80); assert.equal(e[6], 'ACTIVE');
  // batch with one bad entry: 202, bad one reported
  const b: any = await (await postJson(`${s.http}/ingest`, [{ droneId: 'EXT-2', lat: 39.4, lon: -0.35, alt_m: 10 }, { droneId: 'bad id!', lat: 0, lon: 0, alt_m: 0 }])).json();
  assert.equal(b.accepted, 1); assert.equal(b.rejected[0].index, 1);
  assert.equal((await postJson(`${s.http}/ingest`, { droneId: 'X', lat: 91, lon: 0, alt_m: 0 })).status, 400);
  assert.equal((await postJson(`${s.http}/ingest`, { droneId: 'UAV-01', lat: 1, lon: 1, alt_m: 0 })).status, 400);
  assert.equal(s.ctx.ext.size, 2);
  c.close();
});

test('WS /ingest accepts fixes and acks', async () => {
  const s = await start();
  const live = await connect(`${s.ws}/live`);
  const ing = await connect(`${s.ws}/ingest`);
  ing.ws.send(JSON.stringify({ droneId: 'WS-1', lat: 39.455, lon: -0.35, alt_m: 30, heading: 90 }));
  const ack = await ing.wait(m => m.type === 'ack');
  assert.equal(ack.accepted, 1);
  await live.wait(m => m.type === 'snap' && m.ext.some((e: any) => e[0] === 'WS-1'));
  ing.ws.send('not json');
  assert.equal((await ing.wait(m => m.type === 'ack' && m.accepted === 0)).rejected[0].error, 'invalid JSON');
  live.close(); ing.close();
});

test('ext drones expire after the TTL', async () => {
  const s = await start({ extTtlMs: 300 });
  await postJson(`${s.http}/ingest`, { droneId: 'OLD-1', lat: 39.455, lon: -0.35, alt_m: 30 });
  assert.equal(s.ctx.ext.list(Date.now()).length, 1);
  await sleep(450);
  assert.equal(s.ctx.ext.list(Date.now()).length, 0);
});

test('cmd round trip and validation', async () => {
  const s = await start();
  const c = await connect(`${s.ws}/live`);
  await c.wait(m => m.type === 'hello');
  c.ws.send(JSON.stringify({ type: 'cmd', name: 'mode', args: ['scan'] }));
  const ok = await c.wait(m => m.type === 'cmdResult');
  assert.equal(ok.ok, true);
  const snap = await c.wait(m => m.type === 'snap' && m.swarms.A.mode === 'SCAN');
  assert.equal(snap.swarms.A.mode, 'SCAN');
  await c.wait(m => m.type === 'log');                        // log event is broadcast too
  const n0 = c.msgs.filter(x => x.m.type === 'cmdResult').length;
  c.ws.send(JSON.stringify({ type: 'cmd', name: 'rm -rf', args: [] }));
  c.ws.send(JSON.stringify({ type: 'cmd', name: 'mode', args: [{ a: 1 }] }));
  c.ws.send('{oops');
  await c.wait(() => c.msgs.filter(x => x.m.type === 'cmdResult').length >= n0 + 3);
  const res = c.msgs.filter(x => x.m.type === 'cmdResult').slice(n0).map(x => x.m.ok);
  assert.deepEqual(res, [false, false, false]);
  c.close();
});

test('oversized client message closes the connection', async () => {
  const s = await start();
  const c = await connect(`${s.ws}/live`);
  await c.wait(m => m.type === 'hello');
  const closed = new Promise<number>(r => c.ws.on('close', code => r(code)));
  c.ws.send(JSON.stringify({ type: 'cmd', name: 'mode', args: ['x'.repeat(5000)] }));
  assert.equal(await closed, 1009);
});

test('origin and CORS policy', async () => {
  const s = await start();
  await assert.rejects(connect(`${s.ws}/live`, { Origin: 'https://evil.example' }), (e: any) => e.status === 403);
  const okc = await connect(`${s.ws}/live`, { Origin: 'http://localhost:8000' }); okc.close();
  const g = await fetch(`${s.http}/api/health`, { headers: { Origin: 'https://anything.example' } });
  assert.equal(g.headers.get('access-control-allow-origin'), '*');
  const bad = await postJson(`${s.http}/ingest`, { droneId: 'E', lat: 1, lon: 1, alt_m: 1 }, { Origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
  const pre = await fetch(`${s.http}/ingest`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:8000', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
});

test('site REST: CITY json, cac.js, world', async () => {
  const s = await start();
  const city: any = await (await fetch(`${s.http}/api/sites/${s.ctx.site.id}`)).json();
  for (const k of ['origin', 'base', 'theta', 'cell', 'n', 'h', 'c', 'cover']) assert.ok(k in city, `CITY.${k}`);
  assert.equal(city.n, 550);
  const cac = await fetch(`${s.http}/api/sites/${s.ctx.site.id}/cac.js`);
  assert.equal(cac.status, 200);
  assert.match(cac.headers.get('content-type') ?? '', /^application\/javascript/);
  assert.match(await cac.text(), /CAC/);
  const w: any = await (await fetch(`${s.http}/api/sites/${s.ctx.site.id}/world`)).json();
  assert.ok(Array.isArray(w.landmarks) && Array.isArray(w.obstacles));
  assert.equal(w.nfz.type, 'FeatureCollection');
  assert.ok(w.nfz.features.length >= 1);
  assert.equal((await fetch(`${s.http}/api/sites/nope`)).status, 404);
});

test('parseFix validation table', () => {
  const ok = { droneId: 'a_B-1', lat: 1, lon: 2, alt_m: 3 };
  assert.equal(parseFix(ok, Date.now()).ok, true);
  for (const bad of [null, [], { ...ok, droneId: 'x'.repeat(33) }, { ...ok, droneId: 'a b' }, { ...ok, lat: NaN }, { ...ok, lon: 181 }, { ...ok, alt_m: 1e6 },
    { ...ok, vx: 5000 }, { ...ok, battery: 101 }, { ...ok, state: 'x'.repeat(40) }, { ...ok, ts: 'garbage' }, { ...ok, heading: 'north' }]) {
    assert.equal(parseFix(bad, Date.now()).ok, false, JSON.stringify(bad));
  }
  const t = parseFix({ ...ok, ts: 1_700_000_000 }, 1_700_000_000_000);       // seconds are accepted
  assert.ok(t.ok && t.fix.ts === 1_700_000_000_000);
});

test('real SimWorld (if present): 150 drones, snap < 20 KB, tick p95 < 5 ms', { skip: hasSim ? false : 'sim-core.js has no SimWorld yet' }, async () => {
  const s = await start({ drones: 150, timeScale: 1 }, { forceFake: false });
  const c = await connect(`${s.ws}/live`);
  const hello = await c.wait(m => m.type === 'hello');
  assert.equal(hello.worldKind, 'sim');
  await sleep(1500);
  const h: any = await (await fetch(`${s.http}/api/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.drones, 150);
  assert.ok(h.snap.bytes > 0 && h.snap.bytes < 20_000, `snap bytes ${h.snap.bytes}`);
  assert.ok(h.tickMs.p95 < 5, `tick p95 ${h.tickMs.p95} ms`);
  assert.ok(c.msgs.filter(x => x.m.type === 'snap').length >= 10);
  c.close();
});

test('WORLD_TIME_SCALE speeds up the world clock', async () => {
  const s = await start({ timeScale: 10 });
  await sleep(1000);
  assert.ok(s.ctx.world.T > 5, `world T ${s.ctx.world.T} after 1 s at scale 10`);
});

// ---- DB-backed checks: only when the docker DB is up and the schema is loaded ----
const dbUrl = process.env.DATABASE_URL;
const probe = dbUrl ? createDb(dbUrl) : null;
let dbReady = false;
if (probe) {
  try { await probe.query('SELECT 1 FROM telemetry LIMIT 0'); await probe.query('SELECT 1 FROM drones LIMIT 0'); dbReady = true; } catch { dbReady = false; }
}
after(async () => { await probe?.close(); });

test('telemetry rows reach the DB (sim + ext), health reports db:true', { skip: dbReady ? false : 'DB not up / schema missing' }, async () => {
  const SITE = 'test-wp3';
  const db = track(createDb(dbUrl))!;
  await db.ping();
  const clean = async () => {
    await db.query('DELETE FROM telemetry WHERE site_id = $1', [SITE]);
    await db.query('DELETE FROM drones WHERE site_id = $1', [SITE]);
  };
  await clean();
  try {
    const s = await start({ siteId: SITE, persistHz: 5, drones: 4 }, { db });
    await postJson(`${s.http}/ingest`, { droneId: 'REAL-T1', lat: 39.455, lon: -0.35, alt_m: 30, vx: 1, vz: -1, battery: 70, state: 'ACTIVE' });
    await sleep(3500);
    const h: any = await (await fetch(`${s.http}/api/health`)).json();
    assert.equal(h.db, true);
    assert.ok(h.telemetry.written > 0, `written ${h.telemetry.written}`);
    const recent = await db.query(`SELECT count(*)::int AS n FROM telemetry WHERE ts > now() - interval '1 minute' AND site_id = $1`, [SITE]);
    assert.ok(recent.rows[0].n > 4, `rows in last minute: ${recent.rows[0].n}`);
    const real = await db.query(`SELECT drone_id, lat, lon, alt_m, battery, state FROM telemetry WHERE site_id = $1 AND drone_id = 'REAL-T1'`, [SITE]);
    assert.equal(real.rows.length, 1);
    assert.ok(Math.abs(real.rows[0].lat - 39.455) < 1e-9 && real.rows[0].state === 'ACTIVE');
    const kinds = await db.query(`SELECT id, kind FROM drones WHERE site_id = $1 ORDER BY id`, [SITE]);
    assert.equal(kinds.rows.find((r: any) => r.id === 'REAL-T1')?.kind, 'real');
    assert.ok(kinds.rows.some((r: any) => r.kind === 'sim'));
    await s.app.close();
    // graceful close flushed everything: nothing left queued
    assert.equal(s.ctx.telemetry.stats().queued, 0);
  } finally {
    await clean();
  }
});

test('site is loaded from the DB when rows exist', { skip: dbReady ? false : 'DB not up / schema missing' }, async () => {
  const has = await probe!.query(`SELECT 1 FROM sites WHERE id = 'cac'`).catch(() => ({ rows: [] }));
  if (!has.rows.length) return;      // WP1 loader not run: nothing to assert
  const s = await start({ siteId: 'cac' }, { db: track(createDb(dbUrl)) });
  assert.equal(s.ctx.site.sources.city, 'db');
  const h: any = await (await fetch(`${s.http}/api/health`)).json();
  assert.equal(h.db, true);
});

test('site levante: SITE_ID=levante serves hello.site, 8 landmarks, NFZ-A ESTADI, BRAVO base from the registry', { skip: dbReady ? false : 'DB not up / schema missing' }, async () => {
  const has = await probe!.query(`SELECT 1 FROM sites WHERE id = 'levante'`);
  assert.equal(has.rows.length, 1, 'site levante not in the DB: run node tools/export-site.mjs --site levante && npm run db:load');
  const s = await start({ siteId: 'levante', drones: 10 }, { db: track(createDb(dbUrl)), forceFake: false });
  assert.equal(s.ctx.site.sources.city, 'db'); assert.equal(s.ctx.site.sources.landmarks, 'db');
  assert.equal(s.ctx.site.reg.short, 'Levante');
  assert.deepEqual(s.ctx.site.landmarks.map(l => l.code).sort(), ['ARE', 'CMP', 'EST', 'MET', 'OFI', 'PAR', 'PRC', 'TOR']);
  const w: any = s.ctx.world;
  assert.equal(w.baseB.x, -107); assert.equal(w.baseB.z, -126);
  const nfz = w.obstacles.find((o: any) => o.name === 'NFZ-A');
  assert.match(nfz.label, /^ESTADI/); assert.equal(nfz.r, 56); assert.equal(nfz.h, 110);

  const c = await connect(`${s.ws}/live`);
  const hello = await c.wait(m => m.type === 'hello');
  assert.equal(hello.site.id, 'levante');
  assert.equal(hello.site.short, 'Levante'); assert.equal(hello.site.shapesGlobal, 'LEV');
  assert.equal(hello.landmarks.length, 8);
  assert.ok(hello.obstacles.some((o: any) => o.name === 'NFZ-A' && /^ESTADI/.test(o.label)));
  c.close();

  const list: any = await (await fetch(`${s.http}/api/sites`)).json();
  const lev = list.sites.find((x: any) => x.id === 'levante'), cac = list.sites.find((x: any) => x.id === 'cac');
  assert.deepEqual([lev.loaded, lev.active, cac.loaded, cac.active], [true, true, true, false]);
  assert.equal(lev.name, 'Estadi Ciutat de València · Orriols');
  const a = await (await fetch(`${s.http}/api/sites/levante/shapes.js`)).text();
  const b = await (await fetch(`${s.http}/api/sites/levante/cac.js`)).text();
  assert.match(a, /window\.LEV\b/); assert.equal(a, b);
  // the other site is served from the DB too (cac.js of cac is the CAC script)
  assert.match(await (await fetch(`${s.http}/api/sites/cac/shapes.js`)).text(), /window\.CAC\b/);
});

test('static allowlist: sites.js and lev-shapes.js are served, server/ is not', async () => {
  const s = await start();
  for (const f of ['sites.js', 'lev-shapes.js', 'cac-shapes.js']) assert.equal((await fetch(`${s.http}/${f}`)).status, 200, f);
  assert.equal((await fetch(`${s.http}/server/src/site.ts`)).status, 404);
});

test('server keeps running when the DB is down (db:false, rows queued then bounded)', async () => {
  const dead = track(createDb('postgres://nobody:x@127.0.0.1:1/none'));
  const s = await start({ persistHz: 5, drones: 4, maxQueueRows: 20 }, { db: dead });
  await sleep(1500);
  const h: any = await (await fetch(`${s.http}/api/health`)).json();
  assert.equal(h.ok, true); assert.equal(h.db, false);
  assert.ok(h.telemetry.queued <= 20 && h.telemetry.dropped > 0 && h.telemetry.written === 0, JSON.stringify(h.telemetry));
});
