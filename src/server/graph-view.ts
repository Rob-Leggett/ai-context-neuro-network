import Graph from 'graphology';
import leiden from '@aflsolutions/graphology-communities-leiden';
import type { GraphStore } from '../graph/store.js';
import type { GraphEdge } from '../graph/types.js';
import { isGeneric } from '../graph/generic.js';
import { cosine } from '../embeddings/embedder.js';

export interface GraphViewNode {
  id: number;
  label: string;
  kind: string;
  weight: number;
  mentions: number;
  degree: number;
  /** flat community (kept for backwards compatibility; equals `world`) */
  community: number;
  /** coarse top-level cluster — a "world" */
  world: number;
  /** fine sub-cluster within a world (key `world:sub`) */
  sub: string;
}

export interface GraphViewEdge {
  id: number;
  source: number;
  target: number;
  kind: string;
  weight: number;
}

export interface SubCluster {
  key: string;
  label: string;
  size: number;
}

export interface World {
  id: number;
  label: string;
  size: number;
  subs: SubCluster[];
}

export interface GraphView {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  /** kept for backwards compatibility (equals `worlds`) */
  communities: { id: number; size: number; label: string }[];
  worlds: World[];
}

/**
 * Build a renderable, HIERARCHICAL view of the network:
 *   worlds (coarse Leiden)  ->  sub-clusters (fine Leiden)  ->  concepts
 *
 * Grouping runs the Leiden community-detection algorithm on a HYBRID backbone
 * that blends two signals on a shared 0..1 scale:
 *   - co-occurrence strength (how often concepts appear together, hub-normalized)
 *   - semantic similarity (cosine between on-device embeddings, when available)
 * so worlds reflect meaning as well as adjacency. Leiden (vs. Louvain) yields
 * deterministic, well-connected communities with no badly-connected artifacts.
 *
 * This powers the "zoom into different worlds" experience: zoom out to see a
 * handful of named worlds, zoom in to reveal their regions, then individual
 * concepts. Clusters are named after their highest-weight member.
 */
export function buildGraphView(store: GraphStore, limit = 1500): GraphView {
  const nodes = store.topNodes(limit);
  const idSet = new Set(nodes.map((n) => n.id));
  const edges = store.edgesForNodes([...idSet]);

  const g = new Graph({ type: 'undirected', multi: false });
  for (const n of nodes) g.addNode(String(n.id), { weight: n.weight });

  // ---- sparse "backbone" for clustering ------------------------------------
  // The raw co-occurrence graph is a hairball: generic hub concepts (e.g.
  // "string", "Type", "Name") co-occur with everything and merge unrelated
  // communities. We normalize each edge by its endpoints' weighted degree
  // (association strength) to suppress hub domination, then keep only each
  // node's few strongest links. Louvain on this backbone yields meaningful,
  // well-separated worlds — while the returned `edges` stay the full set for rendering.
  const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const wdeg = new Map<number, number>();
  const bestPerPair = new Map<string, GraphEdge>();
  for (const e of edges) {
    if (!idSet.has(e.src) || !idSet.has(e.dst) || e.src === e.dst) continue;
    wdeg.set(e.src, (wdeg.get(e.src) ?? 0) + e.weight);
    wdeg.set(e.dst, (wdeg.get(e.dst) ?? 0) + e.weight);
    const k = edgeKey(e.src, e.dst);
    const prev = bestPerPair.get(k);
    if (!prev || e.weight > prev.weight) bestPerPair.set(k, e);
  }
  const strength = (e: GraphEdge) =>
    e.weight / Math.sqrt((wdeg.get(e.src) ?? 1) * (wdeg.get(e.dst) ?? 1));

  // Keep each node's K strongest normalized edges (union → symmetric backbone).
  const K = 8;
  const perNode = new Map<number, { k: string; s: number }[]>();
  const push = (id: number, k: string, s: number) => {
    const arr = perNode.get(id) ?? [];
    arr.push({ k, s });
    perNode.set(id, arr);
  };
  for (const [k, e] of bestPerPair) {
    const s = strength(e);
    push(e.src, k, s);
    push(e.dst, k, s);
  }
  const backbone = new Set<string>();
  for (const [, arr] of perNode) {
    arr.sort((a, b) => b.s - a.s);
    for (const { k } of arr.slice(0, K)) backbone.add(k);
  }
  for (const k of backbone) {
    const e = bestPerPair.get(k)!;
    const s = String(e.src);
    const t = String(e.dst);
    if (g.hasNode(s) && g.hasNode(t) && !g.hasEdge(s, t)) {
      g.addEdge(s, t, { weight: strength(e) });
    }
  }

  // ---- semantic backbone (embeddings) --------------------------------------
  // Add each node's strongest semantic neighbours so concepts that mean the same
  // thing group together even when they rarely co-occur. Cosine and co-occurrence
  // strength both live in 0..1, so we merge by taking the max weight per pair.
  const emb = store.embeddingsForNodes([...idSet]);
  if (emb.size > 1) {
    const SEM_MIN = 0.55; // ignore weak/coincidental similarity
    const SEM_K = 6; // strongest semantic links kept per node
    const ids = [...emb.keys()];
    const vecs = ids.map((id) => emb.get(id)!);
    for (let i = 0; i < ids.length; i++) {
      const scored: { j: number; sim: number }[] = [];
      for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        const sim = cosine(vecs[i], vecs[j]);
        if (sim >= SEM_MIN) scored.push({ j, sim });
      }
      scored.sort((a, b) => b.sim - a.sim);
      for (const { j, sim } of scored.slice(0, SEM_K)) {
        const s = String(ids[i]);
        const t = String(ids[j]);
        if (!g.hasNode(s) || !g.hasNode(t)) continue;
        if (g.hasEdge(s, t)) {
          const cur = (g.getEdgeAttribute(s, t, 'weight') as number) ?? 0;
          if (sim > cur) g.setEdgeAttribute(s, t, 'weight', sim);
        } else {
          g.addEdge(s, t, { weight: sim });
        }
      }
    }
  }

  // Two resolutions on the weighted backbone: low = coarse "worlds", high = fine "regions".
  let worldOf: Record<string, number> = {};
  let subOf: Record<string, number> = {};
  try {
    if (g.order > 0 && g.size > 0) {
      worldOf = leiden(g, { resolution: 0.3 });
      subOf = leiden(g, { resolution: 0.9 });
    }
  } catch {
    worldOf = {};
    subOf = {};
  }

  const degree = new Map<number, number>();
  for (const e of edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }

  const viewNodes: GraphViewNode[] = nodes.map((n) => {
    const world = worldOf[String(n.id)] ?? 0;
    const subRaw = subOf[String(n.id)] ?? 0;
    // Nest sub within world so each sub-cluster belongs to exactly one world.
    const sub = `${world}:${subRaw}`;
    return {
      id: n.id,
      label: n.label,
      kind: n.kind,
      weight: n.weight,
      mentions: n.mentions,
      degree: degree.get(n.id) ?? 0,
      community: world,
      world,
      sub,
    };
  });

  const viewEdges: GraphViewEdge[] = edges
    .filter((e) => idSet.has(e.src) && idSet.has(e.dst))
    .map((e) => ({ id: e.id, source: e.src, target: e.dst, kind: e.kind, weight: e.weight }));

  // ---- build the worlds -> subs hierarchy with names -----------------------
  // Prefer the highest-weight *non-generic* member as a cluster's name so worlds
  // read as real topics (e.g. "AWS", "Terraform") instead of "string" / "e.g".
  const topLabel = (members: GraphViewNode[]) => {
    const sorted = members.slice().sort((a, b) => b.weight - a.weight);
    const named = sorted.find((m) => !isGeneric(m.label));
    return (named ?? sorted[0])?.label ?? 'cluster';
  };

  const byWorld = new Map<number, GraphViewNode[]>();
  const bySub = new Map<string, GraphViewNode[]>();
  for (const n of viewNodes) {
    if (!byWorld.has(n.world)) byWorld.set(n.world, []);
    byWorld.get(n.world)!.push(n);
    if (!bySub.has(n.sub)) bySub.set(n.sub, []);
    bySub.get(n.sub)!.push(n);
  }

  const worlds: World[] = [...byWorld.entries()]
    .map(([id, members]) => {
      const subKeys = [...new Set(members.map((m) => m.sub))];
      const subs: SubCluster[] = subKeys
        .map((key) => {
          const subMembers = bySub.get(key)!;
          return { key, label: topLabel(subMembers), size: subMembers.length };
        })
        .sort((a, b) => b.size - a.size);
      return { id, label: topLabel(members), size: members.length, subs };
    })
    .sort((a, b) => b.size - a.size);

  const communities = worlds.map((w) => ({ id: w.id, size: w.size, label: w.label }));

  return { nodes: viewNodes, edges: viewEdges, communities, worlds };
}
