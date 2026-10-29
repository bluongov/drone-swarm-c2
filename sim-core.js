// sim-core.js · shared drone-swarm simulation (browser offline mode + Node server).
// No DOM, no meshes, no Math.random, no console. Randomness only through the injected `rand`.
// Units: scene units (1 unit = 2 m), X east, Z south, origin = ALPHA drone base.
//
// FROZEN CONTRACT (docs/implementation-plan.md §3.1). The exports in the "frozen" block below were written by the
// orchestrator and must keep their names, signatures and behaviour. WP2 adds SimDrone, SimSwarm, SimWorld,
// makeObstacles below the marker.
import { Vector3 } from 'three';

// ---------------- frozen: constants (same values as index.html CONFIG) ----------------
export const AREA = 280;                       // half side of the operations area (±560 m)
export const MAXS = 20, MAXF = 28, R_NEI = 16, R_SEP = 7;
export const MODES = ['PATROL', 'ORBIT', 'FORMATION', 'SCAN'];
export const MODE_W = {
  PATROL:    { sep: 2.2, ali: 1.0, coh: 0.8, goal: 0.7, arrive: 1,  minS: 7 },
  ORBIT:     { sep: 2.4, ali: 0.2, coh: 0.0, goal: 1.6, arrive: 18, minS: 0 },
  FORMATION: { sep: 2.2, ali: 0.3, coh: 0.0, goal: 1.8, arrive: 18, minS: 0 },
  SCAN:      { sep: 2.2, ali: 0.2, coh: 0.0, goal: 1.8, arrive: 18, minS: 0 },
  INTRUDE:   { sep: 2.0, ali: 0.7, coh: 0.6, goal: 1.1, arrive: 10, minS: 6 },
  INTERCEPT: { sep: 1.6, ali: 0.0, coh: 0.0, goal: 2.4, arrive: 6,  minS: 0 },
};
export const SC = 0.5, M_PER_U = 1 / SC;       // scene units per metre / metres per scene unit
export const TICK_DT = 1 / 30;                 // fixed server step (also used by parity tests)

// ---------------- frozen: math helpers ----------------
export const V3 = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function limit(v, m) { const l = v.length(); if (l > m) v.multiplyScalar(m / l); return v; }
export function lerpAngle(a, b, t) { let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI; if (d < -Math.PI) d += Math.PI * 2; return a + d * t; }

// ---------------- frozen: random ----------------
// mulberry32: tiny seeded PRNG, returns () => float in [0, 1)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// helpers bound to a uniform source (Math.random in the browser offline default, mulberry32 when seeded)
export function makeRand(u = Math.random) {
  return { u, rand: (a, b) => a + u() * (b - a), pick: arr => arr[Math.floor(u() * arr.length)] };
}

// ---------------- frozen: coordinate frames (port of index.html SITE block) ----------------
// city = window.CITY-like object: { origin:[lat,lon], base:[x,y] (site metres), theta (deg), cell (m), n }
export function makeFrames(city) {
  const TH = city.theta * Math.PI / 180, CT = Math.cos(TH), ST = Math.sin(TH);
  const [BX, BY] = city.base, R_E = 6371008.8, COSLAT = Math.cos(city.origin[0] * Math.PI / 180);
  const [LAT0, LON0] = city.origin;
  const siteToScene = (x, y) => [(x - BX) * SC, -(y - BY) * SC];                    // → [X, Z]
  const sceneToSite = (X, Z) => [X / SC + BX, -Z / SC + BY];
  const geoToSite = (lat, lon) => [(lon - LON0) * Math.PI / 180 * R_E * COSLAT, (lat - LAT0) * Math.PI / 180 * R_E];
  const siteToGeo = (x, y) => [LAT0 + y / R_E * 180 / Math.PI, LON0 + x / (R_E * COSLAT) * 180 / Math.PI];
  const sceneToGeo = (X, Z) => siteToGeo(...sceneToSite(X, Z));                     // → [lat, lon]
  const geoToScene = (lat, lon) => siteToScene(...geoToSite(lat, lon));             // → [X, Z]
  const sceneToGrid = (X, Z) => { const dx = X / SC, dy = -Z / SC; return [dx * CT + dy * ST, -dx * ST + dy * CT]; };
  const gridToScene = (gu, gv) => { const dx = gu * CT - gv * ST, dy = gu * ST + gv * CT; return [dx * SC, -dy * SC]; };
  return { siteToScene, sceneToSite, geoToSite, siteToGeo, sceneToGeo, geoToScene, sceneToGrid, gridToScene };
}

// ---------------- frozen: terrain (height map lookups) ----------------
// hm = Float32Array(n*n) of "top of whatever stands in the cell", in SCENE units, row j (gv) major: hm[j*n + i]
export function makeTerrain(city, hm) {
  const { sceneToGrid } = makeFrames(city);
  const GC = city.cell, GN = city.n, GHALF = GN * GC / 2;
  function topAt(X, Z) {
    const [gu, gv] = sceneToGrid(X, Z);
    const i = Math.floor((gu + GHALF) / GC), j = Math.floor((gv + GHALF) / GC);
    return i < 0 || j < 0 || i >= GN || j >= GN ? 0 : hm[j * GN + i];
  }
  const topNear = (X, Z, r = 8) => Math.max(topAt(X, Z), topAt(X + r, Z), topAt(X - r, Z), topAt(X, Z + r), topAt(X, Z - r));
  // scene coords of the centre of cell (i, j)
  const cellCentre = (i, j) => makeFrames(city).gridToScene((i + 0.5) * GC - GHALF, (j + 0.5) * GC - GHALF);
  return { topAt, topNear, cellCentre, GC, GN, GHALF };
}

// ================= WP2: SimDrone, SimSwarm, SimWorld, makeObstacles below this line =================

// ---------------- WP2: shared constants / temps ----------------
MODE_W.MISSION = MODE_W.PATROL;                           // MISSION flies with the PATROL weights (not part of MODES: auto-tasking never picks it)
export const PSP = 4.5;                                   // pad spacing (scene units)
export const BASE_B = V3(188, 0, 128);                    // open ground NE of the Oceanogràfic (searched in the OSM raster: no buildings, water or roads)
const SW_ROUTE = { A: 0xffcc33, B: 0xff9f40, H: 0xff3344 };   // route colour passed to hooks.onRipple (browser overrides `style` with the full palette)
const pad2 = n => String(n).padStart(2, '0');
// temp vectors
const _sep = V3(), _ali = V3(), _coh = V3(), _des = V3(), _acc = V3(), _d = V3(), _g = V3(), _p = V3();

// pure helpers (the world exposes them bound to its terrain / obstacles as world.safeAlt / world.outOfNfz)
export const safeAlt = (topNear, x, z, y) => Math.min(95, Math.max(y, topNear(x, z, 10) + 12));
export function outOfNfz(obstacles, p) {
  for (const o of obstacles) if (o.type === 'NFZ') {
    const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz) || 1;
    if (d < o.r + 18) { p.x = o.x + dx / d * (o.r + 18); p.z = o.z + dz / d * (o.r + 18); }
  }
  return p;
}

// geofence: big NFZ over L'Hemisfèric + one smaller temporary restriction (random placement through rand(a, b))
export function makeObstacles(rand, landmarks) {
  const obstacles = [];
  const addNfz = (x, z, r, h, name, label) => { obstacles.push({ x, z, r, h, type: 'NFZ', name, label }); };
  const hmf = landmarks.find(l => l.nfz);              // site NFZ landmark (Hemisfèric at the Ciutat); size/label from sites.js
  if (hmf) addNfz(hmf.x, hmf.z, hmf.nfzR ?? 46, hmf.nfzH ?? 110, 'NFZ-A', hmf.nfzLabel ?? "L'HEMISFÈRIC");
  let x, z, r, ok = false, t = 0;
  while (!ok && t++ < 300) {
    const a = rand(0, Math.PI * 2), R = rand(120, 230);
    x = Math.cos(a) * R; z = Math.sin(a) * R; r = rand(18, 24);
    ok = !obstacles.some(o => Math.hypot(o.x - x, o.z - z) < o.r + r + 20) && !landmarks.some(l => Math.hypot(l.x - x, l.z - z) < l.r + r);
  }
  addNfz(x, z, r, 90, 'NFZ-B', 'TFR');
  return obstacles;
}

// ---------------- SimDrone ----------------
export class SimDrone {
  constructor(sw, i, delay) {
    const R = sw.world;
    this.sw = sw; this.world = R; this.i = i;
    this.pad = sw.pads[i];
    this.target = null; this.hit = 0;                // ALPHA interceptor: hostile track being escorted
    this.pos = this.pad.clone();
    this.vel = V3(); this.lastAcc = V3(); this.goal = V3(0, 40, 0);
    this.state = 'IDLE';
    this.launchDelay = delay ?? 0.8 + i * 0.12;
    this.battery = R.rand(45, 100);
    this.drain = R.rand(0.32, 0.6);
    this.link = 99; this.phase = R.rand(0, Math.PI * 2);
    this.yaw = R.rand(0, Math.PI * 2);
    this.slot = 0; this.nfzT = -99; this.temp = R.rand(34, 40);
  }

  // BRAVO drones are BRV-xx; when BRAVO turns hostile they become unknown tracks TRK-xx
  get id() { return (this.sw.hostile ? 'TRK' : this.sw.prefix) + '-' + pad2(this.i + 1); }
  get padName() { return (this.sw.key === 'A' ? '' : 'B-') + 'PAD-' + pad2(this.i + 1); }
  setState(s) { this.state = s; this.world.hooks.onDroneState?.(this, s); }
  dispose() {}

  // state machine only (the browser subclass adds orient / trail / LED on top)
  update(dt, flying) {
    const W = this.world, T = W.T;
    switch (this.state) {
      case 'IDLE':
        this.launchDelay -= dt;
        if (this.launchDelay <= 0) this.setState('LAUNCH');
        break;
      case 'LAUNCH':
        this.vel.set(0, 9, 0);
        this.pos.addScaledVector(this.vel, dt);
        this.battery -= dt * 0.8;
        if (this.pos.y > 24) { this.setState('ACTIVE'); this.vel.set(W.rand(-4, 4), 2, W.rand(-4, 4)); }
        break;
      case 'CHARGING':
        this.vel.set(0, 0, 0);
        this.battery = Math.min(100, this.battery + dt * 8);
        if (this.battery >= 100) { this.setState('LAUNCH'); W.log('ok', `${this.id} recharge complete (100%) · relaunching`); }
        break;
      case 'LANDING':
        this.pos.x += (this.pad.x - this.pos.x) * Math.min(1, dt * 3);
        this.pos.z += (this.pad.z - this.pos.z) * Math.min(1, dt * 3);
        this.vel.set(0, -6, 0);
        this.pos.y -= 6 * dt;
        if (this.pos.y <= this.pad.y) { this.pos.y = this.pad.y; this.setState('CHARGING'); W.log('ok', `${this.id} touchdown on ${this.padName} · charging`); }
        break;
      case 'ACTIVE':
      case 'RTB':
        this.flock(dt, flying);
        this.battery -= dt * this.drain * (this.state === 'RTB' ? 0.6 : 1);
        break;
    }
    this.battery = Math.max(0, this.battery);
    if (this.state === 'ACTIVE' && this.battery < 15) {
      this.setState('RTB');
      W.log('warn', `${this.id} battery ${this.battery.toFixed(1)}% · RTB authorized → ${this.padName}`);
    }
    const dist = Math.hypot(this.pos.x - this.sw.base.x, this.pos.z - this.sw.base.z);
    this.link = clamp(this.link + (clamp(100 - dist * 0.09 + Math.sin(T * 0.7 + this.phase) * 4, 40, 100) - this.link) * dt * 2, 0, 100);
    this.temp += ((this.state === 'ACTIVE' ? 44 : this.state === 'CHARGING' ? 36 : 40) + Math.sin(T + this.phase) * 2 - this.temp) * dt * 0.2;
  }

  flock(dt, flying) {
    const W0 = this.world, T = W0.T, obstacles = W0.obstacles, topAt = W0.topAt;
    const rtb = this.state === 'RTB';
    const hostile = this.sw.hostile;
    const W = rtb ? { sep: 2.2, ali: 0, coh: 0, goal: 1.6, arrive: 25, minS: 0 } : this.target ? MODE_W.INTERCEPT : MODE_W[hostile ? 'INTRUDE' : this.sw.mode];
    _sep.set(0, 0, 0); _ali.set(0, 0, 0); _coh.set(0, 0, 0);
    let nA = 0, nS = 0;
    for (const o of flying) {
      if (o === this) continue;
      _d.subVectors(this.pos, o.pos);
      const dist = _d.length();
      if (dist < R_NEI) {
        if (!rtb && o.state === 'ACTIVE' && o.sw === this.sw) { _ali.add(o.vel); _coh.add(o.pos); nA++; }   // flock only with own swarm
        if (dist < R_SEP && dist > 0.001) { _sep.addScaledVector(_d, 1 / (dist * dist)); nS++; }
      }
    }
    if (!rtb && !hostile) { W0.neiSum += nA; W0.neiCnt++; }
    _acc.set(0, 0, 0);
    let sepW = W.sep;
    if (rtb && Math.hypot(this.pos.x - this.pad.x, this.pos.z - this.pad.z) < 15) sepW = 0.3;
    if (nS) { _sep.setLength(MAXS).sub(this.vel); limit(_sep, MAXF); _acc.addScaledVector(_sep, sepW); }
    if (nA) {
      _ali.divideScalar(nA).setLength(MAXS).sub(this.vel); limit(_ali, MAXF); _acc.addScaledVector(_ali, W.ali);
      _coh.divideScalar(nA).sub(this.pos);
      if (_coh.lengthSq() > 0.0001) { _coh.setLength(MAXS).sub(this.vel); limit(_coh, MAXF); _acc.addScaledVector(_coh, W.coh); }
    }
    // goal seeking with arrival
    const goal = rtb ? _g.set(this.pad.x, 22, this.pad.z) : this.goal;
    _des.subVectors(goal, this.pos);
    const gd = _des.length();
    if (gd > 0.01) {
      _des.setLength(MAXS * Math.min(1, gd / W.arrive)).sub(this.vel);
      limit(_des, MAXF); _acc.addScaledVector(_des, W.goal);
    }
    // geofence (NFZ cylinders) · hostile tracks ignore it (and get reported)
    for (const o of obstacles) {
      if (hostile) {
        if (Math.hypot(this.pos.x - o.x, this.pos.z - o.z) < o.r && this.pos.y < o.h && T - this.nfzT > 25) {
          this.nfzT = T; W0.log('err', `GEOFENCE BREACH: ${this.id} inside ${o.name} (${o.label}) · alt ${(this.pos.y * M_PER_U).toFixed(0)}m`);
        }
        continue;
      }
      const dx = this.pos.x - o.x, dz = this.pos.z - o.z;
      const d = Math.hypot(dx, dz) || 0.01;
      const m = o.r + 14;
      if (d < m && this.pos.y < o.h + 10) {
        const s = (m - d) / 14;
        _acc.x += dx / d * s * MAXF * 2.5;
        _acc.z += dz / d * s * MAXF * 2.5;
        if (d < o.r + 8 && T - this.nfzT > 20) {
          this.nfzT = T;
          if (W0.u() < 0.5) W0.log('warn', `GEOFENCE: ${this.id} deflected from ${o.name} (${o.label}) · margin ${((d - o.r) * M_PER_U).toFixed(1)}m`);
        }
      }
    }
    // structures (city + Calatrava voxels, from the height map): climb over what is ahead, slide off walls
    const px = this.pos.x, pz = this.pos.z, py = this.pos.y;
    let ahead = topAt(px, pz);
    for (const s of [0.4, 0.8, 1.3]) ahead = Math.max(ahead, topAt(px + this.vel.x * s, pz + this.vel.z * s));
    if (ahead + 7 > py) _acc.y += Math.min(ahead + 7 - py, 12) * 6;
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4, ox = Math.cos(a), oz = Math.sin(a), t = topAt(px + ox * 7, pz + oz * 7);
      if (t + 4 > py) { const s = Math.min(1, (t + 4 - py) / 8) * MAXF * 1.4; _acc.x -= ox * s; _acc.z -= oz * s; }
    }
    // altitude & area bounds
    if (py < 14) _acc.y += (14 - py) * 5;
    if (py > 100) _acc.y -= (py - 100) * 5;
    for (const ax of ['x', 'z']) {
      const v = this.pos[ax];
      if (Math.abs(v) > AREA) _acc[ax] -= Math.sign(v) * (Math.abs(v) - AREA) * 3;
    }
    limit(_acc, MAXF * 2.5);
    this.lastAcc.copy(_acc);
    this.vel.addScaledVector(_acc, dt);
    const spd = this.vel.length();
    const minS = rtb ? 0 : W.minS;
    const vmax = this.target ? MAXS * 1.35 : hostile ? MAXS * 0.85 : MAXS;   // interceptors are faster than the tracks
    if (spd > vmax) this.vel.multiplyScalar(vmax / spd);
    else if (spd < minS && spd > 0.001) this.vel.multiplyScalar(minS / spd);
    this.pos.addScaledVector(this.vel, dt);

    if (rtb && Math.hypot(this.pos.x - this.pad.x, this.pos.z - this.pad.z) < 2.5) {
      this.setState('LANDING');
      W0.log('info', `${this.id} over ${this.padName} · initiating auto-land`);
    }
  }
}

// ---------------- SimSwarm ----------------
// ALPHA = our fleet. BRAVO = optional second fleet with its own base and missions. role=hostile turns BRAVO into
// unknown intruders (TRK-xx) that ignore the geofence and head for the landmarks, while ALPHA intercepts them.
export class SimSwarm {
  constructor(world, key, name, prefix, base) {
    this.world = world;
    Object.assign(this, {
      key, name, prefix, base, hostile: false, drones: [], pads: [], baseR: 10, active: [],
      mode: 'PATROL', modeTimer: key === 'A' ? 0 : -25, lastAssign: -99, lastActiveCount: -1, orbitFromClick: false,
      waypoints: [], wpIdx: 0, orbitCenter: V3(), orbitR0: 36, orbitAlt0: 30,
      leader: V3(), leaderVel: V3(1, 0, 0), sweepZ: 0, ph: key === 'A' ? 0 : 2.1, objectives: [], objT: -99, threatT: -99,
      missionId: null,                      // id of the MISSION in progress (mode === 'MISSION'), else null
    });
  }
  get style() { return { route: SW_ROUTE[this.hostile ? 'H' : this.key] }; }   // browser subclass overrides with the full palette
  get modeLabel() { return this.hostile ? 'INTRUDE' : this.mode; }
  restyle() {}                                                    // visual only (browser subclass)
  computePads(n) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(n))), rows = Math.max(1, Math.ceil(n / cols)), b = this.base;
    this.pads.length = 0;
    for (let i = 0; i < n; i++) this.pads.push(V3(b.x + (i % cols - (cols - 1) / 2) * PSP, 0.6, b.z + (Math.floor(i / cols) - (rows - 1) / 2) * PSP));
    this.baseR = Math.max(cols, rows) * PSP * 0.75 + 4;
  }
  setCount(n, delay0 = 0.8) {
    const prev = this.drones.length;
    while (this.drones.length > n) this.drones.pop().dispose();
    this.computePads(n);
    this.drones.forEach(d => { d.pad = this.pads[d.i]; if (d.state === 'IDLE' || d.state === 'CHARGING') d.pos.copy(d.pad); });
    for (let i = this.drones.length; i < n; i++) this.drones.push(new this.world.DroneClass(this, i, delay0 + (i - prev) * (delay0 > 0.5 ? 0.12 : 0.08)));
    this.lastActiveCount = -1;
    this.world.refreshDrones();
  }
  dispose() { this.setCount(0); }
  genRoute() {
    const W = this.world, rand = W.rand;
    this.waypoints = [];
    const n = 6, a0 = rand(0, Math.PI * 2);
    for (let i = 0; i < n; i++) {
      const a = a0 + i / n * Math.PI * 2 + rand(-0.3, 0.3), r = rand(80, AREA - 30);
      const w = W.outOfNfz(V3(Math.cos(a) * r, 0, Math.sin(a) * r));
      w.y = W.safeAlt(w.x, w.z, rand(30, 52) + (this.key === 'B' ? 10 : 0));
      this.waypoints.push(w);
    }
    this.wpIdx = 0; W.hooks.onRouteChange?.(this);
  }
  orbitLandmark(l) {
    this.orbitCenter.set(l.x, 0, l.z);
    this.orbitR0 = clamp(l.r + 12, 30, 90) + (this.key === 'B' ? 8 : 0);
    this.orbitAlt0 = (l.orbitAbove ?? l.id === 'assut') ? l.h + 8 : clamp(l.h * 0.6, 26, 70);   // bridge: stay above the cable fan
  }
  orbitPoint(p) {                                 // operator click: snap to a landmark if it was clicked
    const l = this.world.orbitTargets.find(l => Math.hypot(l.x - p.x, l.z - p.z) < Math.max(l.r, 16));
    if (l) { this.orbitLandmark(l); return l.name; }
    this.orbitCenter.set(p.x, 0, p.z); this.orbitR0 = 36; this.orbitAlt0 = Math.max(30, this.world.topNear(p.x, p.z, 20) + 10);
    return null;
  }
  setMode(m, why) {
    if (this.hostile) return;
    const W = this.world, SA = W.swarms.A, SB = W.swarms.B;
    if (m !== this.mode) {
      if (this.mode === 'MISSION' && this.missionId != null) {      // operator / auto change while a mission runs: it is aborted
        const id = this.missionId; this.missionId = null;
        W.hooks.onMissionEvent?.({ type: 'ABORTED', id, reason: `mode ${m}` });
      }
      this.mode = m;
      if (m === 'ORBIT' && !this.orbitFromClick) {
        const other = this === SA ? SB : SA, busy = other && !other.hostile && other.mode === 'ORBIT' ? other.orbitCenter : null;
        const opts = W.orbitTargets.filter(t => !busy || Math.hypot(t.x - busy.x, t.z - busy.z) > 1);
        const b = W.pick(opts.length ? opts : W.orbitTargets); this.orbitLandmark(b);
        why = why || `target ${b.name}`;
      }
      if (m === 'PATROL') this.genRoute();
      this.lastAssign = -99;
      W.log('sys', `MISSION: retasking ${SB ? this.name : 'swarm'} → ${m}${why ? ' · ' + why : ''}`);
      W.hooks.onModeChange?.(this, m, why);
    }
    this.orbitFromClick = false;
    this.modeTimer = 0;
  }
  // server-run mission: fly the waypoints (scene units, NOT lifted by safeAlt: validated before launch) then back to PATROL.
  // hooks.onMissionEvent: {type:'WP', id, wpIdx, total} each time a waypoint is reached (wpIdx = the new target index, 1..total-1),
  // {type:'DONE', id} after the last one, {type:'ABORTED', id, reason} when cancelled (clearMission, or any other setMode)
  setMission(waypoints, id) {
    if (this.hostile || !waypoints || !waypoints.length) return false;
    const W = this.world;
    if (this.mode === 'MISSION' && this.missionId != null && this.missionId !== id) W.hooks.onMissionEvent?.({ type: 'ABORTED', id: this.missionId, reason: 'replaced' });
    this.waypoints = waypoints.map(w => w.clone()); this.wpIdx = 0; this.missionId = id;
    this.setMode('MISSION', `mission ${id}`);
    this.lastAssign = -99;
    W.hooks.onRouteChange?.(this);
    return true;
  }
  clearMission(reason) {
    if (this.mode !== 'MISSION') return false;
    const id = this.missionId; this.missionId = null;
    this.world.hooks.onMissionEvent?.({ type: 'ABORTED', id, reason });
    this.setMode('PATROL', `mission aborted${reason ? ' · ' + reason : ''}`);
    return true;
  }
  assignSlots(active) {
    const arr = active.slice(), oc = this.orbitCenter, mode = this.mode;
    if (mode === 'SCAN') arr.sort((a, b) => a.pos.x - b.pos.x);
    else if (mode === 'ORBIT') arr.sort((a, b) => Math.atan2(a.pos.z - oc.z, a.pos.x - oc.x) - Math.atan2(b.pos.z - oc.z, b.pos.x - oc.x));
    else if (mode === 'FORMATION') arr.sort((a, b) => a.pos.distanceToSquared(this.leader) - b.pos.distanceToSquared(this.leader));
    arr.forEach((d, k) => d.slot = k);
    this.lastAssign = this.world.T; this.lastActiveCount = active.length;
  }
  computeGoals(active) {
    if (this.hostile) return this.intrudeGoals(active);
    const W = this.world, T = W.T;
    const n = active.length || 1, ph = this.ph, leader = this.leader, lv = this.leaderVel, oc = this.orbitCenter;
    // formation leader path (Lissajous; BRAVO runs out of phase so the two swarms do not overlap)
    const lx = (AREA - 70) * Math.sin(T * 0.05 + ph), lz = (AREA - 100) * Math.sin(T * 0.08 + ph * 1.3);
    lv.set(lx - leader.x, 0, lz - leader.z); leader.set(lx, this.key === 'A' ? 72 : 84, lz);
    if (lv.lengthSq() < 1e-8) lv.set(1, 0, 0);
    lv.normalize();
    this.sweepZ = (AREA - 40) * Math.sin(T * 0.12 + ph);
    const cols = 8;
    for (const d of active) {
      const k = d.slot;
      switch (this.mode) {
        case 'MISSION':
        case 'PATROL': {
          const w = this.waypoints[this.wpIdx];
          d.goal.set(w.x + Math.sin(d.phase) * 12, w.y + Math.cos(d.phase * 2) * 6, w.z + Math.cos(d.phase) * 12);
          break;
        }
        case 'ORBIT': {
          const ring = k % 3, R = this.orbitR0 + ring * 14, alt = this.orbitAlt0 + ring * 12;
          const a = T * (0.32 - ring * 0.07) * (ring === 1 ? -1 : 1) + (k / n) * Math.PI * 2;
          d.goal.set(oc.x + Math.cos(a) * R, alt + Math.sin(T + k) * 2, oc.z + Math.sin(a) * R);
          break;
        }
        case 'FORMATION': {
          const col = k % cols, row = Math.floor(k / cols), c = col - (cols - 1) / 2;
          const back = row * 7 + Math.abs(c) * 4;
          // right vector = (-fz, 0, fx) with forward (fx, 0, fz)
          d.goal.set(leader.x + -lv.z * c * 8 - lv.x * back, leader.y + row * 1.5, leader.z + lv.x * c * 8 - lv.z * back);
          break;
        }
        case 'SCAN': {
          d.goal.set(-AREA + 20 + k * ((2 * AREA - 40) / Math.max(1, n - 1)), (this.key === 'A' ? 58 : 76) + (k % 2) * 9, this.sweepZ);
          break;
        }
      }
      // never aim inside a building: lift the goal above whatever stands there (mission waypoints are validated before launch instead)
      if (this.mode !== 'ORBIT' && this.mode !== 'MISSION') d.goal.y = W.safeAlt(d.goal.x, d.goal.z, d.goal.y);
    }
  }
  // hostile: three loose groups, each heading for a landmark (NFZ included) or ALPHA's base, circling it, then moving on
  intrudeGoals(active) {
    const W = this.world, T = W.T, SA = W.swarms.A;
    if (T > this.objT) {
      const tg = [...W.landmarks, { x: SA.base.x, z: SA.base.z, r: 24, name: 'ALPHA base' }];
      this.objectives = [0, 1, 2].map(() => W.pick(tg)); this.objT = T + W.rand(30, 50);
    }
    for (const d of active) {
      const o = this.objectives[d.i % 3], a = T * 0.3 + d.phase * 2, R = (o.r || 20) * 0.5 + 12;
      d.goal.set(o.x + Math.cos(a) * R, 0, o.z + Math.sin(a) * R);
      d.goal.y = W.safeAlt(d.goal.x, d.goal.z, 30 + (d.i % 4) * 7);
    }
  }
  // per-swarm simulation step (before the drones move)
  step(dt) {
    const W = this.world, T = W.T, SA = W.swarms.A, SB = W.swarms.B;
    this.modeTimer += dt;
    if (!this.hostile && W.auto && this.mode !== 'MISSION' && this.modeTimer > 50 && T - W.lastInteraction > 20) {
      let next = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
      const other = this === SA ? SB : SA;            // independent missions: avoid flying the other swarm's mode
      if (other && !other.hostile && next === other.mode) next = MODES[(MODES.indexOf(next) + 1) % MODES.length];
      this.setMode(next, 'auto-tasking');
    }
    const active = this.active = this.drones.filter(d => d.state === 'ACTIVE');
    const tasked = active.filter(d => !d.target);   // interceptors are steered by intercept()
    if (T - this.lastAssign > 2 || tasked.length !== this.lastActiveCount) this.assignSlots(tasked);
    this.computeGoals(tasked);
    if (!this.hostile && this.mode === 'PATROL' && tasked.length) {
      _p.set(0, 0, 0); tasked.forEach(d => _p.add(d.pos)); _p.divideScalar(tasked.length);
      const w = this.waypoints[this.wpIdx], who = SB ? this.name + ' ' : '';
      if (_p.distanceTo(w) < 30) {
        W.log('ok', `NAV: ${who}WP-${this.wpIdx + 1} reached · ${tasked.length} units in formation`);
        W.hooks.onRipple?.(w, this.style.route);
        if (++this.wpIdx >= this.waypoints.length) {
          this.genRoute();
          W.log('info', `PLANNER: ${who}new patrol route generated · ${this.waypoints.length} WPs · ${(this.waypoints.reduce((s, w, i) => s + w.distanceTo(this.waypoints[(i + 1) % this.waypoints.length]), 0) * M_PER_U / 1000).toFixed(2)} km`);
        }
      }
    } else if (!this.hostile && this.mode === 'MISSION' && tasked.length) {
      _p.set(0, 0, 0); tasked.forEach(d => _p.add(d.pos)); _p.divideScalar(tasked.length);
      const w = this.waypoints[this.wpIdx], who = SB ? this.name + ' ' : '', id = this.missionId;
      if (_p.distanceTo(w) < 30) {
        W.log('ok', `NAV: ${who}mission ${id} WP-${this.wpIdx + 1}/${this.waypoints.length} reached · ${tasked.length} units in formation`);
        W.hooks.onRipple?.(w, this.style.route);
        if (++this.wpIdx >= this.waypoints.length) {
          this.missionId = null;
          W.hooks.onMissionEvent?.({ type: 'DONE', id });
          W.log('ok', `MISSION: ${who}mission ${id} complete · returning to PATROL`);
          this.setMode('PATROL', 'mission complete');
        } else W.hooks.onMissionEvent?.({ type: 'WP', id, wpIdx: this.wpIdx, total: this.waypoints.length });
      }
    }
    return active;
  }
}

// ---------------- SimWorld ----------------
// opts: { topAt, topNear, landmarks, obstacles?, seed?, rand?, hooks?, n?, sceneToGeo?, DroneClass?, SwarmClass? }
//   rand: uniform source () => [0,1) or a makeRand() object; seed: mulberry32(seed); neither: makeRand() default
//   n: initial ALPHA size (creates the drones and the first patrol route; omitted = swarm A created empty)
//   baseB: [x, z] BRAVO base in scene units (sites.js); landmark fields nfzR/nfzH/nfzLabel/orbitAbove are optional
export class SimWorld {
  constructor(opts) {
    const { topAt, topNear, landmarks, obstacles, seed, rand, hooks, n, sceneToGeo, DroneClass, SwarmClass, baseB } = opts;
    this.topAt = topAt; this.topNear = topNear; this.landmarks = landmarks;
    this.baseB = baseB ? V3(baseB[0], 0, baseB[1]) : BASE_B.clone();   // BRAVO base [x, z] (sites.js), default = the Ciutat's
    this.hooks = hooks || {};
    this.sceneToGeo = sceneToGeo || null;
    const R = rand && typeof rand === 'object' ? rand
      : makeRand(rand ? rand : seed != null ? mulberry32(seed) : undefined);
    this.R = R; this.u = R.u; this.rand = R.rand; this.pick = R.pick;
    this.DroneClass = DroneClass || SimDrone; this.SwarmClass = SwarmClass || SimSwarm;
    this.orbitTargets = landmarks.filter(l => !l.nfz && !l.noOrbit);
    this.obstacles = obstacles || makeObstacles(this.rand, landmarks);
    this.T = 0; this.auto = true; this.lastInteraction = -99; this.neiSum = 0; this.neiCnt = 0; this.seq = 0;
    this.drones = [];
    this.swarms = { A: null, B: null };
    this.swarms.A = new this.SwarmClass(this, 'A', 'ALPHA', 'UAV', V3(0, 0, 0));
    this.sel = this.swarms.A;                        // swarm that mode / orbit / click commands act on
    if (n) { this.swarms.A.setCount(n); this.swarms.A.genRoute(); }
    else this.refreshDrones();
  }
  get SA() { return this.swarms.A; }
  get SB() { return this.swarms.B; }
  log(lv, msg) { this.hooks.log?.(lv, msg); }
  _changed(ev) { this.hooks.onSwarmChange?.(ev); }
  safeAlt(x, z, y) { return safeAlt(this.topNear, x, z, y); }
  outOfNfz(p) { return outOfNfz(this.obstacles, p); }
  refreshDrones() { const SA = this.swarms.A, SB = this.swarms.B; this.drones = SB ? SA.drones.concat(SB.drones) : SA.drones.slice(); }
  friendlyActive() { const SA = this.swarms.A, SB = this.swarms.B; return SB && !SB.hostile ? SA.active.concat(SB.active) : SA.active; }

  // simulation step (no rendering): the exact order of the original simStep
  step(dt) {
    this.T += dt;
    const SA = this.swarms.A, SB = this.swarms.B;
    const flying = this.drones.filter(d => d.state === 'ACTIVE' || d.state === 'RTB');   // separation across both swarms
    SA.step(dt);
    if (SB) SB.step(dt);
    this.intercept(dt);                              // overrides the goals of ALPHA interceptors
    this.neiSum = 0; this.neiCnt = 0;
    for (const d of this.drones) d.update(dt, flying);
  }

  // ALPHA vs hostile BRAVO: pair each airborne track with the nearest free ALPHA drone (≤ 40 % of ALPHA); staying
  // within 20 m of it for 3 s forces the intruder down (RTB to its own base, where it recharges and comes back)
  intercept(dt) {
    const SA = this.swarms.A, SB = this.swarms.B, T = this.T;
    if (!SB || !SB.hostile) return;
    const tracks = SB.drones.filter(h => h.state === 'ACTIVE');
    for (const d of SA.drones) if (d.target && (d.target.state !== 'ACTIVE' || d.state !== 'ACTIVE')) { d.target = null; d.hit = 0; }
    if (tracks.length && T - SB.threatT > 25) {
      SB.threatT = T;
      const c = tracks.reduce((p, h) => p.add(h.pos), V3()).divideScalar(tracks.length);
      const brg = Math.round((Math.atan2(c.x, -c.z) * 180 / Math.PI + 360) % 360);
      this.log('err', `THREAT: ${tracks.length} hostile UAS airborne · bearing ${brg}° · range ${(Math.hypot(c.x, c.z) * M_PER_U).toFixed(0)}m from base`);
    }
    const max = Math.ceil(SA.active.length * 0.4);
    let used = SA.drones.filter(d => d.target).length;
    for (const h of tracks) {
      if (used >= max) break;
      if (SA.drones.some(d => d.target === h)) continue;
      let best = null, bd = 1e12;
      for (const d of SA.active) if (!d.target && d.battery > 30) { const dd = d.pos.distanceToSquared(h.pos); if (dd < bd) { bd = dd; best = d; } }
      if (!best) break;
      best.target = h; best.hit = 0; used++;
      this.log('warn', `INTERCEPT: ${best.id} vectored to ${h.id} · range ${(Math.sqrt(bd) * M_PER_U).toFixed(0)}m`);
    }
    for (const d of SA.drones) if (d.target) {
      const h = d.target, v = h.vel.lengthSq() > 0.01 ? _g.copy(h.vel).normalize() : _g.set(0, 0, 0);
      d.goal.set(h.pos.x - v.x * 6, h.pos.y + 3, h.pos.z - v.z * 6);   // sit just behind and above the intruder
      if (d.pos.distanceTo(h.pos) < 10) {
        d.hit += dt;
        if (d.hit > 3) {
          this.log('ok', `NEUTRALIZED: ${h.id} escorted down by ${d.id} · forced RTB to hostile base`);
          this.hooks.onRipple?.(h.pos, 0xff3344);
          h.battery = Math.min(h.battery, 6); h.setState('RTB');
          d.target = null; d.hit = 0;
        }
      } else d.hit = Math.max(0, d.hit - dt * 0.5);
    }
  }

  // ---- operator-level actions (same logic as the former index.html functions, minus DOM; DOM goes through hooks.onSwarmChange) ----
  select(s, quiet) {                                  // s: swarm object, key 'A'|'B', or null (= missing B)
    const SB = this.swarms.B;
    if (typeof s === 'string') s = this.swarms[s.toUpperCase()] || null;
    if (s === SB && (!SB || SB.hostile)) { if (!quiet) this.log('err', SB ? 'BRAVO is hostile · not under our command' : 'no second swarm · use swarm2=N'); return false; }
    this.sel = s; this._changed({ type: 'sel' });
    if (!quiet) this.log('sys', `OPERATOR: commands → ${this.sel.name} (${this.sel.mode})`);
    return true;
  }
  setDroneCount(n) {                                  // ALPHA size 1..150
    const SA = this.swarms.A;
    n = clamp(Math.round(n), 1, 150);
    const prev = SA.drones.length;
    if (n === prev) { this.log('info', `FLEET: swarm already at ${n} airframes`); return { ok: true, msg: `already ${n}` }; }
    SA.setCount(n, 0.3);
    this._changed({ type: 'count' });
    if (n < prev) this.log('warn', `FLEET: decommissioning ${prev - n} airframes · swarm size ${n}`);
    else this.log('ok', `FLEET: commissioning ${n - prev} airframes · staggered takeoff · swarm size ${n}`);
    return { ok: true, msg: `drones ${n}` };
  }
  setAuto(v) {
    this.auto = v; this._changed({ type: 'auto' });
    this.log('sys', `AUTO-TASKING ${v ? 'ENABLED' : 'DISABLED'}`);
    this.swarms.A.modeTimer = 0; if (this.swarms.B) this.swarms.B.modeTimer = -25;
  }
  // swarm2=N: bring BRAVO online with N drones (0 = recall and remove it)
  setSwarm2(n, quiet) {
    const SA = this.swarms.A;
    n = clamp(Math.round(n), 0, 80);
    if (!n) {
      const SB0 = this.swarms.B;
      if (!SB0) { this.log('info', 'BRAVO: offline · usage swarm2=N (1-80)'); return; }
      SA.drones.forEach(d => { d.target = null; d.hit = 0; });
      this._changed({ type: 'swarm2-removing', removed: SB0 });
      SB0.dispose(); this.swarms.B = null; this.sel = SA;
      this.refreshDrones(); this._changed({ type: 'swarm2' });
      this.log('warn', 'BRAVO: fleet recalled · second swarm offline');
      return;
    }
    const fresh = !this.swarms.B;
    if (fresh) {
      const SB = this.swarms.B = new this.SwarmClass(this, 'B', 'BRAVO', 'BRV', this.baseB.clone());
      SB.genRoute(); SB.mode = SA.mode === 'SCAN' ? 'ORBIT' : 'SCAN';
      if (SB.mode === 'ORBIT') SB.orbitLandmark(this.pick(this.orbitTargets));
    }
    const SB = this.swarms.B;
    SB.setCount(n, fresh ? 0.5 : 0.3);
    this._changed({ type: 'swarm2' });
    if (!quiet) {
      const g = this.sceneToGeo ? this.sceneToGeo(SB.base.x, SB.base.z) : null;
      this.log('ok', fresh ? `BRAVO: second swarm online · ${n} airframes${g ? ` · base ${g[0].toFixed(5)}, ${g[1].toFixed(5)} (Oceanogràfic)` : ''} · mission ${SB.mode}`
                           : `BRAVO: swarm size ${n} airframes`);
    }
  }
  // role=hostile|friendly: BRAVO as intruders (ALPHA intercepts) or as a second friendly fleet
  setRole(r, quiet) {
    const SA = this.swarms.A, SB = this.swarms.B;
    if (!SB) { this.log('err', 'no second swarm · use swarm2=N first'); return; }
    const h = r === 'hostile';
    if (h === SB.hostile) { if (!quiet) this.log('info', `BRAVO role: ${h ? 'hostile' : 'friendly'}`); return; }
    SB.hostile = h; SB.objT = -99; SB.threatT = -99;
    SB.restyle();
    SA.drones.forEach(d => { d.target = null; d.hit = 0; });
    if (h && this.sel === SB) this.sel = SA;
    if (!h) SB.lastAssign = -99;
    this._changed({ type: 'role' });
    if (!quiet) h ? this.log('err', `THREAT: BRAVO squawk lost · ${SB.drones.length} contacts reclassified HOSTILE (TRK) · ALPHA cleared to intercept`)
                  : this.log('ok', 'BRAVO: IFF restored · contacts reclassified FRIENDLY · intercepts cancelled');
  }

  // {name, args:[...]} → {ok, msg}. name: mode | orbit | drones | auto | swarm2 | role | sel
  applyCommand(cmd) {
    const name = String(cmd && cmd.name || '').toLowerCase(), args = (cmd && cmd.args) || [];
    const a0 = args[0] == null ? '' : String(args[0]).trim(), arg = a0.toLowerCase();
    const bad = msg => ({ ok: false, msg });
    switch (name) {
      case 'mode': {
        const md = arg.toUpperCase();
        if (!MODES.includes(md)) return bad(`unknown mode '${a0}' · options: ${MODES.join(', ').toLowerCase()}`);
        this.sel.setMode(md, 'operator command');
        return { ok: true, msg: `${this.sel.name} mode ${md}` };
      }
      case 'orbit': case 'target': {
        const q = arg.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const find = l => l.code.toLowerCase() === q || l.id === q || l.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(q);
        const l = q && this.landmarks.find(find);
        if (!q) return bad(`TARGETS: ${this.landmarks.map(l => `${l.code} ${l.name}${l.nfz ? ' [NFZ]' : ''}`).join(' · ')}`);
        if (!l) return bad(`unknown target '${a0}' · options: ${this.orbitTargets.map(l => l.code.toLowerCase()).join(', ')}`);
        if (l.nfz) { const m = `DENIED: ${l.name} is inside ${this.obstacles[0].name} · no-fly zone`; this.log('err', m); return bad(m); }
        const S = this.sel; S.orbitLandmark(l); S.orbitFromClick = true; this.lastInteraction = this.T;
        if (S.mode === 'ORBIT') { this.log('sys', `OPERATOR: ${this.swarms.B ? S.name + ' ' : ''}orbit target moved → ${l.name}`); S.orbitFromClick = false; S.modeTimer = 0; S.lastAssign = -99; }
        else S.setMode('ORBIT', `operator target ${l.name}`);
        return { ok: true, msg: `${S.name} orbit ${l.name}` };
      }
      case 'drones': {
        const n = parseInt(arg);
        if (isNaN(n)) return bad(`usage drones=N (1-150)`);
        if (n < 1 || n > 150) return bad(`drones must be 1-150`);
        return this.setDroneCount(n);
      }
      case 'auto':
        if (arg !== 'on' && arg !== 'off') return bad('usage auto=on|off');
        this.setAuto(arg === 'on');
        return { ok: true, msg: `auto ${arg}` };
      case 'swarm2': case 'bravo': {
        if (arg === 'off' || arg === '0') { this.setSwarm2(0); return { ok: true, msg: 'swarm2 off' }; }
        const n = parseInt(arg);
        if (isNaN(n)) return bad('usage swarm2=N (1-80) | off');
        this.setSwarm2(n); return { ok: true, msg: `swarm2 ${this.swarms.B ? this.swarms.B.drones.length : 0}` };
      }
      case 'role':
        if (arg !== 'hostile' && arg !== 'friendly') return bad('usage role=friendly|hostile');
        if (!this.swarms.B) return bad('no second swarm · use swarm2=N first');
        this.setRole(arg); return { ok: true, msg: `role ${arg}` };
      case 'sel': case 'swarm': {
        const k = arg === 'a' || arg === 'alpha' ? 'A' : arg === 'b' || arg === 'bravo' ? 'B' : null;
        if (!k) return bad('usage sel=a|b');
        return this.select(k) ? { ok: true, msg: `sel ${k}` } : bad(this.swarms.B ? 'BRAVO is hostile · not under our command' : 'no second swarm · use swarm2=N');
      }
      default: return bad(`unknown command '${name}'`);
    }
  }

  // plan §3.3 'snap' (without `ext`). Numbers rounded (pos/vel/acc 2 dp, battery/link/temp 1 dp) to keep frames small.
  snapshot() {
    const r2 = v => Math.round(v * 100) / 100, r1 = v => Math.round(v * 10) / 10;
    const drones = this.drones.map(d => [d.id, d.sw.key, r2(d.pos.x), r2(d.pos.y), r2(d.pos.z), r2(d.vel.x), r2(d.vel.y), r2(d.vel.z),
      r2(d.lastAcc.x), r2(d.lastAcc.z), d.state, r1(d.battery), r1(d.link), r1(d.temp)]);
    const swarms = {};
    let mission = null;
    for (const k of ['A', 'B']) {
      const s = this.swarms[k]; if (!s) continue;
      swarms[k] = {
        mode: s.mode, wpIdx: s.wpIdx, waypoints: s.waypoints.map(w => [r2(w.x), r2(w.y), r2(w.z)]),
        orbitCenter: [r2(s.orbitCenter.x), r2(s.orbitCenter.z)], orbitR0: r2(s.orbitR0), orbitAlt0: r2(s.orbitAlt0),
        leader: [r2(s.leader.x), r2(s.leader.y), r2(s.leader.z)], sweepZ: r2(s.sweepZ), hostile: s.hostile,
      };
      if (!mission && s.mode === 'MISSION' && s.missionId != null) mission = { id: s.missionId, status: 'RUNNING', wpIdx: s.wpIdx, total: s.waypoints.length };
    }
    return { type: 'snap', t: r2(this.T), seq: this.seq++, drones, swarms, mission };
  }
}
