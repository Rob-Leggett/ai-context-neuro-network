import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { GraphStore } from '../graph/store.js';

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
 *   worlds (coarse Louvain)  ->  sub-clusters (fine Louvain)  ->  concepts
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
  for (const e of edges) {
    const s = String(e.src);
    const t = String(e.dst);
    if (g.hasNode(s) && g.hasNode(t) && s !== t && !g.hasEdge(s, t)) {
      g.addEdge(s, t, { weight: e.weight });
    }
  }

  // Two resolutions: low = coarse "worlds", high = fine "regions".
  let worldOf: Record<string, number> = {};
  let subOf: Record<string, number> = {};
  try {
    if (g.order > 0 && g.size > 0) {
      worldOf = louvain(g, { resolution: 0.5 });
      subOf = louvain(g, { resolution: 1.4 });
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
  const topLabel = (members: GraphViewNode[]) =>
    members.slice().sort((a, b) => b.weight - a.weight)[0]?.label ?? 'cluster';

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
