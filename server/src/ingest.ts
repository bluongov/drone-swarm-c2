// External telemetry: POST /ingest and WS /ingest. Fixes are validated, converted to scene coords, kept in `ext`
// (render-only, never flocked) and queued for the telemetry table.
import type { FastifyInstance } from 'fastify';
import { SC } from '../../sim-core.js';
import { originAllowed } from './config.ts';
import { rawToString } from './live.ts';
import type { AppCtx } from './world.ts';

export const MAX_BATCH = 200;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RESERVED_RE = /^(UAV|BRV|TRK)-/i;      // ids used by simulated drones
const STATE_RE = /^[A-Za-z0-9_ .-]{0,16}$/;
const MAX_EXT = 500;

export interface Fix {
  droneId: string; ts: number; lat: number; lon: number; alt_m: number;
  vx: number | null; vy: number | null; vz: number | null; heading: number | null; battery: number | null; state: string | null;
}
export type ExtRow = [id: string, x: number, y: number, z: number, heading: number | null, battery: number | null, state: string | null];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// Velocity convention: scene axes in m/s (vx east, vy up, vz south), same as the sim telemetry rows.
export function parseFix(raw: unknown, nowMs: number): { ok: true; fix: Fix } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'fix must be an object' };
  const o = raw as Record<string, unknown>;
  if (typeof o.droneId !== 'string' || !ID_RE.test(o.droneId)) return { ok: false, error: 'droneId must match /^[A-Za-z0-9_-]{1,32}$/' };
  if (RESERVED_RE.test(o.droneId)) return { ok: false, error: 'droneId prefix UAV-/BRV-/TRK- is reserved for simulated drones' };
  if (!isNum(o.lat) || o.lat < -90 || o.lat > 90) return { ok: false, error: 'lat must be a number in [-90, 90]' };
  if (!isNum(o.lon) || o.lon < -180 || o.lon > 180) return { ok: false, error: 'lon must be a number in [-180, 180]' };
  if (!isNum(o.alt_m) || o.alt_m < -500 || o.alt_m > 20000) return { ok: false, error: 'alt_m must be a number in [-500, 20000]' };
  const vel = (k: string): number | null | undefined => {
    const v = o[k];
    if (v === undefined || v === null) return null;
    return isNum(v) && Math.abs(v) <= 1000 ? v : undefined;
  };
  const vx = vel('vx'), vy = vel('vy'), vz = vel('vz');
  if (vx === undefined || vy === undefined || vz === undefined) return { ok: false, error: 'vx, vy, vz must be numbers with |v| <= 1000 m/s' };
  let heading: number | null = null;
  if (o.heading !== undefined && o.heading !== null) {
    if (!isNum(o.heading) || o.heading < -360 || o.heading > 720) return { ok: false, error: 'heading must be degrees in [-360, 720]' };
    heading = ((o.heading % 360) + 360) % 360;
  } else if (vx !== null && vz !== null && (vx !== 0 || vz !== 0)) {
    heading = ((Math.atan2(vx, -vz) * 180 / Math.PI) + 360) % 360;
  }
  let battery: number | null = null;
  if (o.battery !== undefined && o.battery !== null) {
    if (!isNum(o.battery) || o.battery < 0 || o.battery > 100) return { ok: false, error: 'battery must be a percentage in [0, 100]' };
    battery = o.battery;
  }
  let state: string | null = null;
  if (o.state !== undefined && o.state !== null) {
    if (typeof o.state !== 'string' || !STATE_RE.test(o.state)) return { ok: false, error: 'state must be a short string (A-Z a-z 0-9 _ . - space, max 16)' };
    state = o.state;
  }
  let ts = nowMs;
  if (o.ts !== undefined && o.ts !== null) {
    const t = typeof o.ts === 'string' ? Date.parse(o.ts) : isNum(o.ts) ? (o.ts < 1e11 ? o.ts * 1000 : o.ts) : NaN;
    if (!Number.isFinite(t) || Math.abs(t - nowMs) > 7 * 86400_000) return { ok: false, error: 'ts must be an ISO string or epoch s/ms within 7 days of now' };
    ts = t;
  }
  return { ok: true, fix: { droneId: o.droneId, ts, lat: o.lat, lon: o.lon, alt_m: o.alt_m, vx, vy, vz, heading, battery, state } };
}

interface ExtEntry { row: ExtRow; seen: number }

export class ExtStore {
  private m = new Map<string, ExtEntry>();
  private ttlMs: number;
  constructor(ttlMs: number) { this.ttlMs = ttlMs; }
  get size() { return this.m.size; }
  has(id: string) { return this.m.has(id); }
  full(id: string) { return !this.m.has(id) && this.m.size >= MAX_EXT; }
  upsert(row: ExtRow, nowMs: number) { this.m.set(row[0], { row, seen: nowMs }); }
  list(nowMs: number): ExtRow[] {
    const out: ExtRow[] = [];
    for (const [id, e] of this.m) {
      if (nowMs - e.seen > this.ttlMs) this.m.delete(id); else out.push(e.row);
    }
    return out;
  }
}

export interface IngestResult { accepted: number; rejected: Array<{ index: number; error: string }> }

export function ingestFixes(ctx: AppCtx, body: unknown): IngestResult {
  const now = Date.now();
  const items = Array.isArray(body) ? body : [body];
  const res: IngestResult = { accepted: 0, rejected: [] };
  if (items.length > MAX_BATCH) return { accepted: 0, rejected: [{ index: -1, error: `batch larger than ${MAX_BATCH}` }] };
  items.forEach((raw, index) => {
    const p = parseFix(raw, now);
    if (!p.ok) { res.rejected.push({ index, error: p.error }); return; }
    const f = p.fix;
    if (ctx.ext.full(f.droneId)) { res.rejected.push({ index, error: 'too many external drones' }); return; }
    const [x, z] = ctx.site.frames.geoToScene(f.lat, f.lon);
    ctx.ext.upsert([f.droneId, x, f.alt_m * SC, z, f.heading, f.battery, f.state], now);
    ctx.telemetry.registerDrone(f.droneId, 'real', null);
    ctx.telemetry.enqueue({
      ts: f.ts, drone: f.droneId, lat: f.lat, lon: f.lon, alt_m: f.alt_m, vx: f.vx, vy: f.vy, vz: f.vz,
      heading: f.heading, battery: f.battery, link: null, temp: null, state: f.state,
    });
    res.accepted++;
  });
  return res;
}

export async function registerIngest(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.post('/ingest', {
    bodyLimit: 256 * 1024,
    preValidation: async (req, reply) => {
      if (!originAllowed(req.headers.origin, ctx.cfg)) return reply.code(403).send({ error: 'origin not allowed' });
    },
  }, async (req, reply) => {
    const r = ingestFixes(ctx, req.body);
    return reply.code(r.accepted ? 202 : 400).send(r);
  });

  app.get('/ingest', {
    websocket: true,
    preValidation: async (req, reply) => {
      if (!originAllowed(req.headers.origin, ctx.cfg)) return reply.code(403).send({ error: 'origin not allowed' });
    },
  }, (socket) => {
    ctx.stats.ingestClients++;
    let tokens = 200, last = Date.now();
    socket.on('message', (data: any) => {
      const now = Date.now();
      tokens = Math.min(200, tokens + (now - last) / 1000 * 100); last = now;     // ~100 msg/s sustained
      if (--tokens < 0) { socket.close(1008, 'rate limit'); return; }
      let body: unknown;
      try { body = JSON.parse(rawToString(data)); } catch { socket.send(JSON.stringify({ type: 'ack', accepted: 0, rejected: [{ index: -1, error: 'invalid JSON' }] })); return; }
      socket.send(JSON.stringify({ type: 'ack', ...ingestFixes(ctx, body) }));
    });
    socket.on('close', () => { ctx.stats.ingestClients--; });
    socket.on('error', () => { try { socket.terminate(); } catch { /* ignore */ } });
  });
}
