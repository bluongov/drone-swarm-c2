// Runtime configuration from environment variables (see .env.example). No secrets are logged.

export interface Config {
  host: string;
  port: number;
  databaseUrl: string | undefined;
  siteId: string;
  seed: number;
  drones: number;
  tickHz: number;
  snapHz: number;
  persistHz: number;      // sim drone telemetry persist rate per drone (0 = off)
  timeScale: number;      // sim steps per tick (fast tests); 1 = real time
  logLevel: string;       // fastify/pino level, or 'silent'
  allowedOrigins: string[]; // extra browser origins allowed for WS and non-GET CORS (localhost always allowed)
  extTtlMs: number;       // external drone is dropped from snaps after this much silence
  maxQueueRows: number;   // telemetry queue bound; oldest rows are dropped above this
}

function num(v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export function loadConfig(env: Record<string, string | undefined> = process.env, over: Partial<Config> = {}): Config {
  const cfg: Config = {
    host: env.HOST || '127.0.0.1',
    port: Math.round(num(env.PORT, 3000, 0, 65535)),
    databaseUrl: env.DATABASE_URL || undefined,
    siteId: env.SITE_ID || 'cac',
    seed: Math.round(num(env.SIM_SEED, 1, 0, 2 ** 32 - 1)),
    drones: Math.round(num(env.SIM_DRONES, 60, 0, 150)),
    tickHz: num(env.TICK_HZ, 30, 1, 240),
    snapHz: num(env.SNAP_HZ, 10, 1, 60),
    persistHz: num(env.TELEMETRY_PERSIST_HZ, 1, 0, 30),
    timeScale: num(env.WORLD_TIME_SCALE, 1, 0.01, 1000),
    logLevel: env.LOG_LEVEL || 'info',
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    extTtlMs: 10_000,
    maxQueueRows: 50_000,
  };
  return { ...cfg, ...over };
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

// Browser origins that may open WebSockets or send non-GET requests. No Origin header (curl, node, drones) is allowed.
export function originAllowed(origin: string | undefined, cfg: Pick<Config, 'allowedOrigins'>): boolean {
  if (!origin) return true;
  return LOCAL_ORIGIN.test(origin) || cfg.allowedOrigins.includes(origin);
}
