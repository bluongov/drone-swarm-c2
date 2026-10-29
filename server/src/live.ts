// WS /live: hello on connect, then snap at SNAP_HZ plus log / ripple / mission events to every client.
// Client -> server: {type:'cmd', name, args} -> world.applyCommand, reply {type:'cmdResult', ok, msg}.
import type { FastifyInstance } from 'fastify';
import { SC } from '../../sim-core.js';
import { originAllowed } from './config.ts';
import type { AppCtx } from './world.ts';

const MAX_MSG_BYTES = 2048;
const MAX_CLIENTS = 100;
const MAX_BUFFERED = 512 * 1024;
const CMDS = new Set(['mode', 'orbit', 'drones', 'auto']);     // missions go through REST

export function rawToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return (data as Buffer).toString('utf8');
}

// round numbers to 0.01 (1 cm in scene units) and turn Vector3-likes into [x,y,z]: keeps a 150-drone snap small
function replacer(_k: string, v: unknown): unknown {
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  if (v && typeof v === 'object' && (v as any).isVector3) return [(v as any).x, (v as any).y, (v as any).z];
  return v;
}
export const encode = (msg: unknown): string => JSON.stringify(msg, replacer);

export function helloMessage(ctx: AppCtx): unknown {
  const s = ctx.site;
  return {
    type: 'hello',
    serverT: ctx.world.T,
    tickHz: ctx.cfg.tickHz, snapHz: ctx.cfg.snapHz, seed: ctx.cfg.seed,
    worldKind: ctx.runner.kind,
    site: { id: s.id, name: s.name, origin: s.city.origin, base: s.city.base, theta: s.city.theta, cell: s.city.cell, n: s.city.n, sc: SC },
    obstacles: (ctx.world.obstacles ?? []).map((o: any) => ({ x: o.x, z: o.z, r: o.r, h: o.h, type: o.type, name: o.name, label: o.label })),
    landmarks: s.landmarks.map(l => ({ id: l.id, code: l.code, name: l.name, x: l.x, z: l.z, r: l.r, h: l.h, nfz: !!l.nfz })),
  };
}

export async function registerLive(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const clients = new Set<any>();
  let seq = 0;

  const send = (ws: any, text: string, droppable = false) => {
    if (ws.readyState !== 1) return;
    if (droppable && ws.bufferedAmount > MAX_BUFFERED) return;      // slow client: skip this snap instead of queueing
    ws.send(text);
  };
  const broadcast = (msg: unknown, droppable = false) => {
    if (!clients.size) return;
    const text = encode(msg);
    for (const ws of clients) send(ws, text, droppable);
    return text.length;
  };

  ctx.bus.on('snap', ({ snap }) => {
    if (!clients.size) return;
    const msg: any = { type: 'snap', ...snap, seq: ++seq, mission: ctx.missionSnapshot() ?? snap.mission ?? null, ext: ctx.ext.list(Date.now()) };
    msg.type = 'snap';
    const bytes = broadcast(msg, true);
    ctx.stats.lastSnapBytes = bytes ?? ctx.stats.lastSnapBytes;
    ctx.stats.lastSnapSeq = seq;
  });
  ctx.bus.on('log', e => broadcast({ type: 'log', lv: e.lv, msg: e.msg, t: e.t }));
  ctx.bus.on('ripple', e => broadcast({ type: 'ripple', x: e.x, y: e.y, z: e.z, color: e.color }));
  ctx.bus.on('mission', e => broadcast({ type: 'mission', id: e.id, status: e.status, wpIdx: e.wpIdx ?? null, total: e.total ?? null }));

  const ping = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closed */ }
    }
  }, 15_000);
  ping.unref();
  app.addHook('onClose', async () => { clearInterval(ping); for (const ws of clients) ws.terminate(); });

  app.get('/live', {
    websocket: true,
    preValidation: async (req, reply) => {
      if (!originAllowed(req.headers.origin, ctx.cfg)) return reply.code(403).send({ error: 'origin not allowed' });
    },
  }, (socket: any) => {
    if (clients.size >= MAX_CLIENTS) { socket.close(1013, 'too many clients'); return; }
    clients.add(socket); ctx.stats.liveClients = clients.size;
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    send(socket, JSON.stringify(helloMessage(ctx)));       // full precision: origin lat/lon

    let tokens = 20, last = Date.now();
    socket.on('message', (data: unknown, isBinary: boolean) => {
      const now = Date.now();
      tokens = Math.min(20, tokens + (now - last) / 1000 * 10); last = now;   // burst 20, ~10 msg/s sustained
      if (--tokens < 0) { socket.close(1008, 'rate limit'); return; }
      const reply = (ok: boolean, msg: string) => send(socket, JSON.stringify({ type: 'cmdResult', ok, msg }));
      if (isBinary) return reply(false, 'binary frames not supported');
      const text = rawToString(data);
      if (text.length > MAX_MSG_BYTES) { socket.close(1009, 'message too big'); return; }
      let m: any;
      try { m = JSON.parse(text); } catch { return reply(false, 'invalid JSON'); }
      if (!m || typeof m !== 'object' || m.type !== 'cmd') return reply(false, 'expected {type:"cmd", name, args}');
      if (typeof m.name !== 'string' || !CMDS.has(m.name)) return reply(false, `unknown command (allowed: ${[...CMDS].join(', ')})`);
      const args = m.args === undefined ? [] : m.args;
      if (!Array.isArray(args) || args.length > 4 || !args.every((a: unknown) => (typeof a === 'string' && a.length <= 32) || (typeof a === 'number' && Number.isFinite(a)) || typeof a === 'boolean')) {
        return reply(false, 'args must be an array of up to 4 short strings, numbers or booleans');
      }
      try {
        const r: any = ctx.world.applyCommand({ name: m.name, args });
        if (r === false) reply(false, `${m.name} rejected`);
        else if (r && typeof r === 'object' && 'ok' in r) reply(!!r.ok, String(r.msg ?? (r.ok ? 'ok' : 'rejected')));
        else reply(true, typeof r === 'string' ? r : 'ok');
      } catch (err) {
        reply(false, `command failed: ${(err as Error).message}`);
      }
    });
    const gone = () => { clients.delete(socket); ctx.stats.liveClients = clients.size; };
    socket.on('close', gone);
    socket.on('error', () => { gone(); try { socket.terminate(); } catch { /* ignore */ } });
  });
}
