// Loads site 'cac' into the DB (idempotent upserts). Usage: npm run db:load
// Needs: npm run db:migrate, and `node tools/export-site.mjs` (tools/.cache/site-export.json).
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { makeFrames, SC } from '../../sim-core.js';

const ROOT = new URL('../../', import.meta.url);
const SITE_ID = 'cac';
const SITE_NAME = 'Ciutat de les Arts i les Ciències';
const NFZ_POINTS = 64;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}

// assets/valencia-city.js: `window.CITY = {...};` -> parse the JSON object literal
const cityTxt = await readFile(new URL('assets/valencia-city.js', ROOT), 'utf8');
const m = /window\.CITY\s*=\s*/.exec(cityTxt);
if (!m) throw new Error('window.CITY not found in assets/valencia-city.js');
const start = m.index + m[0].length;
const city = JSON.parse(cityTxt.slice(start, cityTxt.lastIndexOf('}') + 1));

const cacJs = await readFile(new URL('cac-shapes.js', ROOT));

let exp;
try {
  exp = JSON.parse(await readFile(new URL('tools/.cache/site-export.json', ROOT), 'utf8'));
} catch {
  console.error('tools/.cache/site-export.json missing: run `node tools/export-site.mjs` first');
  process.exit(1);
}
const hmGz = Buffer.from(exp.hm_gzip_b64, 'base64');
if (exp.city.n !== city.n || exp.city.cell !== city.cell || exp.city.theta !== city.theta) {
  throw new Error('site-export.json does not match assets/valencia-city.js: re-run tools/export-site.mjs');
}

// NFZ-A: circle (scene units) -> 64-point WGS84 polygon
const nfz = exp.nfzA as { x: number; z: number; r: number; h: number; name: string; label: string };
const { sceneToGeo } = makeFrames(city);
const ring: string[] = [];
for (let k = 0; k < NFZ_POINTS; k++) {
  const a = (k / NFZ_POINTS) * Math.PI * 2;
  const [lat, lon] = sceneToGeo(nfz.x + Math.cos(a) * nfz.r, nfz.z + Math.sin(a) * nfz.r);
  ring.push(`${lon} ${lat}`);
}
ring.push(ring[0]);
const wkt = `POLYGON((${ring.join(', ')}))`;

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO sites (id, name, origin_lat, origin_lon, theta_deg, cell_m, grid_n, sc, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, origin_lat = EXCLUDED.origin_lat, origin_lon = EXCLUDED.origin_lon,
       theta_deg = EXCLUDED.theta_deg, cell_m = EXCLUDED.cell_m, grid_n = EXCLUDED.grid_n, sc = EXCLUDED.sc, meta = EXCLUDED.meta`,
    [SITE_ID, SITE_NAME, city.origin[0], city.origin[1], city.theta, city.cell, city.n, SC,
      JSON.stringify({ base: city.base, exportedAt: exp.exportedAt, sourceCommit: exp.sourceCommit })],
  );

  const upsertLayer = (kind: string, contentType: string, data: Buffer | null, json: unknown) =>
    client.query(
      `INSERT INTO site_layers (site_id, kind, content_type, data, json, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (site_id, kind) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data,
         json = EXCLUDED.json, updated_at = now()`,
      [SITE_ID, kind, contentType, data, json === null ? null : JSON.stringify(json)],
    );
  await upsertLayer('city', 'application/json', null, city);
  await upsertLayer('cac_js', 'application/javascript', cacJs, null);
  await upsertLayer('height_map', 'application/octet-stream+gzip', hmGz, { n: city.n, cell: city.cell, units: 'scene' });
  await upsertLayer('landmarks', 'application/json', null, exp.landmarks);

  await client.query(
    `INSERT INTO no_fly_zones (site_id, name, label, floor_m, ceiling_m, geom)
     VALUES ($1, $2, $3, 0, $4, ST_SetSRID(ST_GeomFromText($5), 4326))
     ON CONFLICT (site_id, name) DO UPDATE SET label = EXCLUDED.label, floor_m = EXCLUDED.floor_m,
       ceiling_m = EXCLUDED.ceiling_m, geom = EXCLUDED.geom`,
    [SITE_ID, nfz.name, nfz.label, nfz.h / SC, wkt], // 1 scene unit = 2 m -> metres = h / SC
  );
  await client.query('COMMIT');
  console.log(`load ok: site ${SITE_ID}, 4 layers (city, cac_js, height_map ${hmGz.length} B gz, landmarks), NFZ ${nfz.name}`);
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  await client.end();
}
