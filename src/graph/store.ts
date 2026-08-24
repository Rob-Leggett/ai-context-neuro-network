import { EventEmitter } from 'node:events';
import type { DB } from '../db/index.js';
import { now } from '../db/index.js';
import type {
  GraphEdge,
  GraphEvent,
  GraphNode,
  NodeKind,
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

/**
 * Central graph store. All writes flow through here so that live subscribers
 * (WebSocket clients, the analyzer) get consistent update events.
 */
export class GraphStore extends EventEmitter {
  constructor(private db: DB) {
    super();
    this.setMaxListeners(100);
  }

  // ---- sources -------------------------------------------------------------

  upsertSource(kind: SourceKind, externalId: string | null, title?: string, meta?: object): Source {
    const ts = now();
    const existing = externalId
      ? (this.db
          .prepare(`SELECT * FROM sources WHERE kind = ? AND external_id = ?`)
          .get(kind, externalId) as any)
      : undefined;
    if (existing) return { ...existing, meta: parseMeta(existing.meta) };
    const info = this.db
      .prepare(
        `INSERT INTO sources(kind, external_id, title, created_at, meta) VALUES (?,?,?,?,?)`,
      )
      .run(kind, externalId, title ?? null, ts, meta ? JSON.stringify(meta) : null);
    return {
      id: Number(info.lastInsertRowid),
      kind,
      external_id: externalId,
      title: title ?? null,
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
    return {
      nodes: one(`SELECT COUNT(*) c FROM nodes`),
      edges: one(`SELECT COUNT(*) c FROM edges`),
      sources: one(`SELECT COUNT(*) c FROM sources`),
      observations: one(`SELECT COUNT(*) c FROM observations`),
    };
  }

  topNodes(limit = 2000): GraphNode[] {
    return (this.db
      .prepare(`SELECT * FROM nodes ORDER BY weight DESC LIMIT ?`)
      .all(limit) as any[]).map(hydrateNode);
  }

  edgesForNodes(ids: number[]): GraphEdge[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return (this.db
      .prepare(`SELECT * FROM edges WHERE src IN (${placeholders}) AND dst IN (${placeholders})`)
      .all(...ids, ...ids) as any[]).map(hydrateEdge);
  }

  neighborhood(nodeId: number, depth = 1): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const seen = new Set<number>([nodeId]);
    let frontier = [nodeId];
    const edges: GraphEdge[] = [];
    for (let d = 0; d < depth; d++) {
      if (frontier.length === 0) break;
      const placeholders = frontier.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM edges WHERE src IN (${placeholders}) OR dst IN (${placeholders})`)
        .all(...frontier, ...frontier) as any[];
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
    try {
      const match = q
        .split(/\s+/)
        .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
        .filter(Boolean)
        .map((t) => `${t}*`)
        .join(' ');
      if (!match) return [];
      const rows = this.db
        .prepare(
          `SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.rowid
           WHERE nodes_fts MATCH ? ORDER BY bm25(nodes_fts) LIMIT ?`,
        )
        .all(match, limit) as any[];
      return rows.map(hydrateNode);
    } catch {
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE label LIKE ? ORDER BY weight DESC LIMIT ?`)
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
