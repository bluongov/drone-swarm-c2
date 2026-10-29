// tools/node-baseline.mjs · same scenarios and metrics as tools/baseline.mjs, but on the SERVER side:
// SimWorld from sim-core.js in Node, terrain/landmarks from tools/.cache/site-export.json (tools/export-site.mjs).
// Proves the server flocking behaves like the browser demo (compare with tools/compare.mjs against golden.json).
// Usage: node tools/node-baseline.mjs --out docs/reports/node-baseline.json [--runs 5] [--only S1,S2]
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { SimWorld, makeTerrain } from '../sim-core.js';
import { sampleMetrics, aggregate, summarize } from './metrics.mjs';
import { SCENARIOS_DEF as SC } from './scenarios.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg('out', 'docs/reports/node-baseline.json'), RUNS = +arg('runs', 5), ONLY = arg('only', '');
const ex = JSON.parse(readFileSync(new URL('./.cache/site-export.json', import.meta.url)));
const buf = gunzipSync(Buffer.from(ex.hm_gzip_b64, 'base64'));
const hm = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const terrain = makeTerrain(ex.city, hm);
const WARM = 20, EVERY = 5, DT = 0.05;      // same as __swarm.warp()

function runOnce(sc, seed) {
  const world = new SimWorld({ topAt: terrain.topAt, topNear: terrain.topNear, landmarks: ex.landmarks, seed, n: sc.drones });
  for (const c of sc.cmds) { const [name, ...a] = c.split('='); world.applyCommand({ name, args: a }); }
  const step = sec => { for (let t = 0; t < sec; t += DT) world.step(DT); };
  step(WARM);
  const samples = [];
  for (let t = WARM; t < sc.sec; t += EVERY) {
    step(EVERY);
    samples.push(sampleMetrics(world.drones.map(d => ({ pos: d.pos, vel: d.vel, state: d.state, hostile: !!d.sw.hostile, swarm: d.sw.key, target: !!d.target })),
      terrain.topAt, world.obstacles));
  }
  return aggregate(samples);
}
const out = { source: 'node SimWorld', runs: RUNS, warm: WARM, every: EVERY, createdAt: new Date().toISOString(), scenarios: {} };
for (const [n, sc] of Object.entries(SC)) {
  if (ONLY && !ONLY.split(',').includes(n)) continue;
  const runs = [];
  for (let r = 0; r < RUNS; r++) { const t0 = Date.now(); runs.push(runOnce(sc, 1000 + r)); console.log(n, r + 1, `${Date.now() - t0} ms`, JSON.stringify(runs.at(-1))); }
  out.scenarios[n] = { ...sc, ...summarize(runs) };
}
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('wrote', OUT);
