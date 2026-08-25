import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createContext } from '../context.js';
import { openDb } from '../db/index.js';
import { Analyzer } from '../analyze/analyzer.js';
import { ToolRegistry } from '../tools/registry.js';

/**
 * MCP server: the live growth channel. Add this to ChatGPT (as an MCP
 * connector) and to Copilot CLI (mcp-config.json). As you chat, the assistant
 * calls `remember`/`link` to grow the network, and `recall`/`search` to reuse
 * accumulated context — a shared, persistent memory across both assistants.
 */
async function main() {
  const ctx = createContext();
  const db = openDb(ctx.config.dbPath);
  const analyzer = new Analyzer(db, ctx.store);
  const registry = new ToolRegistry(db, ctx.store);

  const server = new McpServer({ name: 'context-neuro-network', version: '0.1.0' });

  const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

  server.registerTool(
    'remember',
    {
      title: 'Remember context',
      description:
        'Store concepts and their relationships into the persistent neuro network. Use this to capture anything worth remembering across conversations.',
      inputSchema: {
        concepts: z
          .array(
            z.object({
              label: z.string(),
              kind: z.enum(['concept', 'entity', 'decision', 'topic']).optional(),
              summary: z.string().optional(),
            }),
          )
          .describe('Key concepts/entities/decisions to remember'),
        relations: z
          .array(z.object({ a: z.string(), b: z.string(), kind: z.string().optional() }))
          .optional()
          .describe('Relationships between the concepts (by label)'),
        snippet: z.string().optional().describe('Source text for provenance'),
        source: z.string().optional().describe('Origin label, e.g. chatgpt or copilot'),
      },
    },
    async (args) => {
      const src = ctx.store.upsertSource(
        (args.source as any) === 'chatgpt' || (args.source as any) === 'copilot'
          ? (args.source as any)
          : 'mcp',
        null,
        'MCP capture',
      );
      const res = await ctx.pipeline.remember({
        concepts: args.concepts,
        relations: args.relations,
        snippet: args.snippet,
        sourceId: src.id,
      });
      return ok({ ...res, stats: ctx.store.stats() });
    },
  );

  server.registerTool(
    'ingest_text',
    {
      title: 'Ingest raw text',
      description: 'Extract concepts and relations automatically from a block of text and grow the network.',
      inputSchema: { text: z.string(), source: z.string().optional() },
    },
    async (args) => {
      const src = ctx.store.upsertSource('mcp', null, args.source ?? 'MCP text');
      const res = await ctx.pipeline.ingestText(args.text, src.id);
      return ok({ ...res, stats: ctx.store.stats() });
    },
  );

  server.registerTool(
    'recall',
    {
      title: 'Recall around a concept',
      description: 'Retrieve what the network knows around a concept: its neighbors and recent observations.',
      inputSchema: { query: z.string(), depth: z.number().int().min(1).max(3).optional() },
    },
    async (args) => {
      const hits = ctx.store.search(args.query, 1);
      if (hits.length === 0) return ok({ found: false });
      const nb = ctx.store.neighborhood(hits[0].id, args.depth ?? 1);
      return ok({
        center: { id: hits[0].id, label: hits[0].label, kind: hits[0].kind, summary: hits[0].summary },
        neighbors: nb.nodes.filter((n) => n.id !== hits[0].id).map((n) => ({ label: n.label, kind: n.kind })),
        observations: ctx.store.observationsForNode(hits[0].id, 5).map((o) => o.snippet),
      });
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search the network',
      description: 'Full-text search across all remembered concepts.',
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional() },
    },
    async (args) =>
      ok({
        results: ctx.store
          .search(args.query, args.limit ?? 15)
          .map((n) => ({ id: n.id, label: n.label, kind: n.kind, weight: n.weight })),
      }),
  );

  server.registerTool(
    'link',
    {
      title: 'Link two concepts',
      description: 'Create or strengthen a relationship between two existing/new concepts.',
      inputSchema: { a: z.string(), b: z.string(), kind: z.string().optional() },
    },
    async (args) => {
      const a = ctx.store.upsertNode({ label: args.a });
      const b = ctx.store.upsertNode({ label: args.b });
      const edge = ctx.store.linkNodes(a.id, b.id, args.kind ?? 'related', 1);
      return ok({ ok: !!edge, a: a.label, b: b.label });
    },
  );

  server.registerTool(
    'patterns',
    {
      title: 'Analyze patterns & decisions',
      description: 'Run pattern/decision analysis and return the top discovered patterns.',
      inputSchema: {},
    },
    async () => {
      analyzer.run();
      return ok({ patterns: analyzer.list(30) });
    },
  );

  server.registerTool(
    'stats',
    { title: 'Network stats', description: 'Return size of the neuro network.', inputSchema: {} },
    async () => ok(ctx.store.stats()),
  );

  server.registerTool(
    'projects',
    {
      title: 'List projects',
      description:
        'List imported projects (toggleable groupings of conversations) with their enabled state and source counts.',
      inputSchema: {},
    },
    async () => ok({ projects: ctx.store.listProjects() }),
  );

  server.registerTool(
    'toggle_project',
    {
      title: 'Enable/disable a project',
      description:
        'Turn a project on or off. Disabled projects stay imported but are hidden from recall, search, stats and the graph view.',
      inputSchema: { id: z.number().int(), enabled: z.boolean() },
    },
    async (args) => {
      const project = ctx.store.setProjectEnabled(args.id, args.enabled);
      return ok(project ? { project } : { error: 'not found' });
    },
  );

  server.registerTool(
    'toggle_source',
    {
      title: 'Enable/disable a whole source',
      description:
        'Turn every project of an origin on or off at once (e.g. all ChatGPT or all Copilot content). Disabled content stays imported but is hidden from recall, search, stats and the graph view.',
      inputSchema: { origin: z.enum(['chatgpt', 'copilot', 'manual', 'mcp']), enabled: z.boolean() },
    },
    async (args) => {
      const changed = ctx.store.setOriginEnabled(args.origin, args.enabled);
      return ok({ origin: args.origin, enabled: args.enabled, changed });
    },
  );

  // Expose approved self-created tools dynamically.
  for (const tool of registry.list('active')) {
    server.registerTool(
      tool.name,
      { title: tool.name, description: tool.description ?? 'Self-created tool', inputSchema: {} },
      async () => ok(registry.execute(tool.name)),
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[context-neuro-network] MCP server ready on stdio\n');
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exit(1);
});
