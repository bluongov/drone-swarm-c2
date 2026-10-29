// node --test server/test/sim-core.test.mjs · sim-core.js unit tests (no DB, no browser). Synthetic flat terrain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SimWorld, SimSwarm, makeTerrain, makeObstacles, makeRand, mulberry32, V3, TICK_DT, MODES } from '../../sim-core.js';

const city = { origin: [39.457, -0.355], base: [180, 240], theta: -40.5, cell: 4, n: 550 };
const terr = makeTerrain(city, new Float32Array(city.n * city.n));    // flat ground
const landmarks = [
  { id: 'hemisferic', code: 'HMF', name: "L'Hemisfèric", x: -40, z: 60, r: 30, h: 50, nfz: true },
  { id: 'museu', code: 'MUS', name: 'Museu de les Ciències', x: -120, z: 100, r: 40, h: 60, nfz: false },
  { id: 'oceanografic', code: 'OCE', name: "L'Oceanogràfic", x: 150, z: 90, r: 50, h: 30, nfz: false },
];
const mk = (extra = {}) => { const logs = [], ev = []; const w = new SimWorld({ topAt: terr.topAt, topNear: terr.topNear, landmarks, seed: 7, n: 20, hooks: { log: (l, m) => logs.push(l + ' ' + m), onMissionEvent: e => ev.push(e) }, ...extra }); return { w, logs, ev }; };
const run = (w, sec) => { for (let i = 0; i < Math.round(sec / TICK_DT); i++) w.step(TICK_DT); };
const state = w => w.drones.map(d => [d.pos.x, d.pos.y, d.pos.z, d.vel.x, d.vel.y, d.vel.z, d.battery, d.state].join());

test('same seed → identical run, and no Math.random inside the core', () => {
  const real = Math.random; Math.random = () => { throw new Error('Math.random used'); };
  try {
    const a = mk().w, b = mk().w;
    run(a, 20); run(b, 20);
    assert.deepEqual(state(a), state(b));
    assert.notDeepEqual(state(a), state(mk({ seed: 8 }).w).map((s, i) => s), 'different seed differs (sanity)');
  } finally { Math.random = real; }
});

test('makeObstacles: NFZ-A on the nfz landmark (r 46, h 110) + NFZ-B clear of landmarks', () => {
  const o = makeObstacles(makeRand(mulberry32(3)).rand, landmarks);
  assert.equal(o.length, 2);
  assert.deepEqual([o[0].name, o[0].r, o[0].h, o[0].x, o[0].z], ['NFZ-A', 46, 110, -40, 60]);
  assert.equal(o[1].name, 'NFZ-B');
  for (const l of landmarks) assert.ok(Math.hypot(l.x - o[1].x, l.z - o[1].z) >= l.r + o[1].r - 1e-9 || l.nfz);
});

test('flight: drones take off, stay out of NFZ and above ground', () => {
  const { w } = mk(); run(w, 40);
  assert.ok(w.drones.filter(d => d.state === 'ACTIVE').length >= 15);
  for (const d of w.drones) if (d.state === 'ACTIVE') for (const o of w.obstacles) assert.ok(Math.hypot(d.pos.x - o.x, d.pos.z - o.z) >= o.r || d.pos.y >= o.h);
});

test('MISSION: waypoints, WP events, DONE, back to PATROL; auto-tasking never rotates out of it', () => {
  const { w, ev } = mk(); run(w, 10);
  const wps = [V3(60, 40, -80), V3(-60, 45, -120), V3(0, 50, -160)];
  assert.equal(w.swarms.A.setMission(wps, 'm1'), true);
  assert.equal(w.swarms.A.mode, 'MISSION');
  assert.ok(!MODES.includes('MISSION'));
  w.lastInteraction = -99;
  for (let i = 0; i < 3000 && !ev.some(e => e.type === 'DONE'); i++) { w.step(TICK_DT); if (w.swarms.A.mode === 'MISSION') assert.equal(w.swarms.A.modeTimer > 0, true); }
  assert.deepEqual(ev.map(e => e.type + (e.wpIdx ?? '')), ['WP1', 'WP2', 'DONE'], JSON.stringify(ev));
  assert.ok(ev.every(e => e.id === 'm1'));
  assert.equal(w.swarms.A.mode, 'PATROL');
  assert.equal(w.snapshot().mission, null);
});

test('MISSION is not left by auto-tasking (modeTimer > 50 s, auto on)', () => {
  const { w, ev } = mk(); run(w, 10);
  w.swarms.A.setMission([V3(-250, 40, 250), V3(250, 40, -250), V3(-250, 40, 250), V3(250, 40, -250), V3(-250, 40, 250), V3(250, 40, -250)], 'far');
  run(w, 70);
  assert.equal(w.swarms.A.mode, 'MISSION'); assert.ok(w.swarms.A.modeTimer > 50);
  assert.ok(ev.every(e => e.type === 'WP'), JSON.stringify(ev));          // no ABORTED / DONE
  const snap = w.snapshot(); assert.deepEqual([snap.mission.id, snap.mission.status, snap.mission.total], ['far', 'RUNNING', 6]);
});

test('clearMission → ABORTED + PATROL; operator mode change also aborts', () => {
  const a = mk(); a.w.swarms.A.setMission([V3(100, 40, 100)], 'x'); assert.equal(a.w.swarms.A.clearMission('test'), true);
  assert.deepEqual(a.ev, [{ type: 'ABORTED', id: 'x', reason: 'test' }]); assert.equal(a.w.swarms.A.mode, 'PATROL');
  const b = mk(); b.w.swarms.A.setMission([V3(100, 40, 100)], 'y'); assert.deepEqual(b.w.applyCommand({ name: 'mode', args: ['scan'] }), { ok: true, msg: 'ALPHA mode SCAN' });
  assert.equal(b.ev[0].type, 'ABORTED'); assert.equal(b.w.swarms.A.mode, 'SCAN');
});

test('mission waypoints are not lifted by safeAlt (goal y = waypoint y ± 6 offset pattern)', () => {
  const hm = new Float32Array(city.n * city.n).fill(40);            // 40-unit tall city everywhere
  const t = makeTerrain(city, hm);
  const w = new SimWorld({ topAt: t.topAt, topNear: t.topNear, landmarks, seed: 1, n: 10 });
  run(w, 12);
  w.swarms.A.setMission([V3(100, 30, 100)], 'low'); run(w, 0.2);
  const d = w.drones.find(d => d.state === 'ACTIVE'); assert.ok(d);
  assert.ok(Math.abs(d.goal.y - 30) <= 6 + 1e-9, `goal.y ${d.goal.y}`);
  w.swarms.A.clearMission('t'); run(w, 0.2);
  assert.ok(d.goal.y >= 52 - 1e-9, `PATROL goal lifted above the 40-unit roofs: ${d.goal.y}`);
});

test('snapshot shape (plan §3.3)', () => {
  const { w } = mk(); run(w, 15);
  const s = w.snapshot();
  assert.equal(s.type, 'snap'); assert.equal(typeof s.t, 'number'); assert.equal(typeof s.seq, 'number');
  assert.equal(s.drones.length, 20);
  const d = s.drones[0]; assert.equal(d.length, 14);
  assert.match(d[0], /^UAV-\d\d$/); assert.equal(d[1], 'A'); assert.equal(typeof d[10], 'string');
  assert.deepEqual(Object.keys(s.swarms), ['A']);
  const a = s.swarms.A;
  assert.deepEqual(Object.keys(a), ['mode', 'wpIdx', 'waypoints', 'orbitCenter', 'orbitR0', 'orbitAlt0', 'leader', 'sweepZ', 'hostile']);
  assert.equal(a.waypoints.length, 6); assert.equal(a.waypoints[0].length, 3); assert.equal(a.orbitCenter.length, 2); assert.equal(a.leader.length, 3);
  assert.equal(s.mission, null); assert.equal(w.snapshot().seq, s.seq + 1);
  JSON.stringify(s);
});

test('applyCommand: mode, orbit (NFZ denied), drones, auto, swarm2, role, sel', () => {
  const { w } = mk(); run(w, 5);
  assert.equal(w.applyCommand({ name: 'mode', args: ['formation'] }).ok, true); assert.equal(w.swarms.A.mode, 'FORMATION');
  assert.equal(w.applyCommand({ name: 'mode', args: ['nope'] }).ok, false);
  assert.equal(w.applyCommand({ name: 'orbit', args: ['hmf'] }).ok, false);               // NFZ landmark denied
  const o = w.applyCommand({ name: 'orbit', args: ['oce'] }); assert.equal(o.ok, true); assert.equal(w.swarms.A.mode, 'ORBIT');
  assert.deepEqual([w.swarms.A.orbitCenter.x, w.swarms.A.orbitCenter.z], [150, 90]);
  assert.equal(w.applyCommand({ name: 'drones', args: [30] }).ok, true); assert.equal(w.drones.length, 30);
  assert.equal(w.applyCommand({ name: 'drones', args: [151] }).ok, false);
  assert.equal(w.applyCommand({ name: 'auto', args: ['off'] }).ok, true); assert.equal(w.auto, false);
  assert.equal(w.applyCommand({ name: 'role', args: ['hostile'] }).ok, false);            // no swarm 2 yet
  assert.equal(w.applyCommand({ name: 'sel', args: ['b'] }).ok, false);
  assert.equal(w.applyCommand({ name: 'swarm2', args: [8] }).ok, true); assert.equal(w.drones.length, 38); assert.ok(w.swarms.B);
  assert.equal(w.applyCommand({ name: 'sel', args: ['b'] }).ok, true); assert.equal(w.sel, w.swarms.B);
  assert.equal(w.applyCommand({ name: 'role', args: ['hostile'] }).ok, true); assert.equal(w.sel, w.swarms.A); assert.ok(w.snapshot().swarms.B.hostile);
  assert.equal(w.applyCommand({ name: 'sel', args: ['b'] }).ok, false);
  run(w, 30);
  assert.match(w.snapshot().drones.at(-1)[0], /^TRK-/);
  assert.equal(w.applyCommand({ name: 'swarm2', args: ['off'] }).ok, true); assert.equal(w.drones.length, 30); assert.equal(w.swarms.B, null);
  assert.equal(w.applyCommand({ name: 'bogus', args: [] }).ok, false);
});

test('hooks fire: onModeChange, onRouteChange, onDroneState, onRipple (PATROL waypoint)', () => {
  const calls = { mode: 0, route: 0, state: 0, ripple: 0 };
  const w = new SimWorld({ topAt: terr.topAt, topNear: terr.topNear, landmarks, seed: 5, n: 10, hooks: {
    onModeChange: () => calls.mode++, onRouteChange: () => calls.route++, onDroneState: () => calls.state++, onRipple: () => calls.ripple++ } });
  assert.equal(calls.route, 1);                                  // initial patrol route
  run(w, 8); assert.ok(calls.state > 0);
  w.applyCommand({ name: 'mode', args: ['scan'] }); assert.equal(calls.mode, 1);
  w.swarms.A.setMission([V3(0, 40, 0)], 'r'); run(w, 60); assert.ok(calls.ripple >= 1);
});

test('custom DroneClass / SwarmClass are used', () => {
  class D extends (new SimWorld({ topAt: terr.topAt, topNear: terr.topNear, landmarks, seed: 1 }).DroneClass) {}
  class S extends SimSwarm {}
  const w = new SimWorld({ topAt: terr.topAt, topNear: terr.topNear, landmarks, seed: 1, n: 3, DroneClass: D, SwarmClass: S });
  assert.ok(w.swarms.A instanceof S); assert.ok(w.drones[0] instanceof D);
});
