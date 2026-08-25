import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { createContext } from '../context.js';
import { openDb } from '../db/index.js';
import { Analyzer } from '../analyze/analyzer.js';
import { ToolRegistry } from '../tools/registry.js';
import { buildGraphView } from './graph-view.js';
import type { GraphEvent } from '../graph/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const ctx = createContext();
  const db = openDb(ctx.config.dbPath);
  const analyzer = new Analyzer(db, ctx.store);
  const registry = new ToolRegistry(db, ctx.store);

  const app = Fastify({ logger: { level: process.env.CNN_LOG || 'info' } });
  // Tolerate empty-body JSON POSTs (e.g. /api/analyze) instead of 400-ing.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string)?.trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err: any) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  await app.register(fastifyWebsocket);

  // ---- static frontend (built by `npm run web:build`) ----------------------
  const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  }

  // ---- REST API ------------------------------------------------------------
  app.get('/api/stats', async () => ({
    ...ctx.store.stats(),
    embeddings: ctx.embedder.enabled,
  }));

  app.get('/api/graph', async (req) => {
    const limit = Number((req.query as any)?.limit ?? 1500);
    return buildGraphView(ctx.store, limit);
  });

  app.get('/api/node/:id', async (req) => {
    const id = Number((req.params as any).id);
    const node = ctx.store.getNode(id);
    if (!node) return { error: 'not found' };
    const nb = ctx.store.neighborhood(id, 1);
    return {
      node,
      neighbors: nb.nodes.filter((n) => n.id !== id),
      edges: nb.edges,
      observations: ctx.store.observationsForNode(id, 15),
    };
  });

  app.get('/api/search', async (req) => {
    const q = String((req.query as any)?.q ?? '');
    return { results: ctx.store.search(q, 30) };
  });

  app.post('/api/ingest', async (req) => {
    const body = (req.body ?? {}) as { text?: string; title?: string };
    if (!body.text) return { error: 'text required' };
    const source = ctx.store.upsertSource('manual', null, body.title ?? 'Manual note');
    const res = await ctx.pipeline.ingestText(body.text, source.id);
    return { ok: true, ...res, stats: ctx.store.stats() };
  });

  app.post('/api/analyze', async () => analyzer.run());
  app.get('/api/patterns', async () => ({ patterns: analyzer.list(200) }));

  // ---- projects (toggleable groupings of imported conversations) -----------
  app.get('/api/projects', async () => ({ projects: ctx.store.listProjects() }));
  app.post('/api/projects/:id/:decision', async (req) => {
    const { id, decision } = req.params as { id: string; decision: string };
    if (decision !== 'enable' && decision !== 'disable') {
      return { error: 'decision must be enable|disable' };
    }
    const project = ctx.store.setProjectEnabled(Number(id), decision === 'enable');
    if (!project) return { error: 'not found' };
    return { project };
  });
  app.patch('/api/projects/:id', async (req) => {
    const id = Number((req.params as any).id);
    const body = (req.body ?? {}) as { name?: string; enabled?: boolean };
    let project = ctx.store.getProject(id);
    if (!project) return { error: 'not found' };
    if (typeof body.name === 'string' && body.name.trim()) {
      project = ctx.store.renameProject(id, body.name.trim());
    }
    if (typeof body.enabled === 'boolean') {
      project = ctx.store.setProjectEnabled(id, body.enabled);
    }
    return { project };
  });

  // ---- self-updating tools -------------------------------------------------
  app.get('/api/tools', async () => ({ tools: registry.list() }));
  app.post('/api/tools/propose', async () => ({ proposed: registry.proposeFromPatterns() }));
  app.post('/api/tools/:name/:decision', async (req) => {
    const { name, decision } = req.params as { name: string; decision: string };
    const status = decision === 'approve' ? 'active' : decision === 'reject' ? 'rejected' : null;
    if (!status) return { error: 'decision must be approve|reject' };
    return { tool: registry.setStatus(name, status) };
  });
  app.post('/api/tools/:name/run', async (req) => {
    const { name } = req.params as { name: string };
    try {
      return { result: registry.execute(name, (req.body ?? {}) as Record<string, unknown>) };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  // ---- live updates over WebSocket ----------------------------------------
  app.get('/ws', { websocket: true }, (socket) => {
    const onEvent = (ev: GraphEvent) => {
      try {
        socket.send(JSON.stringify(ev));
      } catch {
        /* client gone */
      }
    };
    ctx.store.on('graph', onEvent);
    socket.on('close', () => ctx.store.off('graph', onEvent));
    socket.send(JSON.stringify({ type: 'hello', stats: ctx.store.stats() }));
  });

  return { app, ctx };
}

async function main() {
  const { app, ctx } = await buildServer();
  try {
    await app.listen({ host: ctx.config.host, port: ctx.config.port });
    app.log.info(`Context Neuro Network UI: http://${ctx.config.host}:${ctx.config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
