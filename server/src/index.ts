// Server entry: wires config, DB, site, world, telemetry, live WS, ingest, REST. Run: npm run server
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { Bus } from './bus.ts';
import { loadConfig, originAllowed } from './config.ts';
import type { Config } from './config.ts';
import { createDb } from './db.ts';
import type { Db } from './db.ts';
import { loadSite } from './site.ts';
import type { Site } from './site.ts';
import { createWorld, WorldRunner } from './world.ts';
import type { AppCtx } from './world.ts';
import { ExtStore, registerIngest } from './ingest.ts';
import { TelemetryWriter } from './telemetry.ts';
import { registerLive } from './live.ts';
import { registerCors, registerRoutes } from './routes.ts';
import { registerMissions } from './missions.ts';
import { registerStatic } from './static.ts';

export interface BuildOpts { forceFake?: boolean; db?: Db | null }

export async function buildServer(cfg: Config, opts: BuildOpts = {}) {
  const app = Fastify({ logger: cfg.logLevel === 'silent' ? false : { level: cfg.logLevel }, bodyLimit: 256 * 1024 });
  const bus = new Bus();
  bus.onError = (err, ev) => app.log.error({ err, ev }, 'bus listener failed');

  const db = opts.db !== undefined ? opts.db
    : createDb(cfg.databaseUrl, (up, err) => app.log[up ? 'info' : 'warn']({ err }, up ? 'database up' : 'database down'));
  if (db) { await db.ping(); db.startMonitor(); }
  if (cfg.databaseUrl && !db?.up) app.log.warn({ err: db?.lastError }, 'database not reachable: running without persistence until it is');

  const site = await loadSite(cfg.siteId, db);
  if (!site) throw new Error(`site ${cfg.siteId} not found (no DB rows and no assets/valencia-city.js)`);
  app.log.info({ site: site.id, sources: site.sources }, 'site loaded');
  for (const w of site.warnings) app.log.warn(w);

  const { world, kind, note } = await createWorld(site, cfg, bus, { forceFake: opts.forceFake });
  if (note) app.log.warn(note);
  const runner = new WorldRunner(world, kind, bus, cfg);

  const sites = new Map<string, Site | null>([[site.id, site]]);
  const ctx: AppCtx = {
    cfg, db, bus, site, runner, world,
    ext: new ExtStore(cfg.extTtlMs),
    telemetry: new TelemetryWriter(db, site, cfg),
    missionSnapshot: () => null,
    getSite: async id => {
      if (sites.has(id)) return sites.get(id) ?? null;
      const s = db?.up ? await loadSite(id, db, false) : null;
      if (s) sites.set(id, s);                 // cache hits only, a later DB load can still succeed
      return s;
    },
    stats: { liveClients: 0, ingestClients: 0, lastSnapBytes: 0, lastSnapSeq: 0 },
  };

  registerCors(app, o => originAllowed(o, cfg));
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  await registerRoutes(app, ctx);
  await registerLive(app, ctx);
  await registerIngest(app, ctx);
  registerMissions(app, ctx);
  registerStatic(app);                              // dashboard at http://HOST:PORT/

  ctx.telemetry.start(bus);
  runner.start();
  app.addHook('onClose', async () => {
    runner.stop();
    await ctx.telemetry.stop();      // final flush
    if (opts.db === undefined) await db?.close();   // only close a pool we created
  });
  return { app, ctx };
}

async function main() {
  const cfg = loadConfig();
  const { app } = await buildServer(cfg);
  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ sig }, 'shutting down');
    try { await app.close(); } catch (err) { app.log.error(err); }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  await app.listen({ host: cfg.host, port: cfg.port });
  console.log(`\n  SWARM C2 server ready → open http://${cfg.host}:${cfg.port}/  (API: /api/health)\n`);
}

if (import.meta.main) {
  main().catch(err => { console.error(err); process.exit(1); });
}
