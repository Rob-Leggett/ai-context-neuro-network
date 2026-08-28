import { EventEmitter } from 'node:events';
import type { DB } from '../db/index.js';
import { now } from '../db/index.js';
import type {
  GraphEdge,
  GraphEvent,
  GraphNode,
  NodeKind,
  Project,
  Source,
  SourceKind,
} from './types.js';

export function normalizeKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseMeta<T = Record<string, unknown>>(raw: unknown): T | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function hydrateNode(row: any): GraphNode {
  return { ...row, meta: parseMeta(row.meta) } as GraphNode;
}
function hydrateEdge(row: any): GraphEdge {
  return { ...row, meta: parseMeta(row.meta) } as GraphEdge;
}
function hydrateProject(row: any): Project {
  return { ...row, enabled: !!row.enabled, meta: parseMeta(row.meta) } as Project;
}

/**
 * Central graph store. All writes flow through here so that live subscribers
 * (WebSocket clients, the analyzer) get consistent update events.
 */
export class GraphStore extends EventEmitter {
  constructor(private db: DB) {
    super();
    this.setMaxListeners(100);
  }

  // ---- projects ------------------------------------------------------------

  /**
   * Insert or fetch a project (a toggleable grouping of sources, e.g. a ChatGPT
   * "project"). New projects are created enabled unless `enabled` is given.
   */
  upsertProject(input: {
    origin: SourceKind;
    externalId: string | null;
    name: string;
    enabled?: boolean;
    meta?: object | null;
  }): Project {
    const ts = now();
    const existing = this.db
      .prepare(`SELECT * FROM projects WHERE origin = ? AND external_id IS ?`)
      .get(input.origin, input.externalId) as any;
    if (existing) return hydrateProject(existing);
    const info = this.db
      .prepare(
        `INSERT INTO projects(origin, external_id, name, enabled, created_at, updated_at, meta)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        input.origin,
        input.externalId,
        input.name,
        input.enabled === false ? 0 : 1,
        ts,
        ts,
        input.meta ? JSON.stringify(input.meta) : null,
      );
    return hydrateProject(this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(Number(info.lastInsertRowid)));
  }

  getProject(id: number): Project | undefined {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
    return row ? hydrateProject(row) : undefined;
  }

  /** List every project with the number of sources attributed to it. */
  listProjects(): Project[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM sources s WHERE s.project_id = p.id) AS sources
           FROM projects p ORDER BY sources DESC, p.name ASC`,
      )
      .all() as any[];
    return rows.map((r) => ({ ...hydrateProject(r), sources: r.sources as number }));
  }

  /** Enable or disable a project. Disabled projects are hidden from graph views. */
  setProjectEnabled(id: number, enabled: boolean): Project | undefined {
    const info = this.db
      .prepare(`UPDATE projects SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, now(), id);
    if (info.changes === 0) return undefined;
    this.emit('graph', { type: 'reset' } satisfies GraphEvent);
    return this.getProject(id);
  }

  /** Enable or disable every project of an origin (e.g. all ChatGPT or all Copilot). */
  setOriginEnabled(origin: string, enabled: boolean): number {
    const info = this.db
      .prepare(`UPDATE projects SET enabled = ?, updated_at = ? WHERE origin = ?`)
      .run(enabled ? 1 : 0, now(), origin);
    if (info.changes > 0) this.emit('graph', { type: 'reset' } satisfies GraphEvent);
    return info.changes as number;
  }

  /** Rename a project (the ChatGPT export does not include project names). */
  renameProject(id: number, name: string): Project | undefined {
    const info = this.db
      .prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ?`)
      .run(name, now(), id);
    return info.changes === 0 ? undefined : this.getProject(id);
  }

  private disabledProjectIds(): number[] {
    return (this.db.prepare(`SELECT id FROM projects WHERE enabled = 0`).all() as { id: number }[]).map(
      (r) => r.id,
    );
  }

  /**
   * SQL subquery selecting node ids that are *hidden* because every observation
   * of them comes from a disabled project. Returns null when nothing is hidden
   * (fast path: no filtering needed). Ids are integers from the DB, safe to inline.
   */
  private hiddenNodeSubquery(): string | null {
    const disabled = this.disabledProjectIds();
    if (disabled.length === 0) return null;
    const list = disabled.join(',');
    return `SELECT o.node_id FROM observations o
            LEFT JOIN sources s ON s.id = o.source_id
            GROUP BY o.node_id
            HAVING SUM(CASE WHEN s.project_id IS NULL OR s.project_id NOT IN (${list}) THEN 1 ELSE 0 END) = 0`;
  }

  // ---- sources -------------------------------------------------------------

  upsertSource(
    kind: SourceKind,
    externalId: string | null,
    title?: string,
    meta?: object,
    projectId?: number | null,
  ): Source {
    const ts = now();
    const existing = externalId
      ? (this.db
          .prepare(`SELECT * FROM sources WHERE kind = ? AND external_id = ?`)
          .get(kind, externalId) as any)
      : undefined;
    if (existing) {
      // Backfill the project association on re-import of a pre-existing source.
      if (projectId != null && existing.project_id == null) {
        this.db.prepare(`UPDATE sources SET project_id = ? WHERE id = ?`).run(projectId, existing.id);
        existing.project_id = projectId;
      }
      return { ...existing, meta: parseMeta(existing.meta) };
    }
    const info = this.db
      .prepare(
        `INSERT INTO sources(kind, external_id, title, project_id, created_at, meta) VALUES (?,?,?,?,?,?)`,
      )
      .run(kind, externalId, title ?? null, projectId ?? null, ts, meta ? JSON.stringify(meta) : null);
    return {
      id: Number(info.lastInsertRowid),
      kind,
      external_id: externalId,
      title: title ?? null,
      project_id: projectId ?? null,
      created_at: ts,
      meta: (meta as Record<string, unknown>) ?? null,
    };
  }

  // ---- nodes ---------------------------------------------------------------

  getNode(id: number): GraphNode | undefined {
    const row = this.db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id);
    return row ? hydrateNode(row) : undefined;
  }

  getNodeByKey(key: string): GraphNode | undefined {
    const row = this.db.prepare(`SELECT * FROM nodes WHERE key = ?`).get(key);
    return row ? hydrateNode(row) : undefined;
  }

  /**
   * Insert or reinforce a node. Repeated mentions increase weight, which is
   * what makes frequently-discussed concepts "light up" in the network.
   */
  upsertNode(input: {
    label: string;
    kind?: NodeKind;
    summary?: string | null;
    meta?: object | null;
    reinforce?: number;
  }): GraphNode {
    const key = normalizeKey(input.label);
    const ts = now();
    const existing = this.getNodeByKey(key);
    const reinforce = input.reinforce ?? 1;
    if (existing) {
      this.db
        .prepare(
          `UPDATE nodes SET weight = weight + ?, mentions = mentions + 1,
             summary = COALESCE(?, summary), updated_at = ?
           WHERE id = ?`,
        )
        .run(reinforce, input.summary ?? null, ts, existing.id);
      const updated = this.getNode(existing.id)!;
      this.emit('graph', { type: 'node', node: updated } satisfies GraphEvent);
      return updated;
    }
    const info = this.db
      .prepare(
        `INSERT INTO nodes(key, label, kind, summary, weight, mentions, created_at, updated_at, meta)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        key,
        input.label.trim(),
        input.kind ?? 'concept',
        input.summary ?? null,
        reinforce,
        1,
        ts,
        ts,
        input.meta ? JSON.stringify(input.meta) : null,
      );
    const node = this.getNode(Number(info.lastInsertRowid))!;
    this.emit('graph', { type: 'node', node } satisfies GraphEvent);
    return node;
  }

  addObservation(nodeId: number, sourceId: number | null, snippet: string): void {
    this.db
      .prepare(`INSERT INTO observations(node_id, source_id, snippet, created_at) VALUES (?,?,?,?)`)
      .run(nodeId, sourceId, snippet.slice(0, 2000), now());
  }

  setEmbedding(nodeId: number, vec: Float32Array): void {
    this.db
      .prepare(
        `INSERT INTO node_embeddings(node_id, dim, vec) VALUES (?,?,?)
         ON CONFLICT(node_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec`,
      )
      .run(nodeId, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
  }

  getEmbedding(nodeId: number): Float32Array | undefined {
    const row = this.db.prepare(`SELECT dim, vec FROM node_embeddings WHERE node_id = ?`).get(nodeId) as
      | { dim: number; vec: Buffer }
      | undefined;
    if (!row) return undefined;
    return new Float32Array(row.vec.buffer, row.vec.byteOffset, row.dim);
  }

  allEmbeddings(): { node_id: number; vec: Float32Array }[] {
    const rows = this.db.prepare(`SELECT node_id, dim, vec FROM node_embeddings`).all() as {
      node_id: number;
      dim: number;
      vec: Buffer;
    }[];
    return rows.map((r) => ({
      node_id: r.node_id,
      vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.dim),
    }));
  }

  /** Bulk-fetch embeddings for a set of node ids (only those that have one). */
  embeddingsForNodes(ids: number[]): Map<number, Float32Array> {
    const out = new Map<number, Float32Array>();
    if (ids.length === 0) return out;
    const CHUNK = 800;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT node_id, dim, vec FROM node_embeddings WHERE node_id IN (${placeholders})`)
        .all(...slice) as { node_id: number; dim: number; vec: Buffer }[];
      for (const r of rows) {
        out.set(r.node_id, new Float32Array(r.vec.buffer, r.vec.byteOffset, r.dim));
      }
    }
    return out;
  }

  /** How many nodes currently have a stored embedding. */
  embeddingCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM node_embeddings`).get() as { c: number }).c;
  }

  /**
   * Count the active sources that mention each node. Used to reduce the visual
   * prominence of corpus-wide vocabulary without relying on a stop-word list.
   */
  sourceFrequencyForNodes(ids: number[]): { totalSources: number; byNode: Map<number, number> } {
    const byNode = new Map<number, number>();
    if (ids.length === 0) return { totalSources: 0, byNode };
    const activeSource = `s.project_id IS NULL OR EXISTS (
      SELECT 1 FROM projects p WHERE p.id = s.project_id AND p.enabled = 1
    )`;
    const totalSources = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM sources s WHERE ${activeSource}`).get() as { c: number }
    ).c;
    const CHUNK = 800;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT o.node_id, COUNT(DISTINCT o.source_id) AS sources
             FROM observations o
             JOIN sources s ON s.id = o.source_id
            WHERE o.node_id IN (${placeholders}) AND (${activeSource})
            GROUP BY o.node_id`,
        )
        .all(...slice) as { node_id: number; sources: number }[];
      for (const row of rows) byNode.set(row.node_id, row.sources);
    }
    return { totalSources, byNode };
  }

  /** Active source ids in which each node was observed. */
  sourceIdsForNodes(ids: number[]): Map<number, number[]> {
    const out = new Map<number, number[]>();
    if (ids.length === 0) return out;
    const activeSource = `s.project_id IS NULL OR EXISTS (
      SELECT 1 FROM projects p WHERE p.id = s.project_id AND p.enabled = 1
    )`;
    const CHUNK = 800;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT DISTINCT o.node_id, o.source_id
             FROM observations o
             JOIN sources s ON s.id = o.source_id
            WHERE o.node_id IN (${placeholders}) AND (${activeSource})`,
        )
        .all(...slice) as { node_id: number; source_id: number }[];
      for (const row of rows) {
        const sourceIds = out.get(row.node_id) ?? [];
        sourceIds.push(row.source_id);
        out.set(row.node_id, sourceIds);
      }
    }
    return out;
  }

  // ---- edges ---------------------------------------------------------------

  linkNodes(src: number, dst: number, kind = 'related', reinforce = 1, meta?: object): GraphEdge | null {
    if (src === dst) return null;
    // Keep a single canonical direction for undirected 'related'/'similar' edges.
    let a = src;
    let b = dst;
    if ((kind === 'related' || kind === 'similar') && a > b) {
      a = dst;
      b = src;
    }
    const ts = now();
    const existing = this.db
      .prepare(`SELECT * FROM edges WHERE src = ? AND dst = ? AND kind = ?`)
      .get(a, b, kind) as any;
    if (existing) {
      this.db
        .prepare(`UPDATE edges SET weight = weight + ?, updated_at = ? WHERE id = ?`)
        .run(reinforce, ts, existing.id);
      const edge = hydrateEdge(this.db.prepare(`SELECT * FROM edges WHERE id = ?`).get(existing.id));
      this.emit('graph', { type: 'edge', edge } satisfies GraphEvent);
      return edge;
    }
    const info = this.db
      .prepare(
        `INSERT INTO edges(src, dst, kind, weight, created_at, updated_at, meta) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(a, b, kind, reinforce, ts, ts, meta ? JSON.stringify(meta) : null);
    const edge = hydrateEdge(this.db.prepare(`SELECT * FROM edges WHERE id = ?`).get(Number(info.lastInsertRowid)));
    this.emit('graph', { type: 'edge', edge } satisfies GraphEvent);
    return edge;
  }

  // ---- queries -------------------------------------------------------------

  stats(): { nodes: number; edges: number; sources: number; observations: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    const hidden = this.hiddenNodeSubquery();
    if (!hidden) {
      return {
        nodes: one(`SELECT COUNT(*) c FROM nodes`),
        edges: one(`SELECT COUNT(*) c FROM edges`),
        sources: one(`SELECT COUNT(*) c FROM sources`),
        observations: one(`SELECT COUNT(*) c FROM observations`),
      };
    }
    const disabled = this.disabledProjectIds().join(',');
    return {
      nodes: one(`SELECT COUNT(*) c FROM nodes WHERE id NOT IN (${hidden})`),
      edges: one(
        `SELECT COUNT(*) c FROM edges WHERE src NOT IN (${hidden}) AND dst NOT IN (${hidden})`,
      ),
      sources: one(
        `SELECT COUNT(*) c FROM sources WHERE project_id IS NULL OR project_id NOT IN (${disabled})`,
      ),
      observations: one(
        `SELECT COUNT(*) c FROM observations o LEFT JOIN sources s ON s.id = o.source_id
           WHERE s.project_id IS NULL OR s.project_id NOT IN (${disabled})`,
      ),
    };
  }

  topNodes(limit = 2000): GraphNode[] {
    const hidden = this.hiddenNodeSubquery();
    const where = hidden ? `WHERE id NOT IN (${hidden})` : '';
    return (this.db
      .prepare(`SELECT * FROM nodes ${where} ORDER BY weight DESC LIMIT ?`)
      .all(limit) as any[]).map(hydrateNode);
  }

  edgesForNodes(ids: number[], minWeight = 0.5): GraphEdge[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return (this.db
      .prepare(`SELECT * FROM edges WHERE src IN (${placeholders}) AND dst IN (${placeholders}) AND weight > ?`)
      .all(...ids, ...ids, minWeight) as any[]).map(hydrateEdge);
  }

  /** Fetch reinforced edges touching any of the supplied nodes. */
  edgesTouchingNodes(ids: number[], minWeight = 0.5): GraphEdge[] {
    if (ids.length === 0) return [];
    const out = new Map<number, GraphEdge>();
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT * FROM edges
            WHERE (src IN (${placeholders}) OR dst IN (${placeholders})) AND weight > ?`,
        )
        .all(...slice, ...slice, minWeight) as any[];
      for (const row of rows) {
        const edge = hydrateEdge(row);
        out.set(edge.id, edge);
      }
    }
    return [...out.values()];
  }

  neighborhood(nodeId: number, depth = 1, minWeight = 0.5): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const seen = new Set<number>([nodeId]);
    let frontier = [nodeId];
    const edges: GraphEdge[] = [];
    for (let d = 0; d < depth; d++) {
      if (frontier.length === 0) break;
      const placeholders = frontier.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM edges WHERE (src IN (${placeholders}) OR dst IN (${placeholders})) AND weight > ?`)
        .all(...frontier, ...frontier, minWeight) as any[];
      const next: number[] = [];
      for (const r of rows) {
        edges.push(hydrateEdge(r));
        for (const nb of [r.src, r.dst]) {
          if (!seen.has(nb)) {
            seen.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
    const nodes = [...seen].map((id) => this.getNode(id)).filter(Boolean) as GraphNode[];
    // de-dup edges
    const uniq = new Map(edges.map((e) => [e.id, e]));
    return { nodes, edges: [...uniq.values()] };
  }

  search(query: string, limit = 25): GraphNode[] {
    const q = query.trim();
    if (!q) return [];
    const hidden = this.hiddenNodeSubquery();
    try {
      const match = q
        .split(/\s+/)
        .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
        .filter(Boolean)
        .map((t) => `${t}*`)
        .join(' ');
      if (!match) return [];
      const filter = hidden ? `AND n.id NOT IN (${hidden})` : '';
      const rows = this.db
        .prepare(
          `SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.rowid
           WHERE nodes_fts MATCH ? ${filter} ORDER BY bm25(nodes_fts) LIMIT ?`,
        )
        .all(match, limit) as any[];
      return rows.map(hydrateNode);
    } catch {
      const filter = hidden ? `AND id NOT IN (${hidden})` : '';
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE label LIKE ? ${filter} ORDER BY weight DESC LIMIT ?`)
        .all(`%${q}%`, limit) as any[];
      return rows.map(hydrateNode);
    }
  }

  observationsForNode(nodeId: number, limit = 20): { snippet: string; created_at: number; source_id: number | null }[] {
    return this.db
      .prepare(
        `SELECT snippet, created_at, source_id FROM observations WHERE node_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(nodeId, limit) as any[];
  }

}
