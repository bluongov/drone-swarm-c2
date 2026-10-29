// tools/parity.mjs · refactor / determinism checks (plan G2b). Three comparisons, same seed 7, 60 drones:
//   A  ORIGINAL index.html (git HEAD) vs the refactored page, same Chromium. The page's rand()/pick() (and the core's randomness in the
//      refactor, the geofence Math.random in the original) are redirected to one shared mulberry32(seed) stream by textual patches
//      of the two test copies (three.js itself keeps using Math.random for uuids). Must be BIT-IDENTICAL: proves the extraction kept
//      the order of operations and of random draws.
//   B  refactored page world (?seed=N) vs a SimWorld built from sim-core.js INSIDE the same page → bit-identical (index.html adds nothing).
//   C  refactored page world vs a SimWorld in Node, fixed dt = TICK_DT. Chromium and Node ship different libm (sin/cos/atan2/exp differ
//      by 1 ulp for ~3 % of inputs), so tiny differences grow chaotically: the target <= 1e-6 can only hold for the first ~20 s.
//      C is a hard check at 15 s (<= TOL) and informational for the longer horizons.
// Usage: node tools/parity.mjs [--root .] [--port 8703] [--seed 7] [--drones 60] [--tol 1e-6] [--only A,B,C]
// Serves --root (port) and a temp copy of the git HEAD index.html (port+1) with `python3 -m http.server` on 127.0.0.1; stops them at the end.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SimWorld, makeTerrain, makeFrames, TICK_DT } from '../sim-core.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = resolve(arg('root', new URL('..', import.meta.url).pathname)), PORT = +arg('port', 8703);
const SEED = +arg('seed', 7), N = +arg('drones', 60), TOL = +arg('tol', 1e-6), ONLY = arg('only', 'A,B,C').split(',');
const CHROME = process.env.CHROME || '/home/bluongo/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];
for (const port of [PORT, PORT + 1, PORT + 2]) {      // a stale server would silently serve the wrong page
  if (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) { console.error(`port ${port} already in use`); process.exit(2); }
}
const serve = (dir, port) => { procs.push(spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore' })); };
const tmps = [];
const REPO = new URL('..', import.meta.url).pathname;
const patch = (src, edits) => { for (const [a, b] of edits) { if (!src.includes(a)) throw new Error('patch target not found: ' + a); src = src.replace(a, b); } return src; };
const SHARED = [['const rand = (a, b) => a + Math.random() * (b - a);', 'const rand = (a, b) => a + window.__mb() * (b - a);'],
                ['const pick = a => a[Math.floor(Math.random() * a.length)];', 'const pick = a => a[Math.floor(window.__mb() * a.length)];']];
function testCopy(html, edits, port) {            // a temp dir with a patched index.html next to the shared assets
  const d = mkdtempSync(join(tmpdir(), 'parity-')); tmps.push(d);
  writeFileSync(join(d, 'index.html'), patch(html, [...SHARED, ...edits]));
  for (const f of ['assets', 'cac-shapes.js', 'sim-core.js']) symlinkSync(join(REPO, f), join(d, f));
  serve(d, port);
}
if (ONLY.includes('A')) {
  testCopy(execFileSync('git', ['show', 'HEAD:index.html'], { cwd: REPO, maxBuffer: 1 << 28 }).toString(),
    [["if (Math.random() < 0.5) log('warn', `GEOFENCE:", "if (window.__mb() < 0.5) log('warn', `GEOFENCE:"]], PORT + 1);
  testCopy(readFileSync(join(ROOT, 'index.html'), 'utf8'), [['seed: SEED, n: N', 'rand: window.__mb, n: N']], PORT + 2);
}
serve(ROOT, PORT);
await sleep(900);

const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const results = [];
async function newPage(url, { patchRandom } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
  // freeze the page's own animation loop: only explicit warp calls advance the page world
  await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
  if (patchRandom != null) await page.addInitScript(seed => {
    let a = seed >>> 0;                                   // mulberry32, same as sim-core.js
    window.__mb = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }, patchRandom);
  await page.goto(url);
  await page.waitForFunction(() => window.__swarm && window.__swarm.drones().length > 0, null, { timeout: 240000 });
  return page;
}
const GRAB = () => window.__swarm.drones().map(d => [d.pos.x, d.pos.y, d.pos.z, d.vel.x, d.vel.y, d.vel.z, d.battery, d.link, d.temp, d.state, d.sw.key]);
function diff(a, b) {
  if (a.length !== b.length) return { count: [a.length, b.length] };
  let pos = 0, vel = 0, oth = 0, st = 0;
  a.forEach((p, i) => {
    const q = b[i];
    for (let k = 0; k < 3; k++) pos = Math.max(pos, Math.abs(p[k] - q[k]));
    for (let k = 3; k < 6; k++) vel = Math.max(vel, Math.abs(p[k] - q[k]));
    for (let k = 6; k < 9; k++) oth = Math.max(oth, Math.abs(p[k] - q[k]));
    if (p[9] !== q[9] || p[10] !== q[10]) st++;
  });
  return { n: a.length, maxPos: pos, maxVel: vel, maxBatLinkTemp: oth, stateMismatch: st };
}
function report(label, d, extra, ok) {
  results.push({ label, ok });
  console.log(`${ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL'} ${label} ${JSON.stringify(d)}${extra ? ' ' + extra : ''}`);
}
const exact = d => !d.count && d.maxPos === 0 && d.maxVel === 0 && d.maxBatLinkTemp === 0 && d.stateMismatch === 0;

// ---------------- A: original vs refactored (same engine, same Math.random stream) ----------------
if (ONLY.includes('A')) {
  console.log('--- A: original index.html (git HEAD) vs refactored index.html, rand/pick = shared mulberry32(' + SEED + ') stream in both');
  const po = await newPage(`http://127.0.0.1:${PORT + 1}/index.html?drones=${N}&quality=low`, { patchRandom: SEED });
  const pn = await newPage(`http://127.0.0.1:${PORT + 2}/index.html?drones=${N}&quality=low`, { patchRandom: SEED });
  const both = async fn => { await po.evaluate(fn); await pn.evaluate(fn); };
  const chk = async label => { const d = diff(await po.evaluate(GRAB), await pn.evaluate(GRAB)); report(label, d, '', exact(d)); };
  await chk('A t=0');
  await both(() => window.__swarm.warp(60));
  await chk('A t=60 PATROL (incl. auto-tasking at 50 s)');
  await both(() => window.__swarm.runCmd('mode=orbit'));
  await both(() => window.__swarm.warp(30));
  await chk('A t=90 after mode=orbit');
  await both(() => { window.__swarm.runCmd('swarm2=12'); window.__swarm.runCmd('role=hostile'); });
  await both(() => window.__swarm.warp(40));
  await chk('A t=130 after swarm2=12 + role=hostile (intercepts, geofence breaches)');
  await both(() => { window.__swarm.runCmd('role=friendly'); window.__swarm.runCmd('drones=40'); window.__swarm.runCmd('mode=formation'); });
  await both(() => window.__swarm.warp(30));
  await chk('A t=160 after role=friendly, drones=40, mode=formation');
  await po.close(); await pn.close();
}

// ---------------- B / C: seeded page world vs pure core (in page, in Node) ----------------
if (ONLY.includes('B') || ONLY.includes('C')) {
  const page = await newPage(`http://127.0.0.1:${PORT}/index.html?seed=${SEED}&drones=${N}&quality=low`);
  const input = await page.evaluate(() => {
    const S = window.__swarm, c = S.city;
    return { city: { origin: c.origin, base: c.base, theta: c.theta, cell: c.cell, n: c.n }, hm: Array.from(S.hm),
      landmarks: S.landmarks.map(l => ({ id: l.id, code: l.code, name: l.name, x: l.x, z: l.z, r: l.r, h: l.h, nfz: l.nfz })) };
  });
  const terr = makeTerrain(input.city, Float32Array.from(input.hm));
  const nodeLogs = [];
  const nodeWorld = new SimWorld({ topAt: terr.topAt, topNear: terr.topNear, landmarks: input.landmarks, seed: SEED, n: N, sceneToGeo: makeFrames(input.city).sceneToGeo, hooks: { log: (lv, m) => nodeLogs.push(lv + ' ' + m) } });
  nodeWorld.step(0);   // the page's first frame() ran simStep(0) (THREE.Clock returns 0 on its first call); replicate it
  nodeLogs.length = 0;
  // pure core inside the same page (same engine as the page world)
  await page.evaluate(async ({ input, SEED, N }) => {
    const { SimWorld, makeTerrain, makeFrames } = await import('./sim-core.js');
    const t = makeTerrain(input.city, Float32Array.from(input.hm));
    const logs = [];
    const w = new SimWorld({ topAt: t.topAt, topNear: t.topNear, landmarks: input.landmarks, seed: SEED, n: N, sceneToGeo: makeFrames(input.city).sceneToGeo, hooks: { log: (lv, m) => logs.push(lv + ' ' + m) } });
    w.step(0); logs.length = 0; window.__pure = w; window.__pureLogs = logs;
    const pw = window.__swarm.world, o = pw.hooks.log; window.__logs = [];
    pw.hooks.log = (lv, m) => { window.__logs.push(lv + ' ' + m); o(lv, m); };
  }, { input, SEED, N });
  const grabPure = () => window.__pure.drones.map(d => [d.pos.x, d.pos.y, d.pos.z, d.vel.x, d.vel.y, d.vel.z, d.battery, d.link, d.temp, d.state, d.sw.key]);
  const snapNode = () => nodeWorld.drones.map(d => [d.pos.x, d.pos.y, d.pos.z, d.vel.x, d.vel.y, d.vel.z, d.battery, d.link, d.temp, d.state, d.sw.key]);
  const act = async (name, args) => {     // same action on the three worlds
    await page.evaluate(([n, a]) => { window.__swarm.world.applyCommand({ name: n, args: a }); window.__pure.applyCommand({ name: n, args: a }); }, [name, args]);
    nodeWorld.applyCommand({ name, args });
  };
  const run = async sec => {
    await page.evaluate(([s, dt]) => { window.__swarm.warpFixed(s, dt); const n = Math.round(s / dt); for (let i = 0; i < n; i++) window.__pure.step(dt); }, [sec, TICK_DT]);
    const n = Math.round(sec / TICK_DT); for (let i = 0; i < n; i++) nodeWorld.step(TICK_DT);
  };
  const logsEq = async (a, b) => { const x = await page.evaluate(k => window[k].slice(), a), y = b ? await page.evaluate(k => window[k].slice(), b) : nodeLogs; return x.length === y.length && x.every((l, i) => l === y[i]) ? `logs identical (${x.length})` : `logs DIFFER (${x.length} vs ${y.length})`; };
  const chk = async (label, hard) => {
    if (ONLY.includes('B')) {
      const d = diff(await page.evaluate(GRAB), await page.evaluate(grabPure)); const l = await logsEq('__logs', '__pureLogs');
      report(`B ${label} page world vs pure core in page`, d, l, exact(d) && l.startsWith('logs identical'));
    }
    if (ONLY.includes('C')) {
      const d = diff(await page.evaluate(GRAB), snapNode());
      report(`C ${label} page world vs Node`, d, await logsEq('__logs'), hard ? !d.count && d.maxPos <= TOL && d.maxVel <= TOL && d.stateMismatch === 0 : null);
    }
  };
  console.log('--- B/C: seeded page world vs pure core (page) and vs Node, fixed dt 1/30');
  await chk('t=0', true);
  await run(15); await chk('t=15', true);
  await run(5);  await chk('t=20 (libm drift starts to show)', false);
  await run(40); await chk('t=60 PATROL (incl. auto-tasking at 50 s)', false);
  await act('mode', ['orbit']); await run(30); await chk('t=90 after applyCommand mode=orbit', false);
  await act('swarm2', [12]); await act('role', ['hostile']); await run(30); await chk('t=120 after swarm2=12 + role=hostile', false);
  await act('drones', [40]); await act('mode', ['formation']); await run(20); await chk('t=140 after drones=40 + mode=formation', false);
  await page.close();
}

await browser.close();
procs.forEach(p => p.kill());
tmps.forEach(d => rmSync(d, { recursive: true, force: true }));
if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
const allOk = results.every(r => r.ok !== false) && !errors.length;
console.log(allOk ? 'PARITY OK' : 'PARITY FAILED');
process.exit(allOk ? 0 : 1);
