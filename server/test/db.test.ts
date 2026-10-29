// G1 DB checks. Needs the DB up + `npm run db:migrate`, `node tools/export-site.mjs`, `npm run db:load`.
// Run: node --env-file-if-exists=.env --test server/test/db.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
before(() => client.connect());
after(() => client.end());

test('site cac has 4 layers', async () => {
  const { rows } = await client.query(`SELECT kind FROM site_layers WHERE site_id = 'cac' ORDER BY kind`);
  assert.deepEqual(rows.map(r => r.kind), ['cac_js', 'city', 'height_map', 'landmarks']);
});

test('NFZ polygons are valid', async () => {
  const { rows } = await client.query(`SELECT name, ST_IsValid(geom) AS valid, ST_NPoints(geom) AS np, ceiling_m FROM no_fly_zones`);
  assert.ok(rows.length >= 1);
  for (const r of rows) { assert.equal(r.valid, true); assert.equal(r.np, 65); }
});

test('telemetry is a hypertable', async () => {
  const { rows } = await client.query(`SELECT hypertable_name FROM timescaledb_information.hypertables`);
  assert.ok(rows.some(r => r.hypertable_name === 'telemetry'));
});

test('height map in DB equals the export byte for byte', async () => {
  const exp = JSON.parse(await readFile(new URL('../../tools/.cache/site-export.json', import.meta.url), 'utf8'));
  const want = gunzipSync(Buffer.from(exp.hm_gzip_b64, 'base64'));
  const { rows } = await client.query(`SELECT data FROM site_layers WHERE site_id = 'cac' AND kind = 'height_map'`);
  const got = gunzipSync(rows[0].data);
  assert.equal(got.length, exp.city.n * exp.city.n * 4);
  assert.ok(got.equals(want));
});
