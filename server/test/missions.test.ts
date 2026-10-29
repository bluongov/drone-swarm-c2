// WP5 mission tests (node:test). Needs the DB up with the schema and site 'cac' loaded (npm run db:migrate && npm run db:load).
// Run: node --test server/test/missions.test.ts      (loads .env itself; skipped without DATABASE_URL)
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/index.ts';
import { loadConfig } from '../src/config.ts';
import { createDb } from '../src/db.ts';
import { terrainConflicts, parseBody } from '../src/missions.ts';

try { process.loadEnvFile(new URL('../../.env', import.meta.url)); } catch { /* no .env */ }

const DB_URL = process.env.DATABASE_URL;
const skip = DB_URL ? false : 'DATABASE_URL not set';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const created: string[] = [];                      // mission ids to delete afterwards
const closers: Array<() => Promise<void>> = [];
const servers: Array<() => Promise<void>> = [];     // closed after every test: only one world runs at a time
afterEach(async () => { for (const c of servers.splice(0)) await c().catch(() => {}); });
const cleanDb = skip ? null : createDb(DB_URL);
after(async () => {
  for (const c of closers.reverse()) await c().catch(() => {});
  if (cleanDb) {
    if (created.length) await cleanDb.query('DELETE FROM missions WHERE id = ANY($1::uuid[])', [created]).catch(() => {});
    await cleanDb.close();
  }
});

async function start(over: { forceFake?: boolean; scale?: number; drones?: number; siteId?: string } = {}) {
  const cfg = loadConfig({ DATABASE_URL: DB_URL }, { port: 0, host: '127.0.0.1', logLevel: 'silent', drones: over.drones ?? 20, persistHz: 0, timeScale: over.scale ?? 20, seed: 1, ...(over.siteId ? { siteId: over.siteId } : {}) });
  const { app, ctx } = await buildServer(cfg, { forceFake: over.forceFake });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const http = `http://127.0.0.1:${(app.server.address() as any).port}`;
  servers.push(() => app.close());
  const events: any[] = [];
  ctx.bus.on('mission', e => events.push(e));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(http + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const track = <R extends { body: any }>(r: R): R => { if (r.body?.id) created.push(r.body.id); return r; };
  const geo = (x: number, z: number, alt_m: number) => { const [lat, lon] = ctx.site.frames.sceneToGeo(x, z); return { lat, lon, alt_m }; };
  const waitStatus = async (id: string, want: string, ms = 90_000) => {
    const t0 = Date.now();
    for (;;) {
      const r = await call('GET', `/api/missions/${id}`);
      if (r.body.status === want) return r.body;
      if (['DONE', 'ABORTED', 'FAILED'].includes(r.body.status) && r.body.status !== want) assert.fail(`mission ended ${r.body.status}, wanted ${want}`);
      if (Date.now() - t0 > ms) assert.fail(`timeout waiting for ${want}, last ${r.body.status}`);
      await sleep(200);
    }
  };
  return { app, ctx, http, call, track, geo, events, waitStatus };
}

test('demo mission: create -> start -> RUNNING -> DONE', { skip }, async () => {
  const s = await start();
  const c = s.track(await s.call('POST', '/api/missions/demo'));
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.status, 'PLANNED');
  assert.ok(Array.isArray(c.body.warnings));
  assert.equal(c.body.waypoints.length, 5);
  const id = c.body.id as string;

  const d = (await s.call('GET', `/api/missions/${id}`)).body;
  assert.equal(d.status, 'PLANNED');
  assert.equal(d.waypoints.length, 5);
  assert.deepEqual(d.waypoints.map((w: any) => w.seq), [0, 1, 2, 3, 4]);
  assert.ok(d.waypoints.every((w: any) => w.alt_m >= 10 && w.alt_m <= 190));
  assert.equal(d.started_at, null);
  assert.ok((await s.call('GET', '/api/missions')).body.missions.some((m: any) => m.id === id && m.waypoint_count === 5));

  const st = await s.call('POST', `/api/missions/${id}/start`);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.status, 'RUNNING');
  assert.equal((await s.call('GET', `/api/missions/${id}`)).body.status, 'RUNNING');
  const snap = s.ctx.missionSnapshot();
  assert.ok(snap && snap.id === id && snap.status === 'RUNNING' && snap.total === 5, 'missionSnapshot while running');
  assert.equal(s.ctx.world.swarms.A.mode, 'MISSION');

  const done = await s.waitStatus(id, 'DONE');
  assert.ok(done.started_at && done.ended_at, 'started_at and ended_at are set');
  assert.equal(s.ctx.missionSnapshot(), null);
  assert.equal(s.ctx.world.swarms.A.mode, 'PATROL');
  const mine = s.events.filter(e => e.id === id);
  assert.equal(mine[0].status, 'RUNNING');
  assert.equal(mine.at(-1).status, 'DONE');
  const idx = mine.filter(e => e.status === 'RUNNING').map(e => e.wpIdx);
  assert.deepEqual(idx, [0, 1, 2, 3, 4], 'one RUNNING event per waypoint');
});

test('demo mission on site levante: planner avoids the stadium NFZ, runs to DONE', { skip }, async () => {
  const s = await start({ siteId: 'levante', scale: 40 });
  assert.equal(s.ctx.site.id, 'levante');
  const c = s.track(await s.call('POST', '/api/missions/demo'));
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.name, 'Demo loop Levante');
  assert.equal(c.body.status, 'PLANNED');
  const n = c.body.waypoints.length;
  assert.ok(n >= 3 && n <= 5, `waypoints ${n}`);
  const id = c.body.id as string;
  assert.equal((await s.call('GET', `/api/missions/${id}`)).body.site_id, 'levante');
  const st = await s.call('POST', `/api/missions/${id}/start`);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  await s.waitStatus(id, 'DONE');
  assert.equal(s.ctx.missionSnapshot(), null);
  assert.equal(s.ctx.world.swarms.A.mode, 'PATROL');
  // a route through the stadium NFZ is refused on this site
  const est = s.ctx.site.landmarks.find(l => l.nfz)!;
  assert.equal(est.code, 'EST');
  const r = await s.call('POST', '/api/missions', { siteId: 'levante', swarm: 'A', name: 'test-lev nfz', waypoints: [s.geo(est.x - 90, est.z, 60), s.geo(est.x, est.z, 60), s.geo(est.x + 90, est.z, 60)] });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.ok(r.body.conflicts.some((x: any) => x.type === 'NFZ'));
});

test('demo mission on cac is named Demo loop Ciutat', { skip }, async () => {
  const s = await start({ drones: 4 });
  const c = s.track(await s.call('POST', '/api/missions/demo'));
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.name, 'Demo loop Ciutat');
});

test('route through NFZ-A at 60 m -> 422 NFZ', { skip }, async () => {
  const s = await start({ drones: 4 });
  const hm = s.ctx.site.landmarks.find(l => l.nfz)!;
  const body = { siteId: 'cac', swarm: 'A', name: 'test-wp5 nfz', waypoints: [s.geo(hm.x - 90, hm.z, 60), s.geo(hm.x, hm.z, 60), s.geo(hm.x + 90, hm.z, 60)] };
  const r = await s.call('POST', '/api/missions', body);
  assert.equal(r.status, 422, JSON.stringify(r.body));
  const nfz = r.body.conflicts.filter((c: any) => c.type === 'NFZ');
  assert.ok(nfz.length >= 2, 'both legs cross the zone');
  assert.deepEqual(nfz.map((c: any) => c.leg).slice(0, 2), [0, 1]);
  assert.equal(nfz[0].detail.name, 'NFZ-A');
  assert.equal(nfz[0].detail.source, 'db');
  assert.equal(nfz[0].detail.ceiling_m, 220);
  const rows = (await cleanDb!.query(`SELECT count(*)::int AS n FROM missions WHERE name = 'test-wp5 nfz'`)).rows[0].n;
  assert.equal(rows, 0, 'nothing persisted');
});

test('route at low altitude through a building -> 422 TERRAIN', { skip }, async () => {
  const s = await start({ drones: 4 });
  const museu = s.ctx.site.landmarks.find(l => l.id === 'museu')!;
  const top = s.ctx.site.terrain.topAt(museu.x, museu.z);
  assert.ok(top > 10, `museu cell should be a building (top ${top} units)`);
  const wps = [s.geo(museu.x - 30, museu.z, 10), s.geo(museu.x + 30, museu.z, 10)];
  const r = await s.call('POST', '/api/missions', { siteId: 'cac', swarm: 'A', name: 'test-wp5 terrain', waypoints: wps });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  const t = r.body.conflicts.find((c: any) => c.type === 'TERRAIN');
  assert.ok(t, 'TERRAIN conflict');
  assert.equal(t.leg, 0);
  assert.ok(t.detail.needed_m >= top * 2 + 8 - 0.01, `needed_m ${t.detail.needed_m} covers the roof + 8 m`);
  assert.equal(typeof t.detail.x, 'number');
  assert.equal(typeof t.detail.z, 'number');
  // 5 m is below the allowed altitude range: body validation, not a route conflict
  const low = await s.call('POST', '/api/missions', { siteId: 'cac', swarm: 'A', name: 'test-wp5 low', waypoints: [s.geo(museu.x - 30, museu.z, 5), s.geo(museu.x + 30, museu.z, 5)] });
  assert.equal(low.status, 400);
  // the same leg at 150 m is accepted
  const ok = s.track(await s.call('POST', '/api/missions', { siteId: 'cac', swarm: 'A', name: 'test-wp5 high', waypoints: [s.geo(museu.x - 30, museu.z, 150), s.geo(museu.x + 30, museu.z, 150)] }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('terrainConflicts: 8 m clearance edge (pure)', () => {
  const terrain = { topNear: (x: number) => (x < 50 ? 20 : 0) };     // 20 units (40 m) wall for x < 50
  const at = (alt_m: number) => terrainConflicts({ terrain } as any, [{ x: 0, z: 0, alt_m }, { x: 100, z: 0, alt_m }]);
  assert.equal(at(47.9).length, 1);      // needs 48 m (40 m + 8 m)
  assert.equal(at(48.1).length, 0);
  assert.equal(at(47.9)[0].detail.needed_m, 48);
});

test('start twice -> 409, parallel starts, abort -> ABORTED', { skip }, async () => {
  const s = await start({ scale: 1 });                 // real time: the mission cannot finish during the test
  const a = s.track(await s.call('POST', '/api/missions/demo')).body.id as string;
  const b = s.track(await s.call('POST', '/api/missions/demo')).body.id as string;

  const [r1, r2] = await Promise.all([s.call('POST', `/api/missions/${a}/start`), s.call('POST', `/api/missions/${b}/start`)]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], 'exactly one parallel start wins');
  const [first, second] = r1.status === 200 ? [a, b] : [b, a];

  assert.equal((await s.call('POST', `/api/missions/${first}/start`)).status, 409, 'start twice');
  const other = await s.call('POST', `/api/missions/${second}/start`);
  assert.equal(other.status, 409);
  assert.match(other.body.error, /already has a RUNNING mission/);
  assert.equal(other.body.runningId, first);
  assert.equal((await s.call('GET', `/api/missions/${second}`)).body.status, 'PLANNED', 'rejected start leaves PLANNED');

  const ab = await s.call('POST', `/api/missions/${first}/abort`);
  assert.equal(ab.status, 200, JSON.stringify(ab.body));
  assert.equal(ab.body.status, 'ABORTED');
  const row = (await s.call('GET', `/api/missions/${first}`)).body;
  assert.equal(row.status, 'ABORTED');
  assert.ok(row.started_at && row.ended_at);
  assert.equal(s.ctx.missionSnapshot(), null);
  assert.equal(s.ctx.world.swarms.A.mode, 'PATROL', 'swarm back to PATROL');
  assert.equal(s.events.filter(e => e.id === first).at(-1).status, 'ABORTED');
  assert.equal((await s.call('POST', `/api/missions/${first}/abort`)).status, 409, 'abort when not running');
  assert.equal((await s.call('POST', `/api/missions/${first}/start`)).status, 409, 'an ABORTED mission cannot restart');
  assert.equal((await s.call('POST', `/api/missions/${second}/start`)).status, 200, 'swarm is free again');
  assert.equal((await s.call('POST', `/api/missions/${second}/abort`)).status, 200);
});

test('operator mode change aborts the running mission', { skip }, async () => {
  const s = await start({ scale: 1 });
  const id = s.track(await s.call('POST', '/api/missions/demo')).body.id as string;
  assert.equal((await s.call('POST', `/api/missions/${id}/start`)).status, 200);
  s.ctx.world.applyCommand({ name: 'mode', args: ['SCAN'] });
  await s.waitStatus(id, 'ABORTED', 5000);
  assert.equal(s.ctx.missionSnapshot(), null);
});

test('FakeWorld: same FSM (create -> start -> DONE)', { skip }, async () => {
  const s = await start({ forceFake: true, scale: 20, drones: 4 });
  const id = s.track(await s.call('POST', '/api/missions/demo')).body.id as string;
  assert.equal((await s.call('POST', `/api/missions/${id}/start`)).status, 200);
  await s.waitStatus(id, 'DONE');
});

test('request validation and lookups', { skip }, async () => {
  const s = await start({ drones: 4 });
  const wp = (alt = 60) => ({ lat: 39.457, lon: -0.355, alt_m: alt });
  const ok = { siteId: 'cac', swarm: 'A', name: 'x', waypoints: [wp(), { ...wp(), lat: 39.4575 }] };
  const bad: Array<[string, any]> = [
    ['no body', undefined],
    ['site missing', { ...ok, siteId: undefined }],
    ['swarm B', { ...ok, swarm: 'B' }],
    ['name empty', { ...ok, name: '  ' }],
    ['1 waypoint', { ...ok, waypoints: [wp()] }],
    ['21 waypoints', { ...ok, waypoints: Array.from({ length: 21 }, (_, i) => ({ ...wp(), lat: 39.457 + i * 1e-5 })) }],
    ['alt 9', { ...ok, waypoints: [wp(9), wp()] }],
    ['alt 191', { ...ok, waypoints: [wp(), wp(191)] }],
    ['lat string', { ...ok, waypoints: [{ ...wp(), lat: '39.4' }, wp()] }],
    ['lat 91', { ...ok, waypoints: [{ ...wp(), lat: 91 }, wp()] }],
  ];
  for (const [label, body] of bad) {
    const r = await s.call('POST', '/api/missions', body);
    assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(typeof r.body.error, 'string');
  }
  assert.equal((await s.call('POST', '/api/missions', { ...ok, siteId: 'nope' })).status, 404);
  const raw = await fetch(`${s.http}/api/missions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(raw.status, 400);
  const evil = { method: 'POST', headers: { origin: 'http://evil.example' } };
  assert.equal((await fetch(`${s.http}/api/missions/demo`, evil)).status, 403, 'foreign origin cannot create missions');
  assert.equal((await fetch(`${s.http}/api/missions/00000000-0000-4000-8000-000000000000/start`, evil)).status, 403);
  assert.equal((await fetch(`${s.http}/api/missions`, { headers: { origin: 'http://evil.example' } })).status, 200, 'GET stays open');
  const local = await fetch(`${s.http}/api/missions/demo`, { method: 'POST', headers: { origin: 'http://localhost:8080' } });
  assert.equal(local.status, 201, 'localhost page is allowed');
  s.track({ body: await local.json() });
  assert.equal((await s.call('GET', '/api/missions/not-a-uuid')).status, 404);
  assert.equal((await s.call('GET', '/api/missions/00000000-0000-4000-8000-000000000000')).status, 404);
  assert.equal((await s.call('POST', '/api/missions/00000000-0000-4000-8000-000000000000/start')).status, 404);
  assert.equal((await s.call('POST', '/api/missions/00000000-0000-4000-8000-000000000000/abort')).status, 404);
  assert.equal(parseBody({ ...ok, waypoints: [wp(10), wp(190)] }).ok, true);
  const empty = await fetch(`${s.http}/api/missions/00000000-0000-4000-8000-000000000000/start`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  assert.equal(empty.status, 404, 'empty JSON body on a POST is accepted');
});

test('server restart marks RUNNING missions ABORTED', { skip }, async () => {
  const ins = await cleanDb!.query(
    `INSERT INTO missions (site_id, swarm, name, status, started_at) VALUES ('cac', 'A', 'test-wp5 stale', 'RUNNING', now() - interval '1 minute') RETURNING id`);
  const id = ins.rows[0].id as string;
  created.push(id);
  const s = await start({ drones: 2 });
  let st = '';
  for (let i = 0; i < 30 && st !== 'ABORTED'; i++) { st = (await s.call('GET', `/api/missions/${id}`)).body.status; if (st !== 'ABORTED') await sleep(100); }
  assert.equal(st, 'ABORTED');
  assert.ok((await s.call('GET', `/api/missions/${id}`)).body.ended_at);
});
