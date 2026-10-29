// Site loading: DB first (sites + site_layers + no_fly_zones), per-piece fallback to repo files, else zeros.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { endianness } from 'node:os';
import { makeFrames, makeTerrain } from '../../sim-core.js';
import type { Db } from './db.ts';

export interface City {
  origin: [number, number]; base: [number, number]; theta: number; cell: number; n: number;
  cover?: unknown; h?: string; c?: string; [k: string]: unknown;
}
export interface Landmark { id: string; code?: string; name?: string; x: number; z: number; r: number; h: number; nfz?: boolean; [k: string]: unknown }
export type Source = 'db' | 'file' | 'zeros' | 'none';
export interface Site {
  id: string;
  name: string;
  city: City;
  cityJson: string;                // pre-serialised CITY-compatible JSON
  hm: Float32Array;
  landmarks: Landmark[];
  nfz: { type: 'FeatureCollection'; features: any[] };
  cacJs: string | null;
  frames: ReturnType<typeof makeFrames>;
  terrain: ReturnType<typeof makeTerrain>;
  sources: { site: Source; city: Source; heightMap: Source; landmarks: Source; cacJs: Source; nfz: Source };
  warnings: string[];
}

const ROOT = new URL('../../', import.meta.url);

async function readText(rel: string): Promise<string | null> {
  try { return await readFile(new URL(rel, ROOT), 'utf8'); } catch { return null; }
}

async function cityFromFile(): Promise<City | null> {
  const txt = await readText('assets/valencia-city.js');
  const m = txt && /window\.CITY\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(txt.trim());
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function decodeFloat32(buf: Buffer, n: number): Float32Array | null {
  if (endianness() !== 'LE') return null;
  let raw = buf;
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);
  if (raw.length !== n * n * 4) return null;
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length) as ArrayBuffer;
  return new Float32Array(ab);
}

// tools/.cache/site-export.json (WP1): tolerant of key names, height map as base64 (gzip or raw) or number array
async function exportFromFile(n: number): Promise<{ hm: Float32Array | null; landmarks: Landmark[] | null }> {
  const txt = await readText('tools/.cache/site-export.json');
  if (!txt) return { hm: null, landmarks: null };
  try {
    const j = JSON.parse(txt);
    const raw = j.heightMap ?? j.height_map ?? j.hm ?? j.topAt ?? j.heights;
    let hm: Float32Array | null = null;
    if (typeof raw === 'string') hm = decodeFloat32(Buffer.from(raw, 'base64'), n);
    else if (Array.isArray(raw) && raw.length === n * n) hm = Float32Array.from(raw);
    const landmarks = Array.isArray(j.landmarks) ? j.landmarks : null;
    return { hm, landmarks };
  } catch { return { hm: null, landmarks: null }; }
}

export async function loadSite(id: string, db: Db | null, allowFallback = true): Promise<Site | null> {
  const warnings: string[] = [];
  const sources: Site['sources'] = { site: 'none', city: 'none', heightMap: 'none', landmarks: 'none', cacJs: 'none', nfz: 'none' };
  let name = id, city: City | null = null, hm: Float32Array | null = null, landmarks: Landmark[] | null = null;
  let cacJs: string | null = null, features: any[] | null = null, dbSite = false;

  if (db) {
    try {
      const s = await db.query('SELECT id, name, origin_lat, origin_lon, theta_deg, cell_m, grid_n, meta FROM sites WHERE id = $1', [id]);
      if (s.rows.length) {
        dbSite = true; sources.site = 'db'; name = s.rows[0].name;
        const layers = await db.query('SELECT kind, data, json FROM site_layers WHERE site_id = $1', [id]);
        const byKind = new Map<string, { data: Buffer | null; json: any }>(layers.rows.map((r: any) => [r.kind, r]));
        const lc = byKind.get('city')?.json;
        if (lc && lc.origin && lc.base) { city = lc; sources.city = 'db'; }
        const n = city?.n ?? Number(s.rows[0].grid_n);
        const lh = byKind.get('height_map')?.data;
        if (lh) {
          hm = decodeFloat32(lh, n);
          if (hm) sources.heightMap = 'db'; else warnings.push('db height_map has wrong size, ignored');
        }
        const ll = byKind.get('landmarks')?.json;
        if (Array.isArray(ll)) { landmarks = ll; sources.landmarks = 'db'; }
        const lj = byKind.get('cac_js');
        const txt = lj?.data ? lj.data.toString('utf8') : typeof lj?.json === 'string' ? lj.json : null;
        if (txt) { cacJs = txt; sources.cacJs = 'db'; }
        const z = await db.query(
          `SELECT id, name, label, floor_m, ceiling_m, ST_AsGeoJSON(geom)::json AS geometry FROM no_fly_zones WHERE site_id = $1 ORDER BY id`, [id]);
        if (z.rows.length) {
          features = z.rows.map((r: any) => ({
            type: 'Feature', geometry: r.geometry,
            properties: { id: r.id, name: r.name, label: r.label, floor_m: r.floor_m, ceiling_m: r.ceiling_m },
          }));
          sources.nfz = 'db';
        }
      }
    } catch (err) {
      warnings.push(`db load failed: ${(err as Error).message}`);
    }
  }
  if (!dbSite && !allowFallback) return null;

  if (!city) {
    city = await cityFromFile();
    if (!city) { warnings.push('no CITY (db or assets/valencia-city.js)'); return null; }
    sources.city = 'file';
  }
  const n = city.n;
  if (!hm || !landmarks) {
    const ex = await exportFromFile(n);
    if (!hm && ex.hm) { hm = ex.hm; sources.heightMap = 'file'; }
    if (!landmarks && ex.landmarks) { landmarks = ex.landmarks; sources.landmarks = 'file'; }
  }
  if (!hm) { hm = new Float32Array(n * n); sources.heightMap = 'zeros'; warnings.push('height map missing: using zeros (flat terrain)'); }
  if (!landmarks) { landmarks = []; warnings.push('landmarks missing: none loaded'); }
  if (!cacJs) {
    cacJs = await readText('cac-shapes.js');
    if (cacJs) sources.cacJs = 'file';
  }

  const frames = makeFrames(city);
  const terrain = makeTerrain(city, hm);
  return {
    id, name, city, cityJson: JSON.stringify(city), hm, landmarks,
    nfz: { type: 'FeatureCollection', features: features ?? [] },
    cacJs, frames, terrain, sources, warnings,
  };
}

// circle -> GeoJSON polygon (64 points), used when the DB has no NFZ rows
export function circleFeature(site: Site, o: { x: number; z: number; r: number; name?: string; label?: string; h?: number }, i: number) {
  const ring: number[][] = [];
  for (let k = 0; k <= 64; k++) {
    const a = (k % 64) / 64 * Math.PI * 2;
    const [lat, lon] = site.frames.sceneToGeo(o.x + Math.cos(a) * o.r, o.z + Math.sin(a) * o.r);
    ring.push([lon, lat]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { id: i, name: o.name ?? `NFZ-${i}`, label: o.label ?? null, floor_m: 0, ceiling_m: o.h != null ? o.h * 2 : null } };
}
