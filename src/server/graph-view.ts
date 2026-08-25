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

/** Target number of top-level "worlds" shown in the macro view. */
const TARGET_WORLDS = 16;

/**
 * Fold a fine community partition into at most `target` "worlds". The largest
 * communities become anchors; every smaller community is merged into the anchor
 * it is most strongly connected to across the backbone (summed edge weight),
 * falling back to embedding-centroid cosine, then to the largest anchor. This
 * keeps the big coherent cores intact while removing the long tail of tiny,
 * separately-coloured fragments that make the macro view unreadable.
 */
function consolidateWorlds(
  worldOf: Record<string, number>,
  g: Graph,
  emb: Map<number, Float32Array>,
  target: number,
): Record<string, number> {
  const members = new Map<number, string[]>();
  for (const id of Object.keys(worldOf)) {
    const c = worldOf[id];
    if (!members.has(c)) members.set(c, []);
    members.get(c)!.push(id);
  }
  const comms = [...members.keys()];
  if (comms.length <= target) return worldOf;

  const anchors = comms
    .slice()
    .sort((a, b) => members.get(b)!.length - members.get(a)!.length)
    .slice(0, target);
  const anchorSet = new Set(anchors);
  const largestAnchor = anchors[0];

  // Mean embedding centroid per community (for tie-breaks / disconnected fragments).
  const centroid = new Map<number, Float32Array>();
  for (const [c, ids] of members) {
    let sum: Float32Array | null = null;
    let n = 0;
    for (const id of ids) {
      const v = emb.get(Number(id));
      if (!v) continue;
      if (!sum) sum = new Float32Array(v.length);
      for (let i = 0; i < v.length; i++) sum[i] += v[i];
      n++;
    }
    if (sum && n > 0) {
      for (let i = 0; i < sum.length; i++) sum[i] /= n;
      centroid.set(c, sum);
    }
  }

  const remap = new Map<number, number>();
  for (const c of comms) if (anchorSet.has(c)) remap.set(c, c);

  for (const c of comms) {
    if (anchorSet.has(c)) continue;
    // Merge each fragment into its best-fit anchor: semantically nearest by
    // embedding centroid, falling back to strongest backbone connection.
    let best: number | null = null;
    const cv = centroid.get(c);
    if (cv) {
      let bestSim = -Infinity;
      for (const a of anchors) {
        const av = centroid.get(a);
        if (!av) continue;
        const sim = cosine(cv, av);
        if (sim > bestSim) ((bestSim = sim), (best = a));
      }
    }
    if (best === null) {
      const strength = new Map<number, number>();
      for (const node of members.get(c)!) {
        if (!g.hasNode(node)) continue;
        g.forEachNeighbor(node, (nb: string, attr: { weight?: number }) => {
          const nc = worldOf[nb];
          if (anchorSet.has(nc)) strength.set(nc, (strength.get(nc) ?? 0) + (attr.weight ?? 0));
        });
      }
      let bestVal = -Infinity;
      for (const [a, v] of strength) if (v > bestVal) ((bestVal = v), (best = a));
    }
    remap.set(c, best ?? largestAnchor);
  }

  const out: Record<string, number> = {};
  for (const id of Object.keys(worldOf)) out[id] = remap.get(worldOf[id])!;
  return out;
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
 * well-connected communities with no badly-connected artifacts, then a
 * consolidation pass folds the long tail of tiny fragments into the nearest of
 * the ~16 largest worlds so the macro view stays readable.
 *
 * This powers the "zoom into different worlds" experience: zoom out to see a
 * handful of named worlds, zoom in to reveal their regions, then individual
 * concepts. Clusters are named after their highest-weight member.
 */
export function buildGraphView(store: GraphStore, limit = 1500): GraphView {
  // Generic tokens (e.g. "string", "Date", "JSON") co-occur with almost
  // everything and carry huge weight, so they bridge unrelated worlds and, when
  // rendered, dominate the view as giant meaningless hubs. They are already
  // filtered from names/analysis; we drop them from the graph view entirely so
  // worlds are shaped and rendered from meaningful concepts only.
  const nodes = store.topNodes(limit).filter((n) => !isGeneric(n.label));
  const idSet = new Set(nodes.map((n) => n.id));
  const edges = store.edgesForNodes([...idSet]).filter((e) => idSet.has(e.src) && idSet.has(e.dst));

  const g = new Graph({ type: 'undirected', multi: false });
  for (const n of nodes) g.addNode(String(n.id), { weight: n.weight });

  // ---- sparse "backbone" for clustering ------------------------------------
  // The raw co-occurrence graph is a hairball. We normalize each edge by its
  // endpoints' weighted degree (association strength) to suppress hub domination,
  // then keep only each node's few strongest links. Community detection on this
  // backbone yields meaningful, well-separated worlds — while the returned
  // `edges` stay the full set for rendering.
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

  // ---- consolidate into a readable number of "worlds" ----------------------
  // Leiden on a graph of 1500 diverse concepts yields many small topic islands.
  // For a legible macro view we keep the largest communities as anchor worlds and
  // fold every smaller fragment into the anchor it connects to most strongly
  // (backbone edge weight; embedding-centroid similarity as a tie-break/fallback).
  worldOf = consolidateWorlds(worldOf, g, emb, TARGET_WORLDS);

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
