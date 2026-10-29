// Loads sites into the DB (idempotent upserts). Usage: npm run db:load [-- --site <id>]
// No --site: every site of sites.js that has an export file. Needs: npm run db:migrate, and
// `node tools/export-site.mjs --site <id>` (tools/.cache/site-export-<id>.json; the legacy site-export.json counts for 'cac').
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { makeFrames, SC } from '../../sim-core.js';
import { SITES } from '../../sites.js';
import { cityFromFile, readExport } from '../src/site.ts';
import type { SiteReg } from '../src/site.ts';

const ROOT = new URL('../../', import.meta.url);
const NFZ_POINTS = 64;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (copy .env.example to .env)');
  process.exit(1);
}

const argI = process.argv.indexOf('--site');
const only = argI > 0 ? process.argv[argI + 1] : null;
if (argI > 0 && (!only || !(only in SITES))) {
  console.error(`unknown site '${only}' (sites.js: ${Object.keys(SITES).join(', ')})`);
  process.exit(1);
}
const ids = only ? [only] : Object.keys(SITES);

const client = new pg.Client({ connectionString: url });
await client.connect();
let loaded = 0;
try {
  for (const id of ids) {
    const reg = (SITES as unknown as Record<string, SiteReg>)[id];
    const exp = await readExport(id);
    if (!exp) {
      const msg = `skip ${id}: tools/.cache/site-export-${id}.json missing (run \`node tools/export-site.mjs --site ${id}\`)`;
      if (only) { console.error(msg); process.exitCode = 1; } else console.log(msg);
      continue;
    }
    await loadOne(id, reg, exp);
    loaded++;
  }
  if (!loaded) process.exitCode = 1;
} finally {
  await client.end();
}

async function loadOne(id: string, reg: SiteReg, exp: any) {
  const city = await cityFromFile(reg);
  if (!city) throw new Error(`window.CITY not found in ${reg.city}`);
  const shapesJs = await readFile(new URL(reg.shapes, ROOT));
  const hmGz = Buffer.from(exp.hm_gzip_b64, 'base64');
  if (exp.city.n !== city.n || exp.city.cell !== city.cell || exp.city.theta !== city.theta) {
    throw new Error(`export of ${id} does not match ${reg.city}: re-run tools/export-site.mjs --site ${id}`);
  }

  // NFZ-A: circle (scene units) -> 64-point WGS84 polygon; radius, ceiling and label come from the export (the page's obstacles)
  const nfz = exp.nfzA as { x: number; z: number; r: number; h: number; name: string; label: string } | null;
  if (!nfz) throw new Error(`export of ${id} has no nfzA`);
  const { sceneToGeo } = makeFrames(city);
  const ring: string[] = [];
  for (let k = 0; k < NFZ_POINTS; k++) {
    const a = (k / NFZ_POINTS) * Math.PI * 2;
    const [lat, lon] = sceneToGeo(nfz.x + Math.cos(a) * nfz.r, nfz.z + Math.sin(a) * nfz.r);
    ring.push(`${lon} ${lat}`);
  }
  ring.push(ring[0]);
  const wkt = `POLYGON((${ring.join(', ')}))`;

  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO sites (id, name, origin_lat, origin_lon, theta_deg, cell_m, grid_n, sc, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, origin_lat = EXCLUDED.origin_lat, origin_lon = EXCLUDED.origin_lon,
         theta_deg = EXCLUDED.theta_deg, cell_m = EXCLUDED.cell_m, grid_n = EXCLUDED.grid_n, sc = EXCLUDED.sc, meta = EXCLUDED.meta`,
      [id, reg.name, city.origin[0], city.origin[1], city.theta, city.cell, city.n, SC,
        JSON.stringify({ base: city.base, short: reg.short, shapesGlobal: reg.shapesGlobal, exportedAt: exp.exportedAt, sourceCommit: exp.sourceCommit })],
    );

    const upsertLayer = (kind: string, contentType: string, data: Buffer | null, json: unknown) =>
      client.query(
        `INSERT INTO site_layers (site_id, kind, content_type, data, json, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (site_id, kind) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data,
           json = EXCLUDED.json, updated_at = now()`,
        [id, kind, contentType, data, json === null ? null : JSON.stringify(json)],
      );
    await upsertLayer('city', 'application/json', null, city);
    await upsertLayer('cac_js', 'application/javascript', shapesJs, null);     // kind name kept for compatibility: holds the site's shapes script
    await upsertLayer('height_map', 'application/octet-stream+gzip', hmGz, { n: city.n, cell: city.cell, units: 'scene' });
    await upsertLayer('landmarks', 'application/json', null, exp.landmarks);

    await client.query(
      `INSERT INTO no_fly_zones (site_id, name, label, floor_m, ceiling_m, geom)
       VALUES ($1, $2, $3, 0, $4, ST_SetSRID(ST_GeomFromText($5), 4326))
       ON CONFLICT (site_id, name) DO UPDATE SET label = EXCLUDED.label, floor_m = EXCLUDED.floor_m,
         ceiling_m = EXCLUDED.ceiling_m, geom = EXCLUDED.geom`,
      [id, nfz.name, nfz.label, nfz.h / SC, wkt], // 1 scene unit = 2 m -> metres = h / SC
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  console.log(`load ok: site ${id}, 4 layers (city, cac_js, height_map ${hmGz.length} B gz, landmarks ${exp.landmarks.length}), NFZ ${nfz.name} "${nfz.label}" r=${nfz.r} h=${nfz.h}`);
}
