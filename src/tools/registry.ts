import type { DB } from '../db/index.js';
import { now } from '../db/index.js';
import type { GraphStore } from '../graph/store.js';
import { isGeneric } from '../graph/generic.js';

export type ToolStatus = 'proposed' | 'approved' | 'active' | 'rejected';

export interface ToolSpec {
  /** Safe, parameterized action the tool performs. No arbitrary code. */
  action: 'recall_around' | 'search_kind' | 'summarize_hub';
  params: Record<string, unknown>;
}

export interface ToolRecord {
  id: number;
  name: string;
  description: string | null;
  spec: ToolSpec;
  origin: 'auto' | 'manual';
  status: ToolStatus;
  rationale: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Registry of self-created tools. The system can PROPOSE new tools by observing
 * its own graph (e.g., a shortcut to recall a recurring hub). Proposals are
 * inert until a human approves them; approved tools are exposed by the MCP
 * server and executed through a fixed set of safe, parameterized actions.
 */
export class ToolRegistry {
  constructor(private db: DB, private store: GraphStore) {}

  private hydrate = (r: any): ToolRecord => ({ ...r, spec: JSON.parse(r.spec) });

  list(status?: ToolStatus): ToolRecord[] {
    const rows = status
      ? this.db.prepare(`SELECT * FROM tools WHERE status = ? ORDER BY updated_at DESC`).all(status)
      : this.db.prepare(`SELECT * FROM tools ORDER BY updated_at DESC`).all();
    return (rows as any[]).map(this.hydrate);
  }

  get(name: string): ToolRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM tools WHERE name = ?`).get(name);
    return r ? this.hydrate(r) : undefined;
  }

  propose(input: {
    name: string;
    description: string;
    spec: ToolSpec;
    rationale: string;
    origin?: 'auto' | 'manual';
  }): ToolRecord {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tools(name, description, spec, origin, status, rationale, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET description = excluded.description,
           spec = excluded.spec, rationale = excluded.rationale, updated_at = excluded.updated_at`,
      )
      .run(
        input.name,
        input.description,
        JSON.stringify(input.spec),
        input.origin ?? 'auto',
        'proposed',
        input.rationale,
        ts,
        ts,
      );
    return this.get(input.name)!;
  }

  setStatus(name: string, status: ToolStatus): ToolRecord | undefined {
    this.db.prepare(`UPDATE tools SET status = ?, updated_at = ? WHERE name = ?`).run(status, now(), name);
    return this.get(name);
  }

  /**
   * Inspect the network and propose useful new tools automatically.
   * Currently proposes a `recall_<hub>` shortcut for each dominant hub concept.
   */
  proposeFromPatterns(): ToolRecord[] {
    const hubs = this.db
      .prepare(
        `SELECT n.id, n.label, COUNT(e.id) deg FROM nodes n
         JOIN edges e ON (e.src = n.id OR e.dst = n.id)
          AND ((e.kind = 'related' AND e.weight > 1.5)
            OR (e.kind <> 'related' AND e.weight > 0.5))
         WHERE n.kind IN ('concept','entity','topic')
         GROUP BY n.id HAVING deg >= 6 ORDER BY deg DESC LIMIT 40`,
      )
      .all() as { id: number; label: string; deg: number }[];

    const proposed: ToolRecord[] = [];
    for (const h of hubs) {
      if (proposed.length >= 8) break;
      if (isGeneric(h.label)) continue;
      const slug = h.label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '').slice(0, 40);
      if (!slug) continue;
      const name = `recall_${slug}`;
      if (this.get(name)?.status === 'rejected') continue;
      proposed.push(
        this.propose({
          name,
          description: `Recall everything the network knows around "${h.label}".`,
          spec: { action: 'recall_around', params: { nodeId: h.id, depth: 1 } },
          rationale: `"${h.label}" is a hub connecting ${h.deg} concepts, so a dedicated recall shortcut is valuable.`,
          origin: 'auto',
        }),
      );
    }
    return proposed;
  }

  /** Execute an approved/active tool's safe action. */
  execute(name: string, args: Record<string, unknown> = {}): unknown {
    const tool = this.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (tool.status !== 'approved' && tool.status !== 'active') {
      throw new Error(`Tool "${name}" is not approved (status: ${tool.status}).`);
    }
    const p = { ...tool.spec.params, ...args };
    switch (tool.spec.action) {
      case 'recall_around': {
        const nb = this.store.neighborhood(Number(p.nodeId), Number(p.depth ?? 1));
        return {
          center: this.store.getNode(Number(p.nodeId)),
          nodes: nb.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind, weight: n.weight })),
          edges: nb.edges.length,
        };
      }
      case 'search_kind': {
        const results = this.store.search(String(p.query ?? ''), 25).filter((n) => n.kind === p.kind);
        return { results };
      }
      case 'summarize_hub': {
        const nb = this.store.neighborhood(Number(p.nodeId), 1);
        return {
          hub: this.store.getNode(Number(p.nodeId))?.label,
          related: nb.nodes.map((n) => n.label).slice(0, 30),
        };
      }
      default:
        throw new Error(`Unsupported action: ${(tool.spec as ToolSpec).action}`);
    }
  }
}
