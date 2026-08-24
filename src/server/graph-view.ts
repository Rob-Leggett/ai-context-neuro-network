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
  community: number;
}

export interface GraphViewEdge {
  id: number;
  source: number;
  target: number;
  kind: string;
  weight: number;
}

export interface GraphView {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  communities: { id: number; size: number; label: string }[];
}

/**
 * Build a renderable view of the network: top-N nodes by weight, their induced
 * edges, and Louvain community assignments. Communities power the macro view —
 * zoom out to see clusters, zoom in to see individual concepts.
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

  let communities: Record<string, number> = {};
  try {
    if (g.order > 0 && g.size > 0) {
      communities = louvain(g, { resolution: 1 });
    }
  } catch {
    communities = {};
  }

  const degree = new Map<number, number>();
  for (const e of edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }

  const viewNodes: GraphViewNode[] = nodes.map((n) => ({
    id: n.id,
    label: n.label,
    kind: n.kind,
    weight: n.weight,
    mentions: n.mentions,
    degree: degree.get(n.id) ?? 0,
    community: communities[String(n.id)] ?? 0,
  }));

  const viewEdges: GraphViewEdge[] = edges
    .filter((e) => idSet.has(e.src) && idSet.has(e.dst))
    .map((e) => ({ id: e.id, source: e.src, target: e.dst, kind: e.kind, weight: e.weight }));

  // Label each community by its highest-weight member.
  const byCommunity = new Map<number, GraphViewNode[]>();
  for (const n of viewNodes) {
    const arr = byCommunity.get(n.community) ?? [];
    arr.push(n);
    byCommunity.set(n.community, arr);
  }
  const communityList = [...byCommunity.entries()]
    .map(([id, members]) => {
      const top = members.slice().sort((a, b) => b.weight - a.weight)[0];
      return { id, size: members.length, label: top?.label ?? `Cluster ${id}` };
    })
    .sort((a, b) => b.size - a.size);

  return { nodes: viewNodes, edges: viewEdges, communities: communityList };
}
