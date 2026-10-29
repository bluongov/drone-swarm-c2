// Static frontend: the server also serves the dashboard, so one command is enough.
//   GET /            → redirect to /index.html?server=ws://<same host>  (server mode)
//   GET /index.html  → the page (add ?server=… yourself, or open / instead)
// Only an allowlist of repo files is served (no directory listing, no dotfiles, no server/ or node_modules).
import { readFile } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const FILES = new Set(['index.html', 'sim-core.js', 'net-client.js', 'cac-shapes.js']);
const DIRS = ['assets'];
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.json': 'application/json',
};

function allowed(rel: string): boolean {
  if (rel.split('/').some(p => !p || p.startsWith('.'))) return false;
  return FILES.has(rel) || DIRS.some(d => rel.startsWith(d + '/'));
}

export function registerStatic(app: FastifyInstance): void {
  app.get('/', async (req, reply) => {
    const host = String(req.headers.host || '127.0.0.1:3000');
    const ws = (req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws') + '://' + host;
    return reply.redirect('/index.html?server=' + encodeURIComponent(ws));
  });
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
  app.get('/*', async (req, reply) => {
    const rel = decodeURIComponent((req.params as { '*': string })['*'] || '');
    if (!allowed(rel)) return reply.code(404).send({ error: 'not found' });
    const abs = resolve(ROOT, normalize(rel));
    if (!abs.startsWith(ROOT + sep)) return reply.code(404).send({ error: 'not found' });
    try {
      const body = await readFile(abs);
      return reply.type(TYPES[extname(abs)] || 'application/octet-stream').header('Cache-Control', 'no-cache').send(body);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });
}
