import Graph from 'graphology';
import leiden from '@aflsolutions/graphology-communities-leiden';
import type { GraphStore } from '../graph/store.js';
import type { GraphEdge } from '../graph/types.js';
import { cosine } from '../embeddings/embedder.js';

export interface GraphViewNode {
  id: number;
  label: string;
  kind: string;
  weight: number;
  /** graph-relative importance after automatically suppressing diffuse bridge nodes */
  salience: number;
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

const WORLD_CATEGORIES = [
  'People',
  'Relationships',
  'Health',
  'Education',
  'Finance',
  'Banking',
  'Cloud',
  'Infrastructure',
  'Networking',
  'Security',
  'Identity',
  'Authentication',
  'Development',
  'Software',
  'Frontend',
  'Data',
  'Databases',
  'Testing',
  'DevOps',
  'Operations',
  'Automation',
  'Configuration',
  'Documentation',
  'CRM',
  'Legal',
  'Communication',
  'Geography',
  'Time',
  'Projects',
  'Design',
] as const;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function centroidsForCommunities(
  communityOf: Record<string, number>,
  emb: Map<number, Float32Array>,
): Map<number, Float32Array> {
  const sums = new Map<number, { vec: Float32Array; count: number }>();
  for (const [id, community] of Object.entries(communityOf)) {
    const vec = emb.get(Number(id));
    if (!vec) continue;
    let sum = sums.get(community);
    if (!sum) {
      sum = { vec: new Float32Array(vec.length), count: 0 };
      sums.set(community, sum);
    }
    for (let i = 0; i < vec.length; i++) sum.vec[i] += vec[i];
    sum.count++;
  }
  const out = new Map<number, Float32Array>();
  for (const [community, sum] of sums) {
    for (let i = 0; i < sum.vec.length; i++) sum.vec[i] /= sum.count;
    let norm = 0;
    for (let i = 0; i < sum.vec.length; i++) norm += sum.vec[i] * sum.vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < sum.vec.length; i++) sum.vec[i] /= norm;
    }
    out.set(community, sum.vec);
  }
  return out;
}

function nodeCommunityConcentration(g: Graph, communityOf: Record<string, number>): Map<string, number> {
  const concentration = new Map<string, number>();
  g.forEachNode((node) => {
    const byCommunity = new Map<number, number>();
    let total = 0;
    g.forEachNeighbor(node, (neighbor, attr) => {
      const weight = (attr.weight as number) ?? 0;
      const community = communityOf[neighbor];
      byCommunity.set(community, (byCommunity.get(community) ?? 0) + weight);
      total += weight;
    });
    let value = 0;
    if (total > 0) {
      for (const weight of byCommunity.values()) value += (weight / total) ** 2;
    }
    concentration.set(node, value || 1);
  });
  return concentration;
}

function suppressBridgeNodes(g: Graph, communityOf: Record<string, number>): Graph {
  const concentration = nodeCommunityConcentration(g, communityOf);
  const refined = new Graph({ type: 'undirected', multi: false });
  g.forEachNode((node, attr) => refined.addNode(node, attr));
  g.forEachEdge((_edge, attr, source, target) => {
    const focus = Math.sqrt((concentration.get(source) ?? 1) * (concentration.get(target) ?? 1));
    refined.addEdge(source, target, { ...attr, weight: ((attr.weight as number) ?? 0) * focus });
  });
  return refined;
}

/**
 * Build a graph whose nodes are Leiden communities, then cluster that graph
 * again. Cross-community backbone edges preserve observed relationships while
 * centroid-neighbour edges connect semantically compatible islands. The number
 * of worlds emerges from this meta-graph rather than a fixed target or a list
 * of words to exclude.
 */
function discoverWorlds(
  communityOf: Record<string, number>,
  g: Graph,
  emb: Map<number, Float32Array>,
  sourcesByNode: Map<number, number[]>,
): Record<string, number> {
  const communities = [...new Set(Object.values(communityOf))];
  if (communities.length < 2) return communityOf;

  const meta = new Graph({ type: 'undirected', multi: false });
  for (const community of communities) meta.addNode(String(community));

  const sourceProfiles = new Map<number, Map<number, number>>();
  for (const [id, community] of Object.entries(communityOf)) {
    let profile = sourceProfiles.get(community);
    if (!profile) {
      profile = new Map();
      sourceProfiles.set(community, profile);
    }
    for (const sourceId of sourcesByNode.get(Number(id)) ?? []) {
      profile.set(sourceId, (profile.get(sourceId) ?? 0) + 1);
    }
  }

  const centroids = centroidsForCommunities(communityOf, emb);
  const semanticNeighbors = Math.max(2, Math.ceil(Math.log2(communities.length) / 2));
  const sparseCosine = (a: Map<number, number>, b: Map<number, number>): number => {
    let dot = 0;
    let aa = 0;
    let bb = 0;
    for (const value of a.values()) aa += value * value;
    for (const value of b.values()) bb += value * value;
    const smaller = a.size <= b.size ? a : b;
    const larger = smaller === a ? b : a;
    for (const [key, value] of smaller) dot += value * (larger.get(key) ?? 0);
    return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : 0;
  };
  for (const community of communities) {
    const vec = centroids.get(community);
    const similarities = communities
      .filter((other) => other !== community)
      .map((other) => {
        const semantic = vec && centroids.has(other) ? Math.max(0, cosine(vec, centroids.get(other)!)) : 0;
        const contextual = sparseCosine(
          sourceProfiles.get(community) ?? new Map(),
          sourceProfiles.get(other) ?? new Map(),
        );
        const similarity = 0.3 * semantic + 0.7 * contextual;
        return { other, similarity: semantic >= 0.8 ? Math.max(similarity, semantic * 0.8) : similarity };
      })
      .sort((a, b) => b.similarity - a.similarity);
    const mean = similarities.reduce((sum, item) => sum + item.similarity, 0) / Math.max(1, similarities.length);
    const variance = similarities.reduce((sum, item) => sum + (item.similarity - mean) ** 2, 0)
      / Math.max(1, similarities.length);
    const threshold = mean + Math.sqrt(variance) * 0.5;
    const nearest = similarities
      .filter((item) => item.similarity >= threshold)
      .slice(0, semanticNeighbors);
    for (const { other, similarity } of nearest) {
      const a = String(community);
      const b = String(other);
      const weight = Math.max(0.01, similarity);
      if (meta.hasEdge(a, b)) meta.setEdgeAttribute(a, b, 'weight', Math.max(weight, meta.getEdgeAttribute(a, b, 'weight')));
      else meta.addEdge(a, b, { weight });
    }
  }

  if (meta.size === 0) return communityOf;
  const metaWorld = leiden(meta, {
    resolution: 2.5,
    rng: seededRandom(0x4e455552),
    maxIterations: 20,
  });

  const out: Record<string, number> = {};
  for (const [id, community] of Object.entries(communityOf)) {
    out[id] = metaWorld[String(community)] ?? community;
  }
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
 * second Leiden pass clusters the discovered communities themselves, allowing
 * the number and composition of worlds to emerge from the active dataset.
 *
 * This powers the "zoom into different worlds" experience: zoom out to see a
 * handful of named worlds, zoom in to reveal their regions, then individual
 * concepts. Clusters are named from their most central, distinctive members.
 */
export function buildGraphView(store: GraphStore, limit = 1500): GraphView {
  const nodes = store.topNodes(limit);
  const idSet = new Set(nodes.map((n) => n.id));
  const edges = store
    .edgesForNodes([...idSet])
    .filter((e) => (e.kind !== 'related' || e.weight > 1.5) && idSet.has(e.src) && idSet.has(e.dst));

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
  const sourceFrequency = store.sourceFrequencyForNodes([...idSet]);
  const sourcesByNode = store.sourceIdsForNodes([...idSet]);
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
      const communities = leiden(g, {
        resolution: 0.55,
        rng: seededRandom(0x434f4d4d),
        maxIterations: 20,
      });
      const refined = suppressBridgeNodes(g, communities);
      const refinedCommunities = leiden(refined, {
        resolution: 0.55,
        rng: seededRandom(0x52454649),
        maxIterations: 20,
      });
      worldOf = discoverWorlds(refinedCommunities, refined, emb, sourcesByNode);
      subOf = leiden(refined, {
        resolution: 1.1,
        rng: seededRandom(0x53554253),
        maxIterations: 20,
      });
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

  const internalStrength = new Map<number, number>();
  const totalStrength = new Map<number, number>();
  g.forEachEdge((_edge, attr, source, target) => {
    const weight = (attr.weight as number) ?? 0;
    const a = Number(source);
    const b = Number(target);
    totalStrength.set(a, (totalStrength.get(a) ?? 0) + weight);
    totalStrength.set(b, (totalStrength.get(b) ?? 0) + weight);
    if (worldOf[source] === worldOf[target]) {
      internalStrength.set(a, (internalStrength.get(a) ?? 0) + weight);
      internalStrength.set(b, (internalStrength.get(b) ?? 0) + weight);
    }
  });

  const viewNodes: GraphViewNode[] = nodes.map((n) => {
    const world = worldOf[String(n.id)] ?? 0;
    const subRaw = subOf[String(n.id)] ?? 0;
    const specificity = (internalStrength.get(n.id) ?? 0) / Math.max(totalStrength.get(n.id) ?? 0, 0.001);
    const sourceCount = sourceFrequency.byNode.get(n.id) ?? 0;
    const corpusSpecificity = sourceFrequency.totalSources > 1
      ? Math.log((sourceFrequency.totalSources + 1) / (sourceCount + 1))
        / Math.log(sourceFrequency.totalSources + 1)
      : 1;
    const recurrence = Math.log1p(n.mentions / Math.max(1, sourceCount));
    const salience = Math.log1p(n.weight)
      * (0.2 + 0.8 * specificity)
      * (0.4 + 0.6 * corpusSpecificity)
      * (0.7 + 0.3 * recurrence);
    // Nest sub within world so each sub-cluster belongs to exactly one world.
    const sub = `${world}:${subRaw}`;
    return {
      id: n.id,
      label: n.label,
      kind: n.kind,
      weight: n.weight,
      salience,
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
  const labelGroup = (members: GraphViewNode[]): { label: string; score: number } => {
    let centroid: Float32Array | null = null;
    let embedded = 0;
    for (const member of members) {
      const vec = emb.get(member.id);
      if (!vec) continue;
      if (!centroid) centroid = new Float32Array(vec.length);
      for (let i = 0; i < vec.length; i++) centroid[i] += vec[i];
      embedded++;
    }
    if (centroid && embedded > 0) {
      let norm = 0;
      for (let i = 0; i < centroid.length; i++) {
        centroid[i] /= embedded;
        norm += centroid[i] * centroid[i];
      }
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < centroid.length; i++) centroid[i] /= norm;
    }
    const ranked = members
      .map((member) => {
        const semantic = centroid && emb.has(member.id) ? Math.max(0, cosine(centroid, emb.get(member.id)!)) : 0;
        const structural = (internalStrength.get(member.id) ?? 0)
          / Math.max(totalStrength.get(member.id) ?? 0, 0.001);
        const sourceCount = sourceFrequency.byNode.get(member.id) ?? 0;
        const corpusSpecificity = sourceFrequency.totalSources > 1
          ? Math.log((sourceFrequency.totalSources + 1) / (sourceCount + 1))
            / Math.log(sourceFrequency.totalSources + 1)
          : 1;
        const focus = namingFocus.get(String(member.id)) ?? 1;
        const kindWeight = member.kind === 'entity' ? 1.25 : member.kind === 'topic' ? 1.15 : 1;
        return {
          member,
          score: Math.sqrt(member.weight)
            * (0.25 + 0.75 * structural)
            * (0.7 + 0.3 * semantic)
            * (0.6 + 0.4 * corpusSpecificity)
            * (0.15 + 0.85 * focus)
            * kindWeight,
        };
      })
      .sort((a, b) => b.score - a.score);
    const labels: string[] = [];
    for (const { member } of ranked) {
      if (labels.some((label) => {
        const a = label.toLowerCase();
        const b = member.label.toLowerCase();
        return a.includes(b) || b.includes(a);
      })) continue;
      labels.push(member.label);
      if (labels.length === 3) break;
    }
    return {
      label: labels.join('/') || 'cluster',
      score: ranked[0]?.score ?? 0,
    };
  };

  const byWorld = new Map<number, GraphViewNode[]>();
  const bySub = new Map<string, GraphViewNode[]>();
  for (const n of viewNodes) {
    if (!byWorld.has(n.world)) byWorld.set(n.world, []);
    byWorld.get(n.world)!.push(n);
    if (!bySub.has(n.sub)) bySub.set(n.sub, []);
    bySub.get(n.sub)!.push(n);
  }
  const namingFocus = nodeCommunityConcentration(g, subOf);
  const categoryCandidates = WORLD_CATEGORIES.flatMap((label) => {
    const node = store.getNodeByKey(label.toLowerCase());
    if (!node) return [];
    const vector = store.getEmbedding(node.id);
    return vector ? [{ label, id: node.id, vector }] : [];
  });
  const categoryEdges = store.edgesTouchingNodes(categoryCandidates.map((candidate) => candidate.id));
  const categoryIds = new Set(categoryCandidates.map((candidate) => candidate.id));
  const categoryStrength = new Map<number, number>();
  for (const edge of categoryEdges) {
    if (categoryIds.has(edge.src)) {
      categoryStrength.set(edge.src, (categoryStrength.get(edge.src) ?? 0) + edge.weight);
    }
    if (categoryIds.has(edge.dst)) {
      categoryStrength.set(edge.dst, (categoryStrength.get(edge.dst) ?? 0) + edge.weight);
    }
  }

  const worldCategoryScores = (members: GraphViewNode[]): { label: string; score: number }[] => {
    let centroid: Float32Array | null = null;
    let count = 0;
    for (const member of members) {
      const vector = emb.get(member.id);
      if (!vector) continue;
      if (!centroid) centroid = new Float32Array(vector.length);
      for (let i = 0; i < vector.length; i++) centroid[i] += vector[i];
      count++;
    }
    if (!centroid || count === 0 || categoryCandidates.length === 0) {
      return [];
    }
    let norm = 0;
    for (let i = 0; i < centroid.length; i++) {
      centroid[i] /= count;
      norm += centroid[i] * centroid[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < centroid.length; i++) centroid[i] /= norm;

    const memberIds = new Set(members.map((member) => member.id));
    return categoryCandidates
      .map((candidate) => {
        let direct = 0;
        for (const edge of categoryEdges) {
          if (edge.src === candidate.id && memberIds.has(edge.dst)) direct += edge.weight;
          else if (edge.dst === candidate.id && memberIds.has(edge.src)) direct += edge.weight;
        }
        return {
          label: candidate.label,
          score: cosine(centroid!, candidate.vector)
            + 0.8 * direct / Math.max(categoryStrength.get(candidate.id) ?? direct, 1),
        };
      })
      .sort((a, b) => b.score - a.score);
  };

  const worldDrafts = [...byWorld.entries()]
    .map(([id, members]) => {
      const subKeys = [...new Set(members.map((m) => m.sub))];
      const rankedSubs = subKeys
        .map((key) => {
          const subMembers = bySub.get(key)!;
          const summary = labelGroup(subMembers);
          return { key, label: summary.label, size: subMembers.length, score: summary.score };
        })
        .sort((a, b) => b.size - a.size);
      const subs: SubCluster[] = rankedSubs.map(({ key, label, size }) => ({ key, label, size }));
        return {
          id,
          fallbackLabel: labelGroup(members).label.split('/')[0],
          size: members.length,
          subs,
          categories: worldCategoryScores(members),
        };
    })
    .sort((a, b) => b.size - a.size);

  const worlds: World[] = worldDrafts.map((world) => ({
    id: world.id,
    label: world.categories[0]?.label ?? world.fallbackLabel,
    size: world.size,
    subs: world.subs,
  }));

  const communities = worlds.map((w) => ({ id: w.id, size: w.size, label: w.label }));

  return { nodes: viewNodes, edges: viewEdges, communities, worlds };
}
