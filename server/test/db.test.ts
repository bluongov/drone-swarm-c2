// G1 DB checks. Needs the DB up + `npm run db:migrate`, `node tools/export-site.mjs --site cac|levante`, `npm run db:load`.
// Run: node --env-file-if-exists=.env --test server/test/db.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import { SITES } from '../../sites.js';
import { readExport } from '../src/site.ts';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
before(() => client.connect());
after(() => client.end());

const SITE_IDS = ['cac', 'levante'];

for (const id of SITE_IDS) {
  test(`site ${id} has 4 layers and a sites row named after the registry`, async () => {
    const { rows } = await client.query(`SELECT kind FROM site_layers WHERE site_id = $1 ORDER BY kind`, [id]);
    assert.deepEqual(rows.map(r => r.kind), ['cac_js', 'city', 'height_map', 'landmarks']);
    const s = await client.query(`SELECT name FROM sites WHERE id = $1`, [id]);
    assert.equal(s.rows[0].name, SITES[id as keyof typeof SITES].name);
    const js = await client.query(`SELECT convert_from(data, 'UTF8') AS txt FROM site_layers WHERE site_id = $1 AND kind = 'cac_js'`, [id]);
    assert.match(js.rows[0].txt, new RegExp(`window\\.${SITES[id as keyof typeof SITES].shapesGlobal}\\b`));
  });

  test(`site ${id}: one NFZ-A polygon, valid, 65 points, label/ceiling from the export`, async () => {
    const exp = await readExport(id);
    assert.ok(exp, `tools/.cache/site-export-${id}.json missing`);
    const { rows } = await client.query(`SELECT name, label, ceiling_m, ST_IsValid(geom) AS valid, ST_NPoints(geom) AS np FROM no_fly_zones WHERE site_id = $1`, [id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'NFZ-A'); assert.equal(rows[0].label, exp.nfzA.label);
    assert.equal(rows[0].valid, true); assert.equal(rows[0].np, 65);
    assert.equal(rows[0].ceiling_m, exp.nfzA.h / 0.5);
  });

  test(`site ${id}: height map in DB equals the export byte for byte`, async () => {
    const exp = await readExport(id);
    assert.ok(exp, `tools/.cache/site-export-${id}.json missing`);
    const want = gunzipSync(Buffer.from(exp.hm_gzip_b64, 'base64'));
    const { rows } = await client.query(`SELECT data FROM site_layers WHERE site_id = $1 AND kind = 'height_map'`, [id]);
    const got = gunzipSync(rows[0].data);
    assert.equal(got.length, exp.city.n * exp.city.n * 4);
    assert.ok(got.equals(want));
  });
}

test('levante: 8 landmarks (EST ARE OFI TOR MET PAR CMP PRC), only EST is the NFZ, label ESTADI...', async () => {
  const { rows } = await client.query(`SELECT json FROM site_layers WHERE site_id = 'levante' AND kind = 'landmarks'`);
  const lms = rows[0].json as any[];
  assert.deepEqual(lms.map(l => l.code).sort(), ['ARE', 'CMP', 'EST', 'MET', 'OFI', 'PAR', 'PRC', 'TOR']);
  assert.deepEqual(lms.filter(l => l.nfz).map(l => l.code), ['EST']);
  assert.ok(lms.every(l => !('mesh' in l)));
  const z = await client.query(`SELECT label FROM no_fly_zones WHERE site_id = 'levante'`);
  assert.match(z.rows[0].label, /^ESTADI/);
});

test('telemetry is a hypertable', async () => {
  const { rows } = await client.query(`SELECT hypertable_name FROM timescaledb_information.hypertables`);
  assert.ok(rows.some(r => r.hypertable_name === 'telemetry'));
});
