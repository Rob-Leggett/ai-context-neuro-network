import type { DB } from '../db/index.js';
import { now } from '../db/index.js';
import type { GraphStore } from '../graph/store.js';
import { isGeneric, isMeaningfulDecision } from '../graph/generic.js';

export interface PatternResult {
  hubs: number;
  clusters: number;
  decisions: number;
  recurring: number;
}

/**
 * Analyzer: mines the accumulated graph for higher-order structure —
 * hubs (central concepts), tight co-occurrence clusters, recurring concepts,
 * and decisions. Results are stored in `patterns` and materialized as
 * `pattern` nodes so they appear in the network at the macro level.
 */
export class Analyzer {
  constructor(private db: DB, private store: GraphStore) {}

  run(): PatternResult {
    // Patterns are fully derived from the current graph — clear and recompute so
    // stale/filtered-out entries (e.g. old generic hubs) don't linger.
    this.db.prepare(`DELETE FROM patterns`).run();
    return {
      hubs: this.detectHubs(),
      clusters: this.detectClusters(),
      decisions: this.detectDecisions(),
      recurring: this.detectRecurring(),
    };
  }

  private savePattern(kind: string, title: string, description: string, score: number, members: number[]): void {
    this.db
      .prepare(
        `INSERT INTO patterns(kind, title, description, score, members, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(kind, title) DO UPDATE SET
           description = excluded.description, score = excluded.score, members = excluded.members`,
      )
      .run(kind, title.slice(0, 120), description.slice(0, 500), score, JSON.stringify(members), now());
  }

  /** Concepts with the most connections act as network hubs. */
  private detectHubs(): number {
    const rows = (this.db
      .prepare(
        `SELECT n.id, n.label, COUNT(e.id) deg FROM nodes n
         JOIN edges e ON e.src = n.id OR e.dst = n.id
         WHERE n.kind IN ('concept','entity','topic')
         GROUP BY n.id HAVING deg >= 5
         ORDER BY deg DESC LIMIT 120`,
      )
      .all() as { id: number; label: string; deg: number }[])
      .filter((r) => !isGeneric(r.label))
      .slice(0, 20);
    for (const r of rows) {
      this.savePattern('hub', `Hub: ${r.label}`, `${r.label} connects ${r.deg} concepts.`, r.deg, [r.id]);
    }
    return rows.length;
  }

  /** Strongly co-occurring concept pairs → candidate stable relationships. */
  private detectClusters(): number {
    const rows = (this.db
      .prepare(
        `SELECT e.src, e.dst, e.weight, a.label la, b.label lb FROM edges e
         JOIN nodes a ON a.id = e.src JOIN nodes b ON b.id = e.dst
         WHERE e.kind IN ('related','similar') AND e.weight >= 3
         ORDER BY e.weight DESC LIMIT 150`,
      )
      .all() as { src: number; dst: number; weight: number; la: string; lb: string }[])
      .filter((r) => !isGeneric(r.la) && !isGeneric(r.lb))
      .slice(0, 30);
    for (const r of rows) {
      this.savePattern(
        'co_occurrence',
        `${r.la} ↔ ${r.lb}`,
        `Frequently discussed together (strength ${r.weight.toFixed(1)}).`,
        r.weight,
        [r.src, r.dst],
      );
    }
    return rows.length;
  }

  private detectDecisions(): number {
    const rows = (this.db
      .prepare(`SELECT id, label, weight FROM nodes WHERE kind = 'decision' ORDER BY weight DESC LIMIT 200`)
      .all() as { id: number; label: string; weight: number }[])
      .filter((r) => isMeaningfulDecision(r.label))
      .slice(0, 50);
    for (const r of rows) {
      this.savePattern('decision', r.label, `Captured decision (reinforced ${r.weight.toFixed(1)}x).`, r.weight, [r.id]);
    }
    return rows.length;
  }

  /** Concepts mentioned many times = themes worth surfacing at macro level. */
  private detectRecurring(): number {
    const rows = (this.db
      .prepare(
        `SELECT id, label, mentions FROM nodes
         WHERE kind IN ('concept','entity','topic') AND mentions >= 4
         ORDER BY mentions DESC LIMIT 120`,
      )
      .all() as { id: number; label: string; mentions: number }[])
      .filter((r) => !isGeneric(r.label))
      .slice(0, 25);
    for (const r of rows) {
      this.savePattern('recurring', `Theme: ${r.label}`, `Mentioned ${r.mentions} times across sources.`, r.mentions, [r.id]);
    }
    return rows.length;
  }

  list(limit = 100): any[] {
    return this.db
      .prepare(`SELECT id, kind, title, description, score, members, created_at FROM patterns ORDER BY score DESC LIMIT ?`)
      .all(limit) as any[];
  }
}
