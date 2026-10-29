// Applies server/db/schema.sql (idempotent). Usage: npm run db:migrate
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}

const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(sql); // simple protocol: multi-statement script in one call
  const { rows } = await client.query(
    `SELECT extname, extversion FROM pg_extension WHERE extname IN ('postgis', 'timescaledb') ORDER BY extname`,
  );
  console.log('migrate ok:', rows.map(r => `${r.extname} ${r.extversion}`).join(', '));
} finally {
  await client.end();
}
