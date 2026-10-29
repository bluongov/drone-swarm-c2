// World creation (real sim-core SimWorld, FakeWorld fallback) and the fixed-tick runner.
import { FakeWorld } from './fake-world.ts';
import type { WorldHooks } from './fake-world.ts';
import type { Bus } from './bus.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Site } from './site.ts';
import type { ExtStore } from './ingest.ts';
import type { TelemetryWriter } from './telemetry.ts';

export interface WorldLike {
  T: number;
  swarms: Record<string, any>;
  obstacles?: any[];
  step(dt: number): void;
  snapshot(): any;
  applyCommand(cmd: { name: string; args?: unknown[] }): unknown;
}

export interface MissionSnap { id: string; status: string; wpIdx: number; total: number }

// Shared application context handed to every register* function (routes, live, ingest, missions).
export interface AppCtx {
  cfg: Config;
  db: Db | null;
  bus: Bus;
  site: Site;
  runner: WorldRunner;
  world: WorldLike;
  ext: ExtStore;
  telemetry: TelemetryWriter;
  /** Mission service (WP5) replaces this; value is put in every snap as `mission`. */
  missionSnapshot: () => MissionSnap | null;
  /** Load a site by id (cached). Unknown ids return null. */
  getSite: (id: string) => Promise<Site | null>;
  stats: { liveClients: number; ingestClients: number; lastSnapBytes: number; lastSnapSeq: number };
}

export interface CreatedWorld { world: WorldLike; kind: 'sim' | 'fake'; note?: string }

export async function createWorld(site: Site, cfg: Config, bus: Bus, opts: { forceFake?: boolean } = {}): Promise<CreatedWorld> {
  let w: WorldLike | null = null;
  const hooks: WorldHooks = {
    log: (lv, msg) => bus.emit('log', { lv, msg, t: w?.T ?? 0 }),
    onRipple: (pos, color) => bus.emit('ripple', { x: pos.x, y: pos.y, z: pos.z, color }),
    onMissionEvent: ev => bus.emit('worldMission', ev),
  };
  const common = { topAt: site.terrain.topAt, topNear: site.terrain.topNear, landmarks: site.landmarks, seed: cfg.seed, hooks, n: cfg.drones || undefined, sceneToGeo: site.frames.sceneToGeo, baseB: site.reg.baseB };
  const core: any = await import('../../sim-core.js');
  let kind: CreatedWorld['kind'] = 'fake', note: string | undefined;
  if (core.SimWorld && !opts.forceFake) {
    w = new core.SimWorld(common) as WorldLike;
    kind = 'sim';
  } else {
    note = opts.forceFake ? 'FakeWorld requested' : 'sim-core.js has no SimWorld: using FakeWorld';
    w = new FakeWorld(common) as unknown as WorldLike;
  }
  return { world: w, kind, note };
}

// setTimeout loop that corrects drift against a wall-clock schedule and skips ahead if it falls far behind
export function every(periodMs: number, fn: () => void): () => void {
  let next = performance.now() + periodMs, timer: NodeJS.Timeout | undefined, stopped = false;
  const loop = () => {
    if (stopped) return;
    try { fn(); } finally {
      const now = performance.now();
      next += periodMs;
      if (next < now - periodMs * 5) next = now;
      if (!stopped) timer = setTimeout(loop, Math.max(0, next - now));
    }
  };
  timer = setTimeout(loop, periodMs);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

export class WorldRunner {
  failed: string | null = null;
  ticks = 0;
  private durs = new Float64Array(300);
  private durN = 0;
  private acc = 0;
  private errRun = 0;
  private stops: Array<() => void> = [];
  lastSnap: any = null;

  readonly world: WorldLike;
  readonly kind: 'sim' | 'fake';
  private bus: Bus;
  private cfg: Config;
  constructor(world: WorldLike, kind: 'sim' | 'fake', bus: Bus, cfg: Config) { this.world = world; this.kind = kind; this.bus = bus; this.cfg = cfg; }

  start() {
    if (this.stops.length) return;
    const dt = 1 / this.cfg.tickHz;
    this.stops.push(every(1000 / this.cfg.tickHz, () => this.tick(dt)));
    this.stops.push(every(1000 / this.cfg.snapHz, () => this.snap()));
  }

  stop() { for (const s of this.stops) s(); this.stops = []; }

  private tick(dt: number) {
    if (this.failed) return;
    const t0 = performance.now();
    this.acc += this.cfg.timeScale;
    const n = Math.floor(this.acc);
    this.acc -= n;
    try {
      for (let i = 0; i < n; i++) this.world.step(dt);
      this.errRun = 0;
    } catch (err) {
      if (this.errRun % 100 === 0) this.bus.emit('log', { lv: 'err', msg: `world.step failed: ${(err as Error).message}`, t: this.world.T });
      if (++this.errRun >= 50) { this.failed = (err as Error).message; }
    }
    this.ticks++;
    this.durs[this.durN++ % this.durs.length] = performance.now() - t0;
  }

  private snap() {
    try {
      this.lastSnap = this.world.snapshot();
      this.bus.emit('snap', { snap: this.lastSnap, wallMs: Date.now() });
    } catch (err) {
      this.bus.emit('log', { lv: 'err', msg: `world.snapshot failed: ${(err as Error).message}`, t: this.world.T });
    }
  }

  tickMs(): { p50: number; p95: number } {
    const k = Math.min(this.durN, this.durs.length);
    if (!k) return { p50: 0, p95: 0 };
    const a = Array.from(this.durs.subarray(0, k)).sort((x, y) => x - y);
    const q = (p: number) => Math.round(a[Math.min(k - 1, Math.floor(p * k))] * 1000) / 1000;
    return { p50: q(0.5), p95: q(0.95) };
  }
}
