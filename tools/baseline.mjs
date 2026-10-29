// tools/baseline.mjs · behaviour statistics of the swarm sim in a real page (headless Chromium, warp, no real-time waits).
// Usage: node tools/baseline.mjs --url http://127.0.0.1:8701/index.html --out server/test/golden.json [--runs 5] [--only S1,S2] [--par 3]
// Scenarios: plan §5 (S1-S6). Metrics: tools/metrics.mjs.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { sampleMetrics, aggregate, summarize } from './metrics.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const URL0 = arg('url', 'http://127.0.0.1:8701/index.html');
const OUT = arg('out', 'server/test/golden.json');
const RUNS = +arg('runs', 5), PAR = +arg('par', 3), ONLY = arg('only', '');
const EXTRA = arg('extra', '');            // extra query string, e.g. "seed=3"
const CHROME = process.env.CHROME || '/home/bluongo/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';

import { SCENARIOS_DEF } from './scenarios.mjs';
export const SCENARIOS = SCENARIOS_DEF;
const WARM = 20, EVERY = 5;

async function runOnce(browser, name, sc) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const url = `${URL0}?quality=low&drones=${sc.drones}${EXTRA ? '&' + EXTRA : ''}`;
  await page.goto(url);
  await page.waitForFunction(() => window.__swarm && window.__swarm.drones().length > 0, null, { timeout: 180000 });
  await page.evaluate(cmds => { for (const c of cmds) window.__swarm.runCmd(c); }, sc.cmds);
  const obstacles = await page.evaluate(() => window.__swarm.obstacles.map(o => ({ x: o.x, z: o.z, r: o.r, h: o.h, type: o.type })));
  const samples = [];
  await page.evaluate(w => window.__swarm.warp(w), WARM);
  for (let t = WARM; t < sc.sec; t += EVERY) {
    const ds = await page.evaluate(w => {
      const S = window.__swarm; S.warp(w);
      return S.drones().map(d => ({ pos: { x: d.pos.x, y: d.pos.y, z: d.pos.z }, vel: { x: d.vel.x, y: d.vel.y, z: d.vel.z }, state: d.state,
        hostile: !!d.sw.hostile, swarm: d.sw.key, target: !!d.target, top: S.topAt(d.pos.x, d.pos.z) }));
    }, EVERY);
    samples.push(sampleMetrics(ds, null, obstacles));
  }
  await page.close();
  if (errors.length) throw new Error(`${name}: page errors: ${errors.join(' | ')}`);
  return aggregate(samples);
}

const names = Object.keys(SCENARIOS).filter(n => !ONLY || ONLY.split(',').includes(n));
const jobs = names.flatMap(n => Array.from({ length: RUNS }, (_, r) => ({ n, r })));
const results = Object.fromEntries(names.map(n => [n, []]));
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const t0 = Date.now();
let next = 0;
await Promise.all(Array.from({ length: PAR }, async () => {
  while (next < jobs.length) {
    const { n, r } = jobs[next++];
    const res = await runOnce(browser, n, SCENARIOS[n]);
    results[n].push(res);
    console.log(`${n} run ${r + 1}/${RUNS} (${((Date.now() - t0) / 1000).toFixed(0)} s)`, JSON.stringify(res));
  }
}));
await browser.close();
const out = { url: URL0, extra: EXTRA, runs: RUNS, warm: WARM, every: EVERY, createdAt: new Date().toISOString(), scenarios: {} };
for (const n of names) out.scenarios[n] = { ...SCENARIOS[n], ...summarize(results[n]) };
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('wrote', OUT);
