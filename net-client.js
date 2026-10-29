// net-client.js: browser + Node 26 client for the drone-swarm server (protocol: docs/implementation-plan.md §3.3/§3.4).
// Plain ES module, no imports. Uses the global WebSocket, fetch and performance (present in browsers and Node 26).
//
// const net = connect('ws://127.0.0.1:3000/live', { onHello, onLog, onRipple, onMission, onCmdResult, onStatus });
// net.status               'connecting' | 'open' | 'closed'
// net.lastHello            last hello message (or null)
// net.sendCmd(name, args)  Promise<{ok, msg}> (never rejects; ok:false on timeout / not connected)
// net.sample(nowMs?)       interpolated state for the render loop. nowMs = client clock in ms (performance.now()),
//                          default = now. The 0.12 s render lag is applied inside. Returns null before the first snap.
// net.sampleAt(serverT)    same, for an explicit server time in seconds (tests, replays).
// net.serverTime(nowMs?)   estimated current server time in seconds.
// net.close()              stop for good (no reconnect).
//
// Units are the server's: scene units (1 unit = 2 m), seconds.

export const RENDER_LAG = 0.12; // s behind the latest server time estimate
export const MAX_EXTRAPOLATION = 0.1; // s, never extrapolate further than this past the newest snap
export const BUFFER_SNAPS = 10;
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 5000;
export const CMD_TIMEOUT_MS = 5000;
const OFFSET_WINDOW = 50; // snaps (5 s at 10 Hz) used by the min-latency clock estimator

const nowSec = () => performance.now() / 1000;

/** ws://h:p/live -> http://h:p ; wss -> https. Already-http bases are returned without path. */
export function httpBase(url) {
  const u = new URL(url);
  u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
  return u.origin;
}

function parseSnap(m, arrival) {
  const drones = new Map();
  for (const r of m.drones || []) {
    drones.set(r[0], {
      swarm: r[1], x: r[2], y: r[3], z: r[4], vx: r[5], vy: r[6], vz: r[7],
      ax: r[8], az: r[9], state: r[10], battery: r[11], link: r[12], temp: r[13],
    });
  }
  return { t: m.t, seq: m.seq, arrival, drones, swarms: m.swarms || {}, mission: m.mission ?? null, ext: m.ext || [] };
}

const lerp = (a, b, k) => a + (b - a) * k;

function interpDrone(a, b, k) {
  return {
    swarm: b.swarm, state: k < 0.5 ? a.state : b.state,
    x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), z: lerp(a.z, b.z, k),
    vx: lerp(a.vx, b.vx, k), vy: lerp(a.vy, b.vy, k), vz: lerp(a.vz, b.vz, k),
    ax: lerp(a.ax, b.ax, k), az: lerp(a.az, b.az, k),
    battery: lerp(a.battery, b.battery, k), link: lerp(a.link, b.link, k), temp: lerp(a.temp, b.temp, k),
  };
}

function extrapDrone(d, dt) {
  return { ...d, x: d.x + d.vx * dt, y: d.y + d.vy * dt, z: d.z + d.vz * dt };
}

export function connect(url, handlers = {}) {
  const { onHello, onLog, onRipple, onMission, onCmdResult, onStatus } = handlers;
  let ws = null;
  let closed = false;
  let backoff = BACKOFF_MIN_MS;
  let retryTimer = null;
  let snaps = []; // ascending by t
  let offsets = []; // arrival - t, recent
  let lastRenderT = -Infinity;
  let cmdSeq = 0;
  const pending = new Map(); // id -> {resolve, timer}

  const api = {
    status: 'connecting',
    lastHello: null,
    sendCmd, close, sample, sampleAt, serverTime,
    get snapCount() { return snaps.length; },
    get latest() { return snaps.length ? snaps[snaps.length - 1] : null; },
  };

  function setStatus(s) {
    if (api.status === s) return;
    api.status = s;
    try { onStatus?.(s); } catch (e) { console.error('onStatus', e); }
  }

  function resetClock() { snaps = []; offsets = []; lastRenderT = -Infinity; }

  function failPending(msg) {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, msg }); pending.delete(id); }
  }

  function open() {
    if (closed) return;
    setStatus('connecting');
    let sock;
    try { sock = new WebSocket(url); } catch (e) { scheduleRetry(); return; }
    ws = sock;
    sock.onopen = () => { if (ws === sock) { backoff = BACKOFF_MIN_MS; setStatus('open'); } };
    sock.onmessage = (ev) => { if (ws === sock) onMessage(ev.data); };
    sock.onerror = () => {}; // close always follows
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      failPending('disconnected');
      if (closed) { setStatus('closed'); return; }
      setStatus('closed');
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    if (closed || retryTimer) return;
    const d = backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, d);
  }

  function onMessage(data) {
    let m;
    try { m = JSON.parse(typeof data === 'string' ? data : String(data)); } catch { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'hello':
        api.lastHello = m;
        resetClock(); // server (re)started: its clock may have reset
        try { onHello?.(m); } catch (e) { console.error('onHello', e); }
        break;
      case 'snap': addSnap(m); break;
      case 'log': try { onLog?.(m); } catch (e) { console.error('onLog', e); } break;
      case 'ripple': try { onRipple?.(m); } catch (e) { console.error('onRipple', e); } break;
      case 'mission': try { onMission?.(m); } catch (e) { console.error('onMission', e); } break;
      case 'cmdResult': onCmdResult_(m); break;
      default: break;
    }
  }

  function addSnap(m) {
    if (typeof m.t !== 'number') return;
    const arrival = nowSec();
    const last = snaps[snaps.length - 1];
    if (last && m.t < last.t - 1) resetClock(); // clock went backwards by a lot: restart without hello
    const prev = snaps[snaps.length - 1];
    if (prev && m.t <= prev.t) return; // duplicate / out of order
    snaps.push(parseSnap(m, arrival));
    if (snaps.length > BUFFER_SNAPS) snaps.shift();
    offsets.push(arrival - m.t);
    if (offsets.length > OFFSET_WINDOW) offsets.shift();
  }

  function onCmdResult_(m) {
    const res = { ok: !!m.ok, msg: m.msg ?? '' };
    let p = null;
    if (m.id !== undefined && pending.has(m.id)) { p = pending.get(m.id); pending.delete(m.id); }
    else if (m.id === undefined && pending.size) { const id = pending.keys().next().value; p = pending.get(id); pending.delete(id); }
    if (p) { clearTimeout(p.timer); p.resolve(res); }
    try { onCmdResult?.(m); } catch (e) { console.error('onCmdResult', e); }
  }

  function sendCmd(name, args = []) {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== 1) { resolve({ ok: false, msg: 'not connected' }); return; }
      const id = ++cmdSeq;
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, msg: 'timeout' }); }, CMD_TIMEOUT_MS);
      pending.set(id, { resolve, timer });
      try { ws.send(JSON.stringify({ type: 'cmd', name, args, id })); }
      catch (e) { clearTimeout(timer); pending.delete(id); resolve({ ok: false, msg: String(e?.message || e) }); }
    });
  }

  /** Server time estimate in seconds. Offset = min(arrival - t) over the recent snaps (lowest-latency sample). */
  function serverTime(nowMs = performance.now()) {
    if (!offsets.length) return null;
    let off = Infinity;
    for (const o of offsets) if (o < off) off = o;
    return nowMs / 1000 - off;
  }

  function sample(nowMs = performance.now()) {
    const st = serverTime(nowMs);
    if (st === null) return null;
    let rt = st - RENDER_LAG;
    if (rt < lastRenderT && lastRenderT - rt < 1) rt = lastRenderT; // never go backwards (clock estimator jitter)
    lastRenderT = rt;
    return sampleAt(rt);
  }

  function sampleAt(rt) {
    const n = snaps.length;
    if (!n) return null;
    const first = snaps[0], last = snaps[n - 1];
    if (rt <= first.t) return fromSnap(first, first.t);
    if (rt >= last.t) {
      const dt = Math.min(rt - last.t, MAX_EXTRAPOLATION);
      if (dt <= 0) return fromSnap(last, last.t);
      const s = fromSnap(last, last.t + dt);
      for (const [id, d] of s.drones) s.drones.set(id, extrapDrone(d, dt));
      return s;
    }
    let i = 1;
    while (snaps[i].t < rt) i++;
    const a = snaps[i - 1], b = snaps[i];
    const k = (rt - a.t) / (b.t - a.t);
    const drones = new Map();
    for (const [id, db] of b.drones) {
      const da = a.drones.get(id);
      drones.set(id, da ? interpDrone(da, db, k) : { ...db });
    }
    for (const [id, da] of a.drones) if (!drones.has(id)) drones.set(id, { ...da });
    const src = k < 0.5 ? a : b;
    return { t: rt, drones, swarms: src.swarms, mission: src.mission, ext: src.ext };
  }

  function fromSnap(s, t) {
    const drones = new Map();
    for (const [id, d] of s.drones) drones.set(id, { ...d });
    return { t, drones, swarms: s.swarms, mission: s.mission, ext: s.ext };
  }

  function close() {
    closed = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    failPending('closed');
    const w = ws;
    ws = null;
    if (w) { try { w.close(); } catch { /* ignore */ } }
    setStatus('closed');
  }

  open();
  return api;
}

export class ApiError extends Error {
  constructor(status, body, url) {
    super(`HTTP ${status} ${url}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body; // parsed JSON (e.g. {conflicts:[...]} on 422) or text
  }
}

/** REST helpers. `base` = 'http://host:3000' (or pass httpBase(wsUrl)). Non-2xx throws ApiError with .status/.body. */
export const api = (base) => {
  const root = String(base).replace(/\/+$/, '');
  async function req(method, path, body) {
    const url = root + path;
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) throw new ApiError(res.status, data, url);
    return data;
  }
  const enc = encodeURIComponent;
  return {
    health: () => req('GET', '/api/health'),
    site: (id) => req('GET', `/api/sites/${enc(id)}`),
    siteWorld: (id) => req('GET', `/api/sites/${enc(id)}/world`),
    missions: () => req('GET', '/api/missions'),
    mission: (id) => req('GET', `/api/missions/${enc(id)}`),
    createMission: (body) => req('POST', '/api/missions', body),
    startMission: (id) => req('POST', `/api/missions/${enc(id)}/start`),
    abortMission: (id) => req('POST', `/api/missions/${enc(id)}/abort`),
    demoMission: () => req('POST', '/api/missions/demo'),
  };
};
