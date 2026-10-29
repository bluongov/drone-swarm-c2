// tools/mock-server.mjs: stand-in for the real server (plan §3.3/§3.4) to develop the frontend/net-client without Postgres.
// Usage: node tools/mock-server.mjs   (PORT env overrides 3999; binds 127.0.0.1 only)
// WS /live: hello, then snaps at 10 Hz (~20 drones flying circles, swarm 'A'), random log/ripple events, cmd -> cmdResult.
// REST: /api/health, /api/missions (GET/POST), /api/missions/:id (+/start /abort), /api/missions/demo, /api/sites/:id[/world].
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 3999);
const HOST = '127.0.0.1';
const SNAP_HZ = 10;
const TICK_HZ = 30;
const SEED = 1234;

const t0 = process.hrtime.bigint();
const now = () => Number(process.hrtime.bigint() - t0) / 1e9; // server time, s

let nDrones = 20;
const swarm = { mode: 'PATROL', wpIdx: 0, waypoints: [], orbitCenter: [0, 0], orbitR0: 60, orbitAlt0: 40, leader: [0, 40, 0], sweepZ: 0, hostile: false };
let auto = true;
let seq = 0;
const missions = new Map();

const obstacles = [
  { x: 40, z: -30, r: 25, h: 60, type: 'nfz', name: 'NFZ-A', label: 'HEMISFERIC' },
  { x: -90, z: 70, r: 18, h: 50, type: 'nfz', name: 'NFZ-B', label: 'RANDOM' },
];
const landmarks = [{ name: 'Hemisferic', x: 40, z: -30, r: 25, h: 40 }];

const rd = (n) => Math.round(n * 1000) / 1000;

function droneRow(i, t) {
  // ring i%3 with different radius/speed, phase by index; scene units (1 unit = 2 m)
  const ring = i % 3;
  const R = 50 + ring * 25;
  const w = 0.20 - ring * 0.04; // rad/s
  const ph = (i / nDrones) * Math.PI * 2;
  const a = ph + w * t;
  const cx = swarm.mode === 'ORBIT' ? swarm.orbitCenter[0] : 0;
  const cz = swarm.mode === 'ORBIT' ? swarm.orbitCenter[1] : 0;
  const x = cx + R * Math.cos(a), z = cz + R * Math.sin(a);
  const y = 35 + ring * 8 + 3 * Math.sin(t * 0.7 + i);
  const vx = -R * w * Math.sin(a), vz = R * w * Math.cos(a);
  const vy = 3 * 0.7 * Math.cos(t * 0.7 + i);
  const ax = -R * w * w * Math.cos(a), az = -R * w * w * Math.sin(a);
  const battery = Math.max(5, 100 - ((t * 0.15 + i * 2.3) % 95));
  const link = 0.9 - 0.15 * ring + 0.05 * Math.sin(t + i);
  const temp = 38 + 4 * ring + 1.5 * Math.sin(t * 0.3 + i);
  return [`UAV-${String(i + 1).padStart(2, '0')}`, 'A', rd(x), rd(y), rd(z), rd(vx), rd(vy), rd(vz), rd(ax), rd(az), 'ACTIVE', rd(battery), rd(link), rd(temp)];
}

function mkSnap() {
  const t = now();
  const drones = [];
  for (let i = 0; i < nDrones; i++) drones.push(droneRow(i, t));
  const m = [...missions.values()].find((x) => x.status === 'RUNNING');
  return {
    type: 'snap', t: Math.round(t * 1e4) / 1e4, seq: ++seq, drones,
    swarms: { A: { ...swarm } },
    mission: m ? { id: m.id, status: m.status, wpIdx: m.wpIdx, total: m.waypoints.length } : null,
    ext: [['EXT-01', rd(80 * Math.cos(t * 0.1)), 30, rd(80 * Math.sin(t * 0.1)), 0, 90, 'ACTIVE']],
  };
}

const hello = () => ({
  type: 'hello', serverT: now(), tickHz: TICK_HZ, snapHz: SNAP_HZ,
  site: { id: 'valencia', name: 'Ciutat de les Arts i les Ciencies (mock)' },
  obstacles, landmarks, seed: SEED,
});

// ---- HTTP ----
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString();
  try { return s ? JSON.parse(s) : {}; } catch { return null; }
}
const missionView = (m) => ({ id: m.id, siteId: m.siteId, swarm: m.swarm, name: m.name, status: m.status, createdAt: m.createdAt, startedAt: m.startedAt ?? null, endedAt: m.endedAt ?? null });

function addMission(b) {
  const m = {
    id: randomUUID(), siteId: b.siteId ?? 'valencia', swarm: b.swarm ?? 'A', name: b.name ?? 'mission',
    status: 'PLANNED', waypoints: b.waypoints ?? [], createdAt: new Date().toISOString(), wpIdx: 0,
  };
  missions.set(m.id, m);
  return m;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, db: false, mock: true, tick: Math.round(now() * TICK_HZ), drones: nDrones });
  let mt;
  if (req.method === 'GET' && (mt = p.match(/^\/api\/sites\/([^/]+)$/))) {
    return send(res, 200, { id: mt[1], origin: [39.4575, -0.3556], base: [0, 0], theta: -40.5, cell: 4, n: 4, h: '', c: '', cover: '' });
  }
  if (req.method === 'GET' && (mt = p.match(/^\/api\/sites\/([^/]+)\/world$/))) {
    return send(res, 200, { landmarks, obstacles, nfz: { type: 'FeatureCollection', features: [] } });
  }
  if (p === '/api/missions' && req.method === 'GET') return send(res, 200, [...missions.values()].map(missionView));
  if (p === '/api/missions' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b || !Array.isArray(b.waypoints) || b.waypoints.length < 2) return send(res, 422, { conflicts: [{ type: 'TERRAIN', leg: 0, detail: 'need >= 2 waypoints' }] });
    const m = addMission(b);
    return send(res, 201, { id: m.id, status: m.status, warnings: [] });
  }
  if (p === '/api/missions/demo' && req.method === 'POST') {
    const m = addMission({
      name: 'demo loop',
      waypoints: [[39.4575, -0.3556], [39.4580, -0.3540], [39.4570, -0.3530], [39.4560, -0.3545], [39.4568, -0.3560]].map(([lat, lon]) => ({ lat, lon, alt_m: 60 })),
    });
    return send(res, 201, { id: m.id, status: m.status, warnings: [] });
  }
  if ((mt = p.match(/^\/api\/missions\/([^/]+)(?:\/(start|abort))?$/))) {
    const m = missions.get(mt[1]);
    if (!m) return send(res, 404, { error: 'not found' });
    if (!mt[2] && req.method === 'GET') return send(res, 200, { ...missionView(m), waypoints: m.waypoints });
    if (mt[2] === 'start' && req.method === 'POST') {
      if (m.status !== 'PLANNED') return send(res, 409, { error: `status ${m.status}` });
      if ([...missions.values()].some((x) => x.status === 'RUNNING' && x.swarm === m.swarm)) return send(res, 409, { error: 'swarm busy' });
      m.status = 'RUNNING'; m.startedAt = new Date().toISOString(); m.wpIdx = 0;
      broadcast({ type: 'mission', id: m.id, status: m.status, wpIdx: 0 });
      return send(res, 200, { id: m.id, status: m.status });
    }
    if (mt[2] === 'abort' && req.method === 'POST') {
      if (m.status !== 'RUNNING') return send(res, 409, { error: `status ${m.status}` });
      m.status = 'ABORTED'; m.endedAt = new Date().toISOString();
      broadcast({ type: 'mission', id: m.id, status: m.status, wpIdx: m.wpIdx });
      return send(res, 200, { id: m.id, status: m.status });
    }
  }
  send(res, 404, { error: 'not found' });
});

// ---- WebSocket ----
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url, `http://${HOST}`).pathname;
  if (path !== '/live') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}

function runCmd(name, args) {
  const a = args ?? [];
  switch (name) {
    case 'mode': {
      const m = String(a[0] ?? '').toUpperCase();
      if (!['PATROL', 'ORBIT', 'FORMATION', 'SCAN', 'MISSION'].includes(m)) return { ok: false, msg: `unknown mode ${a[0]}` };
      swarm.mode = m; return { ok: true, msg: `mode=${m}` };
    }
    case 'orbit': swarm.mode = 'ORBIT'; swarm.orbitCenter = [40, -30]; return { ok: true, msg: `orbit ${a[0] ?? ''}`.trim() };
    case 'drones': {
      const n = Number(a[0]);
      if (!Number.isInteger(n) || n < 1 || n > 150) return { ok: false, msg: 'drones=1..150' };
      nDrones = n; return { ok: true, msg: `drones=${n}` };
    }
    case 'auto': auto = String(a[0]) !== 'off'; return { ok: true, msg: `auto=${auto ? 'on' : 'off'}` };
    default: return { ok: false, msg: `unknown command ${name}` };
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(hello()));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m?.type !== 'cmd') return;
    ws.send(JSON.stringify({ type: 'cmdResult', id: m.id, name: m.name, ...runCmd(m.name, m.args) }));
  });
});

const LOGS = [['info', 'UAV-03 battery check ok'], ['ok', 'swarm A formation stable'], ['warn', 'UAV-07 link degraded'], ['info', 'waypoint reached']];
const timers = [];
timers.push(setInterval(() => broadcast(mkSnap()), 1000 / SNAP_HZ));
timers.push(setInterval(() => {
  const [lv, msg] = LOGS[Math.floor(Math.random() * LOGS.length)];
  broadcast({ type: 'log', lv, msg, t: now() });
  if (Math.random() < 0.5) broadcast({ type: 'ripple', x: (Math.random() - 0.5) * 100, y: 30, z: (Math.random() - 0.5) * 100, color: '#4af' });
}, 2000));
timers.push(setInterval(() => {
  for (const m of missions.values()) {
    if (m.status !== 'RUNNING') continue;
    m.wpIdx++;
    if (m.wpIdx >= m.waypoints.length) { m.status = 'DONE'; m.endedAt = new Date().toISOString(); }
    broadcast({ type: 'mission', id: m.id, status: m.status, wpIdx: Math.min(m.wpIdx, m.waypoints.length - 1) });
  }
}, 2000));

function shutdown() {
  timers.forEach(clearInterval);
  for (const c of wss.clients) c.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => console.log(`mock-server listening on ${HOST}:${PORT} (ws /live, rest /api)`));
