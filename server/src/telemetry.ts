// Batch telemetry writer. Rows are queued, flushed every second with one multi-row INSERT ... SELECT FROM unnest().
// Bounded queue (oldest dropped). If the DB is down the server keeps running and retries on the next flush.
import { M_PER_U } from '../../sim-core.js';
import type { Bus } from './bus.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Site } from './site.ts';

export interface TelemetryRow {
  ts: number; drone: string;
  lat: number | null; lon: number | null; alt_m: number | null;
  vx: number | null; vy: number | null; vz: number | null;
  heading: number | null; battery: number | null; link: number | null; temp: number | null; state: string | null;
}

const BATCH = 10_000;

export class TelemetryWriter {
  private queue: TelemetryRow[] = [];
  private pendingDrones = new Map<string, { swarm: string | null; kind: 'sim' | 'real' }>();
  private knownDrones = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | null = null;
  private lastSample = 0;
  private unsub: (() => void) | null = null;
  written = 0;
  dropped = 0;
  lastError: string | null = null;

  private db: Db | null;
  private site: Site;
  private cfg: Config;
  constructor(db: Db | null, site: Site, cfg: Config) { this.db = db; this.site = site; this.cfg = cfg; }

  stats() { return { queued: this.queue.length, written: this.written, dropped: this.dropped }; }

  start(bus: Bus) {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, 1000);
    this.timer.unref();
    if (this.cfg.persistHz > 0) this.unsub = bus.on('snap', ev => this.sample(ev.snap, ev.wallMs));
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsub?.(); this.unsub = null;
    await this.flush();
  }

  registerDrone(id: string, kind: 'sim' | 'real', swarm: string | null) {
    if (!this.db || this.knownDrones.has(id)) return;
    this.pendingDrones.set(id, { swarm, kind });
  }

  enqueue(row: TelemetryRow) {
    if (!this.db) return;
    this.queue.push(row);
    this.trim();
  }

  private trim() {
    const over = this.queue.length - this.cfg.maxQueueRows;
    if (over > 0) { this.queue.splice(0, over); this.dropped += over; }
  }

  // sim drones: one row per drone every 1/persistHz seconds, from a world snapshot
  private sample(snap: any, wallMs: number) {
    if (!this.db || wallMs - this.lastSample < 1000 / this.cfg.persistHz - 5) return;
    this.lastSample = wallMs;
    const { sceneToGeo } = this.site.frames;
    for (const d of snap.drones as any[][]) {
      const [lat, lon] = sceneToGeo(d[2], d[4]);
      const vx = d[5] * M_PER_U, vy = d[6] * M_PER_U, vz = d[7] * M_PER_U;
      const heading = vx || vz ? ((Math.atan2(vx, -vz) * 180 / Math.PI) + 360) % 360 : null;
      this.registerDrone(d[0], 'sim', d[1] ?? null);
      this.queue.push({
        ts: wallMs, drone: d[0], lat, lon, alt_m: d[3] * M_PER_U, vx, vy, vz, heading,
        battery: d[11] ?? null, link: d[12] ?? null, temp: d[13] ?? null, state: d[10] ?? null,
      });
    }
    this.trim();
  }

  flush(): Promise<void> {
    if (!this.db) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async doFlush() {
    const db = this.db!;
    if (this.pendingDrones.size) {
      const entries = [...this.pendingDrones.entries()];
      try {
        await db.query(
          `INSERT INTO drones (id, site_id, swarm, kind)
           SELECT id, $1, swarm, kind FROM unnest($2::text[], $3::text[], $4::text[]) AS t(id, swarm, kind)
           ON CONFLICT (id) DO UPDATE SET site_id = EXCLUDED.site_id, swarm = EXCLUDED.swarm, kind = EXCLUDED.kind`,
          [this.site.id, entries.map(e => e[0]), entries.map(e => e[1].swarm), entries.map(e => e[1].kind)]);
        for (const [id] of entries) { this.knownDrones.add(id); this.pendingDrones.delete(id); }
      } catch (err) { this.lastError = (err as Error).message; return; }
    }
    for (let pass = 0; pass < 5 && this.queue.length; pass++) {
      const batch = this.queue.splice(0, BATCH);
      const col = <T>(f: (r: TelemetryRow) => T) => batch.map(f);
      try {
        await db.query(
          `INSERT INTO telemetry (ts, site_id, drone_id, lat, lon, alt_m, vx, vy, vz, heading, battery, link, temp, state)
           SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::float8[], $5::float8[], $6::real[], $7::real[], $8::real[], $9::real[],
                                $10::real[], $11::real[], $12::real[], $13::real[], $14::text[])`,
          [col(r => new Date(r.ts).toISOString()), col(() => this.site.id), col(r => r.drone), col(r => r.lat), col(r => r.lon), col(r => r.alt_m),
           col(r => r.vx), col(r => r.vy), col(r => r.vz), col(r => r.heading), col(r => r.battery), col(r => r.link), col(r => r.temp), col(r => r.state)]);
        this.written += batch.length;
        this.lastError = null;
      } catch (err) {
        this.lastError = (err as Error).message;
        this.queue = batch.concat(this.queue);   // keep rows for the next attempt
        this.trim();
        return;
      }
    }
  }
}
