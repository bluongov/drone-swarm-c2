// Mission service (WP5): validation (PostGIS NFZ + terrain clearance), FSM, REST, demo mission, DB rows.
//
// FSM:  PLANNED --start--> RUNNING --world DONE--> DONE
//                                  --abort / world ABORTED (operator changed the mode) --> ABORTED
//                                  --setMission refused / world halted--> FAILED
// On server start every mission still RUNNING in the DB is marked ABORTED (reason 'server restart', logged: the
// schema has no reason column).
//
// Wiring with the skeleton (server/src/world.ts, bus.ts, live.ts):
//   - ctx.missionSnapshot()            -> {id, status:'RUNNING', wpIdx, total} | null, goes into every snap as `mission`
//   - ctx.bus 'mission'                -> {id, status, wpIdx, total}, forwarded to WS clients as {type:'mission', ...}
//   - ctx.bus 'worldMission'           <- hooks.onMissionEvent payloads of the core: {type:'WP'|'DONE'|'ABORTED', id, wpIdx?, total?, reason?}
//   - ctx.world.swarms.A.setMission(v3[] scene units, id) / clearMission(reason)
//
// NFZ validation choice: GEOMETRY (SRID 4326, planar in degrees), not geography. The site frames are an equirectangular
// affine map (geoToSite), so a straight leg in scene space is exactly a straight segment in lon/lat; a geography
// (great-circle) intersection would bend the legs and disagree with what the swarm flies. NFZ polygons were built the same
// way (64-point circle through sceneToGeo). Distances for warnings use geography (metres).
// Besides the DB zones, the circles in world.obstacles (NFZ-B is random and not in the DB) are checked in scene space.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { M_PER_U, SC, V3 } from '../../sim-core.js';
import { originAllowed } from './config.ts';
import type { AppCtx } from './world.ts';
import type { Site } from './site.ts';

export interface Waypoint { lat: number; lon: number; alt_m: number }
export type MissionStatus = 'PLANNED' | 'RUNNING' | 'DONE' | 'ABORTED' | 'FAILED';
export interface Conflict { type: 'NFZ' | 'TERRAIN'; leg: number; detail: Record<string, unknown> }
export interface Warning { type: string; leg?: number; detail?: Record<string, unknown> }

export const LIMITS = { minWp: 2, maxWp: 20, minAlt: 10, maxAlt: 190, stepM: 4, clearM: 8, nearNfzM: 50 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MPU = M_PER_U as number;

type P = { x: number; z: number; alt_m: number };
const round = (v: number, d = 2) => { const k = 10 ** d; return Math.round(v * k) / k; };

// ---------------- validation ----------------

export function parseBody(body: any): { ok: true; siteId: string; swarm: string; name: string; waypoints: Waypoint[] } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const { siteId, swarm = 'A', name, waypoints } = body;
  if (typeof siteId !== 'string' || !siteId || siteId.length > 64) return { ok: false, error: 'siteId must be a non-empty string' };
  if (swarm !== 'A') return { ok: false, error: "swarm must be 'A'" };
  if (typeof name !== 'string' || !name.trim() || name.length > 80) return { ok: false, error: 'name must be a string of 1..80 chars' };
  if (!Array.isArray(waypoints) || waypoints.length < LIMITS.minWp || waypoints.length > LIMITS.maxWp)
    return { ok: false, error: `waypoints must be an array of ${LIMITS.minWp}..${LIMITS.maxWp} items` };
  const out: Waypoint[] = [];
  for (let i = 0; i < waypoints.length; i++) {
    const w = waypoints[i];
    if (!w || typeof w !== 'object') return { ok: false, error: `waypoints[${i}] must be an object` };
    const { lat, lon, alt_m } = w;
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: `waypoints[${i}].lat must be a number in -90..90` };
    if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return { ok: false, error: `waypoints[${i}].lon must be a number in -180..180` };
    if (typeof alt_m !== 'number' || !Number.isFinite(alt_m) || alt_m < LIMITS.minAlt || alt_m > LIMITS.maxAlt)
      return { ok: false, error: `waypoints[${i}].alt_m must be a number in ${LIMITS.minAlt}..${LIMITS.maxAlt}` };
    out.push({ lat, lon, alt_m });
  }
  return { ok: true, siteId, swarm, name: name.trim(), waypoints: out };
}

// Terrain: each leg sampled every 4 m (scene space), altitude interpolated linearly, require
// alt (scene units) >= topNear(x, z, 8) + 4 (= 8 m clearance). One conflict per leg: the worst sample.
export function terrainConflicts(site: Pick<Site, 'terrain'>, pts: P[]): Conflict[] {
  const out: Conflict[] = [];
  const clearU = LIMITS.clearM * SC;
  for (let leg = 0; leg < pts.length - 1; leg++) {
    const a = pts[leg], b = pts[leg + 1];
    const lenM = Math.hypot(b.x - a.x, b.z - a.z) * MPU;
    const steps = Math.max(1, Math.ceil(lenM / LIMITS.stepM));
    let worst: { short: number; x: number; z: number; alt: number; top: number } | null = null;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const altU = (a.alt_m + (b.alt_m - a.alt_m) * t) * SC;
      const top = site.terrain.topNear(x, z, 8);
      const short = top + clearU - altU;
      if (short > 1e-9 && (!worst || short > worst.short)) worst = { short, x, z, alt: altU, top };
    }
    if (worst) out.push({
      type: 'TERRAIN', leg,
      detail: { x: round(worst.x), z: round(worst.z), needed_m: round((worst.top + clearU) * MPU), alt_m: round(worst.alt * MPU), terrain_m: round(worst.top * MPU), clearance_m: LIMITS.clearM },
    });
  }
  return out;
}

// distance from point to segment, scene units
function segDist(px: number, pz: number, a: P, b: P): number {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / l2)) : 0;
  return Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
}

// circles from world.obstacles (scene space). Used for validation and by the demo planner.
export function obstacleCircles(world: { obstacles?: any[] }): Array<{ x: number; z: number; r: number; ceilM: number; name: string }> {
  return (world.obstacles ?? []).filter(o => o && o.type === 'NFZ').map(o => ({ x: o.x, z: o.z, r: o.r, ceilM: o.h * MPU, name: String(o.name ?? 'NFZ') }));
}

export interface Validation { conflicts: Conflict[]; warnings: Warning[] }

export async function validateRoute(ctx: AppCtx, site: Site, wps: Waypoint[]): Promise<Validation> {
  const conflicts: Conflict[] = [], warnings: Warning[] = [];
  const pts: P[] = wps.map(w => { const [x, z] = site.frames.geoToScene(w.lat, w.lon); return { x, z, alt_m: w.alt_m }; });

  // (1) NFZ in PostGIS: one LineString per leg, ST_Intersects with the zone polygon + altitude range overlap [floor, ceiling]
  const hit = new Set<string>();
  if (ctx.db) {
    const r = await ctx.db.query(
      `WITH p AS (
         SELECT t.i, ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326) AS g, t.alt
         FROM unnest($2::float8[], $3::float8[], $4::float8[]) WITH ORDINALITY AS t(lon, lat, alt, i)
       ), legs AS (
         SELECT a.i - 1 AS leg, ST_MakeLine(a.g, b.g) AS line, LEAST(a.alt, b.alt) AS alt_min, GREATEST(a.alt, b.alt) AS alt_max
         FROM p a JOIN p b ON b.i = a.i + 1
       )
       SELECT l.leg::int AS leg, z.id, z.name, z.label, z.floor_m, z.ceiling_m, l.alt_min, l.alt_max,
              ST_Intersects(z.geom, l.line) AS hit,
              ST_Distance(z.geom::geography, l.line::geography) AS dist_m
       FROM legs l JOIN no_fly_zones z ON z.site_id = $1
       WHERE l.alt_min < z.ceiling_m AND l.alt_max > z.floor_m
         AND (ST_Intersects(z.geom, l.line) OR ST_DWithin(z.geom::geography, l.line::geography, $5))
       ORDER BY l.leg, z.id`,
      [site.id, wps.map(w => w.lon), wps.map(w => w.lat), wps.map(w => w.alt_m), LIMITS.nearNfzM]);
    for (const row of r.rows) {
      if (row.hit) {
        hit.add(`${row.leg}:${row.name}`);
        conflicts.push({ type: 'NFZ', leg: row.leg, detail: { name: row.name, label: row.label, floor_m: row.floor_m, ceiling_m: row.ceiling_m, alt_min_m: round(row.alt_min), alt_max_m: round(row.alt_max), source: 'db' } });
      } else warnings.push({ type: 'NFZ_NEAR', leg: row.leg, detail: { name: row.name, distance_m: round(row.dist_m, 1) } });
    }
  }
  // zones of the running world that the DB check did not report (NFZ-B is random; also covers an empty NFZ table)
  for (const o of obstacleCircles(ctx.world)) {
    for (let leg = 0; leg < pts.length - 1; leg++) {
      if (hit.has(`${leg}:${o.name}`)) continue;
      const a = pts[leg], b = pts[leg + 1];
      if (Math.min(a.alt_m, b.alt_m) >= o.ceilM) continue;
      const d = segDist(o.x, o.z, a, b);
      if (d <= o.r) conflicts.push({ type: 'NFZ', leg, detail: { name: o.name, floor_m: 0, ceiling_m: round(o.ceilM), alt_min_m: round(Math.min(a.alt_m, b.alt_m)), alt_max_m: round(Math.max(a.alt_m, b.alt_m)), source: 'world' } });
      else if ((d - o.r) * MPU < LIMITS.nearNfzM && !warnings.some(w => w.type === 'NFZ_NEAR' && w.leg === leg && (w.detail as any)?.name === o.name))
        warnings.push({ type: 'NFZ_NEAR', leg, detail: { name: o.name, distance_m: round((d - o.r) * MPU, 1) } });
    }
  }
  // (2) terrain clearance
  conflicts.push(...terrainConflicts(site, pts));
  conflicts.sort((a, b) => a.leg - b.leg || (a.type < b.type ? -1 : 1));

  // (3) soft checks
  const half = site.city.n * site.city.cell / 2 / MPU * 0.98;     // height map extent in scene units
  pts.forEach((p, i) => {
    if (Math.abs(p.x) > 280 || Math.abs(p.z) > 280) warnings.push({ type: 'OUTSIDE_AREA', detail: { waypoint: i, x: round(p.x), z: round(p.z), note: 'outside the +-560 m operations area' } });
    if (Math.hypot(p.x, p.z) > half) warnings.push({ type: 'OUTSIDE_TERRAIN', detail: { waypoint: i, note: 'beyond the height map: terrain unknown (assumed 0)' } });
  });
  return { conflicts, warnings };
}

// ---------------- demo route ----------------

// 5 waypoints around the site (any site of sites.js): landmark positions (non-NFZ) ordered around their centroid, legs kept clear of every NFZ
// circle (+25 units), altitudes raised until terrain + NFZ validation passes. Deterministic for a given site and world.
export function planDemo(site: Site, world: { obstacles?: any[] }): Waypoint[] {
  const circles = obstacleCircles(world);
  const margin = 25;
  const lms = site.landmarks.filter(l => !l.nfz).map(l => ({ x: l.x, z: l.z }));
  const all = site.landmarks.map(l => ({ x: l.x, z: l.z }));
  const cx = all.reduce((s, p) => s + p.x, 0) / (all.length || 1), cz = all.reduce((s, p) => s + p.z, 0) / (all.length || 1);
  const clear = (a: { x: number; z: number }, b: { x: number; z: number }) => {
    let m = Infinity;
    for (const c of circles) m = Math.min(m, segDist(c.x, c.z, { ...a, alt_m: 0 }, { ...b, alt_m: 0 }) - c.r - margin);
    return m;
  };
  type Pt = { x: number; z: number };
  const landmarkSets: Pt[][] = [];
  for (let skip = 0; skip < lms.length && lms.length >= 5; skip++) landmarkSets.push(lms.filter((_, i) => i !== skip).slice(0, 5));
  const ringSets: Pt[][] = [];
  for (const R of [170, 200, 140, 230, 110]) for (let k = 0; k < 8; k++) {
    const ph = k / 8 * Math.PI * 2 / 5;
    ringSets.push(Array.from({ length: 5 }, (_, i) => ({ x: cx + Math.cos(ph + i / 5 * Math.PI * 2) * R, z: cz + Math.sin(ph + i / 5 * Math.PI * 2) * R })));
  }
  // shortest NFZ-free open loop of a candidate family (points ordered by angle around the centroid, every start tried)
  const bestOf = (sets: Pt[][]): Pt[] | null => {
    let best: Pt[] | null = null, bestLen = Infinity;
    for (const set of sets) {
      const sorted = set.slice().sort((a, b) => Math.atan2(a.z - cz, a.x - cx) - Math.atan2(b.z - cz, b.x - cx));
      for (let rot = 0; rot < sorted.length; rot++) {
        const pts = sorted.slice(rot).concat(sorted.slice(0, rot));
        let m = Infinity, len = 0;
        for (let i = 0; i < pts.length - 1; i++) { m = Math.min(m, clear(pts[i], pts[i + 1])); len += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z); }
        if (m > 0 && len < bestLen) { best = pts; bestLen = len; }
      }
    }
    return best;
  };
  // fallback when no 5-landmark loop is NFZ-free (e.g. a random NFZ-B in the way): drop landmarks, down to 3 waypoints
  const subsets = (k: number): Pt[][] => {
    const out: Pt[][] = [];
    const rec = (from: number, acc: Pt[]) => {
      if (acc.length === k) { out.push(acc); return; }
      for (let i = from; i < lms.length; i++) rec(i + 1, [...acc, lms[i]]);
    };
    rec(0, []);
    return out;
  };
  const best = bestOf(landmarkSets) ?? (lms.length >= 4 ? bestOf(subsets(4)) : null) ?? (lms.length >= 3 ? bestOf(subsets(3)) : null) ?? bestOf(ringSets);
  if (!best) throw new Error('no NFZ-free demo loop found');
  const pts: P[] = best.map(p => ({ x: p.x, z: p.z, alt_m: 60 }));
  for (let it = 0; it < 8; it++) {
    const cs = terrainConflicts(site, pts);
    if (!cs.length) break;
    for (const c of cs) for (const i of [c.leg, c.leg + 1]) pts[i].alt_m = Math.min(LIMITS.maxAlt, Math.max(pts[i].alt_m, Math.ceil(((c.detail.needed_m as number) + 6) / 5) * 5));
  }
  return pts.map(p => { const [lat, lon] = site.frames.sceneToGeo(p.x, p.z); return { lat: round(lat, 7), lon: round(lon, 7), alt_m: Math.round(p.alt_m) }; });
}

// ---------------- service ----------------

interface Running { id: string; swarm: string; wpIdx: number; total: number }

export function registerMissions(app: FastifyInstance, ctx: AppCtx): void {
  const running = new Map<string, Running>();     // swarm key -> running mission (in memory is the source of truth)
  const starting = new Set<string>();             // swarm keys with a start in flight
  const bootAt = new Date();
  let dbChain: Promise<unknown> = Promise.resolve();   // DB status writes are serialised so they land in order

  const persist = (sql: string, params: unknown[]): Promise<unknown> => {
    const p = dbChain.then(() => ctx.db ? ctx.db.query(sql, params) : undefined).catch(err => { app.log.error({ err }, 'mission status write failed'); });
    dbChain = p;
    return p;
  };
  const emit = (r: Running, status: MissionStatus) => ctx.bus.emit('mission', { id: r.id, status, wpIdx: r.wpIdx, total: r.total });
  const finish = (r: Running, status: 'DONE' | 'ABORTED' | 'FAILED', why?: string): Promise<unknown> => {
    if (running.get(r.swarm) !== r) return Promise.resolve();
    running.delete(r.swarm);
    if (status === 'DONE') r.wpIdx = r.total;
    app.log.info({ mission: r.id, status, why }, 'mission finished');
    emit(r, status);
    return persist(`UPDATE missions SET status = $2, ended_at = now() WHERE id = $1 AND status = 'RUNNING'`, [r.id, status]);
  };

  ctx.missionSnapshot = () => {
    const r = running.get('A');
    return r ? { id: r.id, status: 'RUNNING', wpIdx: r.wpIdx, total: r.total } : null;
  };

  // events from the core (FakeWorld uses WAYPOINT / CLEARED, the contract is WP / ABORTED)
  ctx.bus.on('worldMission', (ev: any) => {
    if (!ev || ev.id == null) return;
    const r = [...running.values()].find(x => x.id === ev.id);
    if (!r) return;
    switch (ev.type) {
      case 'WP': case 'WAYPOINT':
        r.wpIdx = Number.isInteger(ev.wpIdx) ? ev.wpIdx : r.wpIdx + 1;
        emit(r, 'RUNNING');
        break;
      case 'DONE': void finish(r, 'DONE'); break;
      case 'ABORTED': case 'CLEARED': void finish(r, 'ABORTED', ev.reason ?? 'world'); break;
    }
  });

  // restart recovery: RUNNING rows from a previous process can never finish
  if (ctx.db) {
    const sweep = async (): Promise<boolean> => {
      try {
        const r = await ctx.db!.query(
          `UPDATE missions SET status = 'ABORTED', ended_at = now() WHERE status = 'RUNNING' AND (started_at IS NULL OR started_at < $1) AND NOT (id = ANY($2::uuid[])) RETURNING id`,
          [bootAt, [...running.values()].map(x => x.id)]);
        if (r.rows.length) app.log.warn({ ids: r.rows.map((x: any) => x.id), reason: 'server restart' }, 'running missions marked ABORTED');
        return true;
      } catch { return false; }
    };
    let retry: NodeJS.Timeout | undefined, closed = false;
    app.addHook('onClose', async () => { closed = true; if (retry) clearInterval(retry); });
    void sweep().then(ok => {
      if (ok || closed) return;                              // DB not reachable yet: keep trying until the sweep goes through
      retry = setInterval(() => { void sweep().then(done => { if (done && retry) clearInterval(retry); }); }, 5000);
      retry.unref();
    });
  }

  const fail = (reply: FastifyReply, code: number, error: string, extra: Record<string, unknown> = {}) => reply.code(code).send({ error, ...extra });
  const dbReady = (reply: FastifyReply): boolean => {
    if (ctx.db) return true;
    fail(reply, 503, 'database unavailable');
    return false;
  };

  async function loadMission(id: string): Promise<any | null> {
    if (!UUID.test(id)) return null;
    const m = await ctx.db!.query(
      `SELECT id, site_id, swarm, name, status, created_at, started_at, ended_at FROM missions WHERE id = $1`, [id]);
    if (!m.rows.length) return null;
    const w = await ctx.db!.query(`SELECT seq, lat, lon, alt_m FROM mission_waypoints WHERE mission_id = $1 ORDER BY seq`, [id]);
    return { ...m.rows[0], waypoints: w.rows };
  }
  const live = (m: any) => {
    const r = running.get(m.swarm);
    return r && r.id === m.id ? { ...m, wpIdx: r.wpIdx, total: r.total } : m;
  };

  async function createMission(siteId: string, swarm: string, name: string, wps: Waypoint[], site: Site) {
    const v = await validateRoute(ctx, site, wps);
    if (v.conflicts.length) return { conflicts: v.conflicts, warnings: v.warnings };
    const r = await ctx.db!.query(
      `WITH m AS (INSERT INTO missions (site_id, swarm, name, status) VALUES ($1, $2, $3, 'PLANNED') RETURNING id)
       INSERT INTO mission_waypoints (mission_id, seq, lat, lon, alt_m)
       SELECT m.id, t.i - 1, t.lat, t.lon, t.alt FROM m, unnest($4::float8[], $5::float8[], $6::float8[]) WITH ORDINALITY AS t(lat, lon, alt, i)
       RETURNING mission_id`,
      [siteId, swarm, name, wps.map(w => w.lat), wps.map(w => w.lon), wps.map(w => w.alt_m)]);
    return { id: r.rows[0].mission_id as string, warnings: v.warnings };
  }

  void app.register(async inst => {
    // POST with an empty body and a JSON content type must work (start / abort / demo carry no body)
    inst.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      const s = String(body);
      if (!s.trim()) return done(null, {});
      try { done(null, JSON.parse(s)); } catch { const e: any = new Error('invalid JSON body'); e.statusCode = 400; done(e); }
    });
    // state-changing requests only from non-browser clients, localhost pages or ALLOWED_ORIGINS (a foreign web page must not start missions)
    inst.addHook('onRequest', async (req, reply) => {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !originAllowed(req.headers.origin, ctx.cfg)) return reply.code(403).send({ error: 'origin not allowed' });
    });
    inst.setErrorHandler((err: any, req, reply) => {
      const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
      if (code >= 500) {
        req.log.error({ err }, 'mission request failed');
        return reply.code(ctx.db && !ctx.db.up ? 503 : 500).send({ error: ctx.db && !ctx.db.up ? 'database unavailable' : 'internal error' });
      }
      return reply.code(code).send({ error: err.message });
    });

    inst.post('/api/missions', async (req, reply) => {
      const p = parseBody(req.body);
      if (!p.ok) return fail(reply, 400, p.error);
      if (!dbReady(reply)) return;
      const site = await ctx.getSite(p.siteId);
      if (!site) return fail(reply, 404, `unknown site ${p.siteId}`);
      const res = await createMission(p.siteId, p.swarm, p.name, p.waypoints, site);
      if ('conflicts' in res) return reply.code(422).send({ conflicts: res.conflicts, warnings: res.warnings });
      return reply.code(201).send({ id: res.id, status: 'PLANNED', warnings: res.warnings });
    });

    inst.post('/api/missions/demo', async (req, reply) => {
      if (!dbReady(reply)) return;
      const body: any = req.body ?? {};
      const siteId = typeof body.siteId === 'string' && body.siteId ? body.siteId : ctx.site.id;
      const site = await ctx.getSite(siteId);
      if (!site) return fail(reply, 404, `unknown site ${siteId}`);
      let wps: Waypoint[];
      try { wps = planDemo(site, ctx.world); } catch (err) { return fail(reply, 500, (err as Error).message); }
      const name = `Demo loop ${site.reg.short}`;
      const res = await createMission(siteId, 'A', name, wps, site);
      if ('conflicts' in res) return reply.code(422).send({ conflicts: res.conflicts, warnings: res.warnings });
      return reply.code(201).send({ id: res.id, status: 'PLANNED', name, waypoints: wps, warnings: res.warnings });
    });

    inst.get('/api/missions', async (req, reply) => {
      if (!dbReady(reply)) return;
      const q: any = req.query ?? {};
      const limit = Math.max(1, Math.min(500, Math.round(Number(q.limit)) || 100));
      const params: unknown[] = [limit];
      let where = '';
      if (typeof q.siteId === 'string' && q.siteId) { params.push(q.siteId); where += ` AND m.site_id = $${params.length}`; }
      if (typeof q.status === 'string' && q.status) { params.push(q.status.toUpperCase()); where += ` AND m.status = $${params.length}`; }
      const r = await ctx.db!.query(
        `SELECT m.id, m.site_id, m.swarm, m.name, m.status, m.created_at, m.started_at, m.ended_at,
                (SELECT count(*)::int FROM mission_waypoints w WHERE w.mission_id = m.id) AS waypoint_count
         FROM missions m WHERE true${where} ORDER BY m.created_at DESC LIMIT $1`, params);
      return { missions: r.rows.map(live) };
    });

    inst.get<{ Params: { id: string } }>('/api/missions/:id', async (req, reply) => {
      if (!dbReady(reply)) return;
      const m = await loadMission(req.params.id);
      if (!m) return fail(reply, 404, 'mission not found');
      return live(m);
    });

    inst.post<{ Params: { id: string } }>('/api/missions/:id/start', async (req, reply) => {
      if (!dbReady(reply)) return;
      const id = req.params.id;
      if (!UUID.test(id)) return fail(reply, 404, 'mission not found');
      const swarmKey = 'A';
      const busy = running.get(swarmKey);
      if (busy || starting.has(swarmKey)) return fail(reply, 409, `swarm ${swarmKey} already has a RUNNING mission`, { runningId: busy?.id ?? null });
      starting.add(swarmKey);                    // set before the first await: two parallel starts cannot both pass
      try {
        const m = await loadMission(id);
        if (!m) return fail(reply, 404, 'mission not found');
        if (m.status !== 'PLANNED') return fail(reply, 409, `mission is ${m.status}, only PLANNED can start`, { status: m.status });
        if (m.site_id !== ctx.site.id) return fail(reply, 409, `this server runs site ${ctx.site.id}, mission is for ${m.site_id}`);
        if (ctx.runner.failed) return fail(reply, 503, `world halted: ${ctx.runner.failed}`);
        const sw = ctx.world.swarms[m.swarm];
        if (!sw || typeof sw.setMission !== 'function') return fail(reply, 409, `swarm ${m.swarm} not available`);
        if (Array.isArray(sw.drones) && !sw.drones.length) return fail(reply, 409, `swarm ${m.swarm} has no drones`);
        const wps: Waypoint[] = m.waypoints.map((w: any) => ({ lat: w.lat, lon: w.lon, alt_m: w.alt_m }));
        const v = await validateRoute(ctx, ctx.site, wps);      // the world may have changed (NFZ-B): check again
        if (v.conflicts.length) return reply.code(422).send({ conflicts: v.conflicts, warnings: v.warnings });

        const upd = await ctx.db!.query(`UPDATE missions SET status = 'RUNNING', started_at = now(), ended_at = NULL WHERE id = $1 AND status = 'PLANNED' RETURNING id`, [id]);
        if (!upd.rows.length) return fail(reply, 409, 'mission is no longer PLANNED');
        const r: Running = { id, swarm: m.swarm, wpIdx: 0, total: wps.length };
        running.set(m.swarm, r);
        const v3 = wps.map(w => { const [x, z] = ctx.site.frames.geoToScene(w.lat, w.lon); return V3(x, w.alt_m * SC, z); });
        let ok = false;
        try { ok = sw.setMission(v3, id) !== false; }     // the core returns false when it refuses (FakeWorld returns nothing)
        catch (err) { app.log.error({ err }, 'setMission threw'); }
        if (!ok) {
          await finish(r, 'FAILED', 'setMission refused');
          return fail(reply, 500, 'world refused the mission', { status: 'FAILED' });
        }
        if (running.get(m.swarm) === r) emit(r, 'RUNNING');
        return { id, status: 'RUNNING', wpIdx: r.wpIdx, total: r.total, warnings: v.warnings };
      } finally { starting.delete(swarmKey); }
    });

    inst.post<{ Params: { id: string } }>('/api/missions/:id/abort', async (req, reply) => {
      if (!dbReady(reply)) return;
      const id = req.params.id;
      if (!UUID.test(id)) return fail(reply, 404, 'mission not found');
      const r = [...running.values()].find(x => x.id === id);
      if (!r) {
        const m = await loadMission(id);
        if (!m) return fail(reply, 404, 'mission not found');
        return fail(reply, 409, `mission is ${m.status}, only RUNNING can be aborted`, { status: m.status });
      }
      const done = finish(r, 'ABORTED', 'operator abort');       // state first: the world's ABORTED event below is then ignored
      try { ctx.world.swarms[r.swarm]?.clearMission?.('operator abort'); } catch (err) { app.log.error({ err }, 'clearMission threw'); }
      await done;
      return { id, status: 'ABORTED' };
    });
  });
}
