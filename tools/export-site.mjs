// One-off export of the derived site layers from the ORIGINAL frontend (Playwright).
// Samples __swarm.topAt over every cell centre of the CITY grid -> height map, dumps landmarks + NFZ-A.
// Output: tools/.cache/site-export-<id>.json (git-ignored).
// Usage: node tools/export-site.mjs [--site <id>] [--root DIR] [--port N]
//   --site: key of sites.js (default 'cac'); the page is opened as index.html?site=<id> and must report __swarm.site.id === id.
//   default root: the working tree (repo root). --root DIR serves another copy (e.g. a git archive of a commit).
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTerrain } from '../sim-core.js';
import { DEFAULT_SITE, SITES } from '../sites.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('--port', 8702));
const siteId = arg('--site', DEFAULT_SITE);
if (!SITES[siteId]) { console.error(`unknown site '${siteId}' (sites.js: ${Object.keys(SITES).join(', ')})`); process.exit(2); }
const root = resolve(arg('--root', repo));
const git = (...a) => { try { return execFileSync('git', ['-C', repo, ...a]).toString().trim(); } catch { return ''; } };
const sourceCommit = git('rev-parse', 'HEAD') + (git('status', '--porcelain') ? '+worktree' : '');

const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1000));

const browser = await chromium.launch({
  executablePath: '/home/bluongo/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/index.html?site=${encodeURIComponent(siteId)}&quality=low`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__swarm, null, { timeout: 180000, polling: 500 });
  const pageSite = await page.evaluate(() => window.__swarm.site?.id ?? null);
  if (pageSite !== siteId) {
    throw new Error(`page reports __swarm.site.id = ${JSON.stringify(pageSite)}, expected '${siteId}' (root ${root}: index.html without ?site= support?)`);
  }

  // cell centres in scene coords: same math as sim-core.js makeTerrain().cellCentre (computed in-page from CITY)
  const out = await page.evaluate(() => {
    const C = window.CITY, n = C.n, cell = C.cell, half = n * cell / 2, SC = 0.5;
    const th = C.theta * Math.PI / 180, ct = Math.cos(th), st = Math.sin(th);
    const hm = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const gu = (i + 0.5) * cell - half, gv = (j + 0.5) * cell - half;
      const dx = gu * ct - gv * st, dy = gu * st + gv * ct;
      hm[j * n + i] = window.__swarm.topAt(dx * SC, -dy * SC);
    }
    const u8 = new Uint8Array(hm.buffer);
    let bin = ''; for (let k = 0; k < u8.length; k += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
    const city = { origin: C.origin, base: C.base, theta: C.theta, cell: C.cell, n: C.n };
    const landmarks = window.__swarm.landmarks.map(({ mesh, ...l }) => l);
    const nfzA = window.__swarm.obstacles.find(o => o.type === 'NFZ' && o.name === 'NFZ-A') || null;   // {x,z,r,h,type,name,label}
    return { city, hm_b64: btoa(bin), landmarks, nfzA: nfzA && JSON.parse(JSON.stringify(nfzA)) };
  });
  if (errors.length) console.log('page errors:', errors);

  const hmBytes = Buffer.from(out.hm_b64, 'base64');
  const hm = new Float32Array(hmBytes.buffer, hmBytes.byteOffset, hmBytes.byteLength / 4);
  const { n } = out.city;
  if (hm.length !== n * n) throw new Error(`hm length ${hm.length} != ${n * n}`);
  let nonZero = 0; for (const v of hm) if (v !== 0) nonZero++;
  console.log(`site: ${siteId}, root: ${root}\ncells: ${hm.length}, non-zero: ${nonZero}, landmarks: ${out.landmarks.length}, nfzA: ${JSON.stringify(out.nfzA)}`);
  if (!out.nfzA) throw new Error('NFZ-A not found in __swarm.obstacles');

  // verify: browser topAt vs Node makeTerrain(city, hm).topAt on 2000 random points inside ±280 units
  const T = makeTerrain(out.city, hm);
  const pts = []; for (let k = 0; k < 2000; k++) pts.push([(Math.random() * 2 - 1) * 280, (Math.random() * 2 - 1) * 280]);
  const browserVals = await page.evaluate(p => p.map(([x, z]) => window.__swarm.topAt(x, z)), pts);
  let mismatch = 0, nz = 0;
  pts.forEach(([x, z], k) => { const a = browserVals[k], b = T.topAt(x, z); if (a !== b) mismatch++; if (a !== 0) nz++; });
  console.log(`verify: 2000 random points (${nz} non-zero), mismatches: ${mismatch}`);
  // cellCentre sanity: Node cell centres hit the same value as the stored cell
  let ccBad = 0;
  for (let k = 0; k < 500; k++) {
    const i = Math.floor(Math.random() * n), j = Math.floor(Math.random() * n);
    const [X, Z] = T.cellCentre(i, j);
    if (T.topAt(X, Z) !== hm[j * n + i]) ccBad++;
  }
  console.log(`verify: 500 random cellCentre round trips, mismatches: ${ccBad}`);
  if (mismatch || ccBad) throw new Error('height map verification failed');

  mkdirSync(resolve(repo, 'tools/.cache'), { recursive: true });
  const file = resolve(repo, `tools/.cache/site-export-${siteId}.json`);
  writeFileSync(file, JSON.stringify({
    siteId,
    city: out.city,
    hm_gzip_b64: gzipSync(hmBytes, { level: 9 }).toString('base64'),
    landmarks: out.landmarks,
    nfzA: out.nfzA,
    exportedAt: new Date().toISOString(),
    sourceCommit,
  }));
  console.log('wrote', file);
} finally {
  await browser.close();
  server.kill();
}
