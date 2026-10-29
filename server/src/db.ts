// PostgreSQL pool with a cheap up/down flag. The server keeps running when the DB is down.
import pg from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';

export interface Db {
  readonly up: boolean;                 // last known state (ping or last query)
  readonly lastError: string | null;
  query<R extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<QueryResult<R>>;
  ping(): Promise<boolean>;
  markUp(): void;
  markDown(err: unknown): void;
  startMonitor(everyMs?: number): void;
  close(): Promise<void>;
}

export function createDb(url: string | undefined, onChange?: (up: boolean, err?: string) => void): Db | null {
  if (!url) return null;
  const pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 2000, idleTimeoutMillis: 30_000, statement_timeout: 10_000 });
  pool.on('error', err => db.markDown(err));   // idle client errors must not crash the process
  let up = false, lastError: string | null = null, timer: NodeJS.Timeout | undefined, closed = false;

  const set = (v: boolean, err?: string) => {
    const changed = v !== up;
    up = v; lastError = v ? null : (err ?? lastError);
    if (changed) onChange?.(v, err);
  };

  const db: Db = {
    get up() { return up; },
    get lastError() { return lastError; },
    async query(text, params) {
      try {
        const r = await pool.query(text, params as any[]);
        set(true);
        return r;
      } catch (err) {
        // connection-level failures flip the flag; SQL errors (bad schema etc.) do not
        const code = (err as any)?.code as string | undefined;
        if (!code || /^(ECONN|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EPIPE|57P|08)/.test(code)) set(false, (err as Error).message);
        throw err;
      }
    },
    async ping() {
      try { await pool.query('SELECT 1'); set(true); return true; }
      catch (err) { set(false, (err as Error).message); return false; }
    },
    markUp() { set(true); },
    markDown(err) { set(false, (err as Error)?.message ?? String(err)); },
    startMonitor(everyMs = 5000) {
      if (timer || closed) return;
      timer = setInterval(() => { void db.ping(); }, everyMs);
      timer.unref();
    },
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await pool.end().catch(() => {});
    },
  };
  return db;
}
