import type { GraphStore } from '../graph/store.js';
import type { Embedder } from '../embeddings/embedder.js';
import { cosine } from '../embeddings/embedder.js';
import type { Config } from '../config.js';
import type { SourceKind } from '../graph/types.js';
import { extract } from './extract.js';

export interface IngestMessage {
  role: 'user' | 'assistant' | 'system' | string;
  text: string;
  ts?: number;
}

export interface IngestPipelineDeps {
  store: GraphStore;
  embedder: Embedder;
  config: Config;
}

/**
 * The Ingest pipeline is the growth engine of the network. Given raw messages
 * from any origin it: extracts concepts, reinforces/creates nodes, records
 * provenance, links co-occurring concepts, embeds new concepts, and forms
 * semantic "synapses" to similar existing concepts.
 */
export class IngestPipeline {
  constructor(private deps: IngestPipelineDeps) {}

  /** Ingest a whole conversation as one source. Returns growth stats. */
  async ingestConversation(
    origin: SourceKind,
    externalId: string | null,
    title: string | undefined,
    messages: IngestMessage[],
  ): Promise<{ conceptsTouched: number; edges: number; decisions: number }> {
    const source = this.deps.store.upsertSource(origin, externalId, title);
    let conceptsTouched = 0;
    let edges = 0;
    let decisions = 0;

    for (const msg of messages) {
      const text = (msg.text || '').trim();
      if (text.length < 4) continue;
      const res = await this.ingestText(text, source.id);
      conceptsTouched += res.conceptsTouched;
      edges += res.edges;
      decisions += res.decisions;
    }
    return { conceptsTouched, edges, decisions };
  }

  /** Ingest a single block of text against an existing source. */
  async ingestText(
    text: string,
    sourceId: number | null,
  ): Promise<{ conceptsTouched: number; edges: number; decisions: number }> {
    const { store } = this.deps;
    const res = extract(text);
    const labelToId = new Map<string, number>();

    for (const c of res.concepts) {
      const node = store.upsertNode({ label: c.label, kind: c.kind, reinforce: c.weight });
      labelToId.set(c.label, node.id);
      store.addObservation(node.id, sourceId, text);
      await this.ensureEmbeddingAndLink(node.id, c.label);
    }

    let edges = 0;
    for (const r of res.relations) {
      const a = labelToId.get(r.a);
      const b = labelToId.get(r.b);
      if (a && b && store.linkNodes(a, b, r.kind, 0.5)) edges++;
    }

    for (const d of res.decisions) {
      const node = store.upsertNode({ label: d, kind: 'decision', reinforce: 1.5 });
      store.addObservation(node.id, sourceId, text);
      // link the decision to concepts mentioned alongside it
      for (const id of labelToId.values()) {
        if (store.linkNodes(node.id, id, 'decided', 0.8)) edges++;
      }
    }

    return { conceptsTouched: res.concepts.length, edges, decisions: res.decisions.length };
  }

  /** Explicit high-quality capture used by the MCP `remember` tool. */
  async remember(input: {
    concepts: { label: string; kind?: 'concept' | 'entity' | 'decision' | 'topic'; summary?: string }[];
    relations?: { a: string; b: string; kind?: string }[];
    sourceId: number | null;
    snippet?: string;
  }): Promise<{ nodes: number; edges: number }> {
    const { store } = this.deps;
    const labelToId = new Map<string, number>();
    for (const c of input.concepts) {
      const node = store.upsertNode({
        label: c.label,
        kind: (c.kind as any) ?? 'concept',
        summary: c.summary ?? null,
        reinforce: 1.5,
      });
      labelToId.set(c.label.toLowerCase(), node.id);
      if (input.snippet) store.addObservation(node.id, input.sourceId, input.snippet);
      await this.ensureEmbeddingAndLink(node.id, `${c.label} ${c.summary ?? ''}`);
    }
    let edges = 0;
    for (const r of input.relations ?? []) {
      const a = labelToId.get(r.a.toLowerCase()) ?? store.upsertNode({ label: r.a }).id;
      const b = labelToId.get(r.b.toLowerCase()) ?? store.upsertNode({ label: r.b }).id;
      if (store.linkNodes(a, b, r.kind ?? 'related', 1)) edges++;
    }
    return { nodes: labelToId.size, edges };
  }

  /** Embed a new concept and connect it to semantically similar existing ones. */
  private async ensureEmbeddingAndLink(nodeId: number, text: string): Promise<void> {
    const { store, embedder, config } = this.deps;
    if (!embedder.enabled) return;
    if (store.getEmbedding(nodeId)) return; // already embedded
    const vec = await embedder.embed(text);
    if (!vec) return;
    // Compare against existing embeddings BEFORE inserting this one.
    const others = store.allEmbeddings();
    store.setEmbedding(nodeId, vec);
    const scored = others
      .filter((o) => o.node_id !== nodeId)
      .map((o) => ({ id: o.node_id, sim: cosine(vec, o.vec) }))
      .filter((o) => o.sim >= config.autoLinkThreshold)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 5);
    for (const s of scored) {
      store.linkNodes(nodeId, s.id, 'similar', s.sim, { sim: Number(s.sim.toFixed(3)) });
    }
  }
}
