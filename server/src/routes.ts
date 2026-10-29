// REST: health and site data.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { circleFeature } from './site.ts';
import type { AppCtx } from './world.ts';

// CORS: GET/HEAD are public (local dev, any origin). Everything else only for localhost or ALLOWED_ORIGINS (see config.ts).
export function registerCors(app: FastifyInstance, allowed: (origin: string | undefined) => boolean) {
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin) return;
    const trusted = allowed(origin);
    if (trusted || req.method === 'GET' || req.method === 'HEAD') {
      reply.header('Access-Control-Allow-Origin', trusted ? origin : '*');
      reply.header('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      const wants = req.headers['access-control-request-method'];
      if (!trusted && wants !== 'GET' && wants !== 'HEAD') return reply.code(403).send();
      reply.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type');
      reply.header('Access-Control-Max-Age', '600');
      return reply.code(204).send();
    }
  });
}

export async function registerRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: `${what} not found` });

  app.get('/api/health', async () => {
    const snap = ctx.runner.lastSnap;
    return {
      ok: !ctx.runner.failed,
      db: !!ctx.db?.up,
      tickMs: ctx.runner.tickMs(),
      drones: snap?.drones?.length ?? 0,
      ext: ctx.ext.list(Date.now()).length,
      clients: ctx.stats.liveClients,
      telemetry: ctx.telemetry.stats(),
      world: ctx.runner.kind,
      site: { id: ctx.site.id, sources: ctx.site.sources },
      snap: { seq: ctx.stats.lastSnapSeq, bytes: ctx.stats.lastSnapBytes },
      ...(ctx.runner.failed ? { error: ctx.runner.failed } : {}),
    };
  });

  app.get<{ Params: { id: string } }>('/api/sites/:id', async (req, reply) => {
    const site = await ctx.getSite(req.params.id);
    if (!site) return notFound(reply, 'site');
    return reply.type('application/json; charset=utf-8').send(site.cityJson);
  });

  app.get<{ Params: { id: string } }>('/api/sites/:id/cac.js', async (req, reply) => {
    const site = await ctx.getSite(req.params.id);
    if (!site?.cacJs) return notFound(reply, 'cac.js');
    return reply.type('application/javascript; charset=utf-8').send(site.cacJs);
  });

  app.get<{ Params: { id: string } }>('/api/sites/:id/world', async (req, reply) => {
    const site = await ctx.getSite(req.params.id);
    if (!site) return notFound(reply, 'site');
    const obstacles = site.id === ctx.site.id ? (ctx.world.obstacles ?? []) : [];
    const nfz = site.nfz.features.length || !obstacles.length
      ? site.nfz
      : { type: 'FeatureCollection', features: obstacles.map((o: any, i: number) => circleFeature(site, o, i + 1)) };
    return {
      landmarks: site.landmarks.map(l => ({ id: l.id, code: l.code, name: l.name, x: l.x, z: l.z, r: l.r, h: l.h, nfz: !!l.nfz })),
      obstacles: obstacles.map((o: any) => ({ x: o.x, z: o.z, r: o.r, h: o.h, type: o.type, name: o.name, label: o.label })),
      nfz,
    };
  });
}
