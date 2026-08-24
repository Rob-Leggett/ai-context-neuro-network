import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';

// ---- types (mirror server graph-view) --------------------------------------
interface ViewNode {
  id: number; label: string; kind: string; weight: number; mentions: number;
  degree: number; community: number; world: number; sub: string;
}
interface ViewEdge { id: number; source: number; target: number; kind: string; weight: number; }
interface SubCluster { key: string; label: string; size: number; }
interface World { id: number; label: string; size: number; subs: SubCluster[]; }
interface GraphView { nodes: ViewNode[]; edges: ViewEdge[]; worlds: World[]; }

const KIND_COLOR: Record<string, string> = {
  decision: '#fbbf24', pattern: '#a78bfa', entity: '#38bdf8', topic: '#34d399', concept: '#8aa0c0',
};

// Zoom bands (Sigma camera ratio: >1 zoomed out, <1 zoomed in)
const WORLD_MIN = 1.3;   // ratio >= this -> show worlds
const SUB_MIN = 0.5;     // between SUB_MIN and WORLD_MIN -> show sub-regions
// below SUB_MIN -> show individual concepts

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const api = async (path: string, opts: RequestInit = {}) =>
  (await fetch(path, { ...opts, headers: opts.body ? { 'content-type': 'application/json' } : {} })).json();

function communityColor(c: number): string { return `hsl(${(c * 47) % 360}, 65%, 60%)`; }

const graph = new Graph({ type: 'undirected', multi: false });
let renderer: Sigma;
let colorMode: 'community' | 'kind' = 'community';
let worlds: World[] = [];

function nodeSize(n: { weight: number; degree: number }): number {
  return Math.min(20, 3 + Math.sqrt(n.weight) * 1.2 + Math.sqrt(n.degree) * 0.7);
}

function addOrUpdateNode(n: ViewNode) {
  const size = nodeSize(n);
  const color = colorMode === 'kind' ? KIND_COLOR[n.kind] ?? KIND_COLOR.concept : communityColor(n.world);
  const id = String(n.id);
  const attrs = { size, color, label: n.label, kind: n.kind, weight: n.weight, world: n.world, sub: n.sub, degree: n.degree, isCluster: false };
  if (graph.hasNode(id)) graph.mergeNodeAttributes(id, attrs);
  else graph.addNode(id, { x: Math.cos(n.id) * (100 + (n.id % 400)), y: Math.sin(n.id) * (100 + (n.id % 400)), ...attrs });
}

function addEdge(e: ViewEdge) {
  const s = String(e.source); const t = String(e.target);
  if (!graph.hasNode(s) || !graph.hasNode(t) || s === t || graph.hasEdge(s, t)) return;
  graph.addEdge(s, t, {
    size: Math.min(3, 0.3 + e.weight * 0.15),
    color: e.kind === 'similar' ? 'rgba(167,139,250,0.22)' : e.kind === 'decided' ? 'rgba(251,191,36,0.28)' : 'rgba(120,140,170,0.13)',
  });
}

// ---- cluster meta-nodes (the "worlds" and "regions") -----------------------
function rebuildClusterNodes() {
  graph.forEachNode((id, d) => { if (d.isCluster) graph.dropNode(id); });

  const acc = (map: Map<string, { x: number; y: number; n: number }>, key: string, x: number, y: number) => {
    const e = map.get(key) ?? { x: 0, y: 0, n: 0 };
    e.x += x; e.y += y; e.n++; map.set(key, e);
  };
  const worldPos = new Map<string, { x: number; y: number; n: number }>();
  const subPos = new Map<string, { x: number; y: number; n: number }>();
  graph.forEachNode((_id, d) => {
    if (d.isCluster) return;
    acc(worldPos, String(d.world), d.x, d.y);
    acc(subPos, String(d.sub), d.x, d.y);
  });

  for (const w of worlds) {
    const p = worldPos.get(String(w.id)); if (!p || p.n === 0) continue;
    graph.addNode(`w:${w.id}`, {
      x: p.x / p.n, y: p.y / p.n, isCluster: true, level: 'world', world: w.id,
      label: w.label.toUpperCase(), size: Math.max(16, Math.min(60, Math.sqrt(w.size) * 5)),
      color: colorMode === 'kind' ? 'rgba(200,210,230,0.9)' : communityColor(w.id),
    });
    for (const s of w.subs) {
      if (s.size < 2) continue;
      const sp = subPos.get(s.key); if (!sp || sp.n === 0) continue;
      graph.addNode(`s:${s.key}`, {
        x: sp.x / sp.n, y: sp.y / sp.n, isCluster: true, level: 'sub', world: w.id,
        label: s.label, size: Math.max(9, Math.min(34, Math.sqrt(s.size) * 3.4)),
        color: colorMode === 'kind' ? 'rgba(180,190,215,0.85)' : communityColor(w.id),
      });
    }
  }
}

async function loadGraph() {
  const view: GraphView = await api('/api/graph?limit=1500');
  worlds = view.worlds ?? [];
  graph.clear();
  for (const n of view.nodes) addOrUpdateNode(n);
  for (const e of view.edges) addEdge(e);
  if (graph.order > 0) {
    const settings = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, { iterations: graph.order > 800 ? 130 : 240, settings: { ...settings, gravity: 1, scalingRatio: 14, barnesHutOptimize: true } });
  }
  rebuildClusterNodes();
  renderLegend();
  renderer?.refresh();
  // Start zoomed out at the "worlds" view.
  renderer?.getCamera().setState({ ratio: 1.7, x: 0.5, y: 0.5 });
  applyLOD();
}

// ---- level-of-detail: worlds -> regions -> concepts as you zoom ------------
function zoomBand(ratio: number): 'world' | 'sub' | 'concept' {
  if (ratio >= WORLD_MIN) return 'world';
  if (ratio >= SUB_MIN) return 'sub';
  return 'concept';
}

function lodReducer(_node: string, data: any) {
  const ratio = renderer.getCamera().ratio;
  const band = zoomBand(ratio);
  const res: any = { ...data };
  if (data.isCluster) {
    const show = (data.level === 'world' && band === 'world') || (data.level === 'sub' && band === 'sub');
    if (!show) { res.hidden = true; return res; }
    res.forceLabel = true;
    res.zIndex = 3;
    return res;
  }
  // concept nodes
  const importance = (data.weight ?? 1) + (data.degree ?? 0);
  if (band === 'world') {
    // dim colored clouds under the world labels
    res.label = '';
    res.size = Math.max(1.5, (data.size ?? 3) * 0.5);
    res.color = fade(data.color, 0.45);
  } else if (band === 'sub') {
    res.label = importance > 10 * ratio ? data.label : '';
  } else {
    res.forceLabel = importance > 5 * ratio;
    if (importance <= 3 * ratio) res.label = '';
  }
  return res;
}

function fade(color: string, alpha: number): string {
  const m = /^hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)$/.exec(color || '');
  if (m) return `hsla(${m[1]},${m[2]}%,${m[3]}%,${alpha})`;
  return color;
}

function edgeLodReducer(_edge: string, data: any) {
  const band = zoomBand(renderer.getCamera().ratio);
  const res: any = { ...data };
  if (band === 'world') res.hidden = true;
  else if (band === 'sub') res.color = 'rgba(120,140,170,0.07)';
  return res;
}

function applyLOD() {
  if (highlighted) return;
  renderer.setSetting('nodeReducer', lodReducer);
  renderer.setSetting('edgeReducer', edgeLodReducer);
  renderer.refresh();
}

// ---- interaction -----------------------------------------------------------
let highlighted: string | null = null;

async function openNode(id: number) {
  const data = await api(`/api/node/${id}`);
  if (data.error) return;
  const n = data.node;
  const panel = $('#panel');
  panel.classList.remove('hidden');
  const neighbors = (data.neighbors as ViewNode[]).slice(0, 40);
  const obs = data.observations as { snippet: string }[];
  const world = worlds.find((w) => graph.hasNode(String(id)) && graph.getNodeAttribute(String(id), 'world') === w.id);
  $('#panel-body').innerHTML = `
    <h2>${escapeHtml(n.label)}</h2>
    <div><span class="chip">${n.kind}</span><span class="chip">weight ${n.weight.toFixed(1)}</span><span class="chip">${n.mentions} mentions</span>${world ? `<span class="chip">🌐 ${escapeHtml(world.label)}</span>` : ''}</div>
    ${n.summary ? `<p>${escapeHtml(n.summary)}</p>` : ''}
    <div class="section"><h3>Connections (${neighbors.length})</h3>
      ${neighbors.map((x) => `<span class="chip neighbor" data-id="${x.id}">${escapeHtml(x.label)}</span>`).join('') || '<span class="empty">No connections yet.</span>'}
    </div>
    <div class="section"><h3>Where it came from</h3>
      ${obs.map((o) => `<div class="obs">${escapeHtml(o.snippet.slice(0, 220))}</div>`).join('') || '<span class="empty">No observations.</span>'}
    </div>`;
  panel.querySelectorAll('.neighbor').forEach((el) => el.addEventListener('click', () => focusNode(Number((el as HTMLElement).dataset.id))));
  highlightNode(String(id));
}

function highlightNode(id: string) {
  highlighted = id;
  renderer.setSetting('nodeReducer', (node, data) => {
    const res: any = { ...data };
    if (data.isCluster) { res.hidden = true; return res; }
    if (node === id) { res.highlighted = true; res.forceLabel = true; res.zIndex = 2; }
    else if (!graph.areNeighbors(id, node)) { res.color = '#2a3446'; res.label = ''; }
    else res.forceLabel = true;
    return res;
  });
  renderer.setSetting('edgeReducer', (edge, data) => {
    const res: any = { ...data };
    const [s, t] = graph.extremities(edge);
    if (s !== id && t !== id) res.hidden = true;
    return res;
  });
  renderer.refresh();
}

function clearHighlight() { highlighted = null; applyLOD(); }

function focusNode(id: number) {
  const sid = String(id);
  if (!graph.hasNode(sid)) { openNode(id); return; }
  const a = graph.getNodeAttributes(sid);
  renderer.getCamera().animate({ x: a.x, y: a.y, ratio: 0.3 }, { duration: 500 });
  setTimeout(() => openNode(id), 120);
}

// drill into a cluster meta-node
function drillCluster(node: string) {
  const a = graph.getNodeAttributes(node);
  const targetRatio = a.level === 'world' ? (SUB_MIN + WORLD_MIN) / 2 : SUB_MIN * 0.55;
  renderer.getCamera().animate({ x: a.x, y: a.y, ratio: targetRatio }, { duration: 500 });
}

// ---- search ----------------------------------------------------------------
function setupSearch() {
  const input = $('#search') as HTMLInputElement;
  const box = $('#search-results');
  let timer: any;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) { box.classList.remove('show'); return; }
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      box.innerHTML = results.map((r: any) => `<div class="row" data-id="${r.id}"><span>${escapeHtml(r.label)}</span><span class="kind">${r.kind}</span></div>`).join('') || '<div class="row"><span class="empty">No matches</span></div>';
      box.classList.add('show');
      box.querySelectorAll('.row[data-id]').forEach((el) => el.addEventListener('click', () => { box.classList.remove('show'); input.value = ''; focusNode(Number((el as HTMLElement).dataset.id)); }));
    }, 180);
  });
  document.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.search')) box.classList.remove('show'); });
}

// ---- live updates ----------------------------------------------------------
let liveOn = true;
function setupLive() {
  const check = $('#live') as HTMLInputElement;
  check.addEventListener('change', () => { liveOn = check.checked; });
  const connect = () => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (ev) => {
      if (!liveOn) return;
      const msg = JSON.parse(ev.data);
      if (msg.type === 'node' && msg.node) { addOrUpdateNode(toViewNode(msg.node)); pulse(); }
      else if (msg.type === 'edge' && msg.edge) { addEdge({ id: msg.edge.id, source: msg.edge.src, target: msg.edge.dst, kind: msg.edge.kind, weight: msg.edge.weight }); }
      else if (msg.type === 'hello') updateStats(msg.stats);
    };
    ws.onclose = () => setTimeout(connect, 2000);
  };
  connect();
}
let pulseTimer: any;
function pulse() { clearTimeout(pulseTimer); pulseTimer = setTimeout(() => renderer.refresh(), 250); refreshStats(); }
function toViewNode(n: any): ViewNode { return { id: n.id, label: n.label, kind: n.kind, weight: n.weight, mentions: n.mentions, degree: graph.hasNode(String(n.id)) ? graph.degree(String(n.id)) : 0, community: 0, world: 0, sub: '0:0' }; }

// ---- stats / legend --------------------------------------------------------
async function refreshStats() { updateStats(await api('/api/stats')); }
function updateStats(s: any) {
  $('#stats').innerHTML = `<span><b>${s.nodes ?? 0}</b> concepts</span><span><b>${s.edges ?? 0}</b> links</span><span><b>${s.sources ?? 0}</b> sources</span>${s.embeddings === false ? '<span title="semantic embeddings off">lexical</span>' : ''}`;
}
function renderLegend() {
  const top = worlds.slice(0, 7);
  $('#legend').innerHTML = `<div style="color:var(--text);margin-bottom:4px">Worlds (zoom in to explore)</div>` +
    top.map((w) => `<div class="item" data-world="${w.id}" style="cursor:pointer"><span class="dot" style="background:${communityColor(w.id)}"></span>${escapeHtml(w.label)} <span style="opacity:.6">(${w.size}, ${w.subs.length} regions)</span></div>`).join('') +
    `<div class="item" style="margin-top:6px;cursor:pointer" id="toggle-color">↺ color by ${colorMode === 'community' ? 'kind' : 'world'}</div>`;
  $('#legend').querySelectorAll('[data-world]').forEach((el) => el.addEventListener('click', () => {
    const id = (el as HTMLElement).dataset.world; if (graph.hasNode(`w:${id}`)) drillCluster(`w:${id}`);
  }));
  $('#toggle-color')?.addEventListener('click', () => {
    colorMode = colorMode === 'community' ? 'kind' : 'community';
    graph.forEachNode((id, d) => {
      if (d.isCluster) graph.setNodeAttribute(id, 'color', colorMode === 'kind' ? 'rgba(200,210,230,0.9)' : communityColor(d.world ?? 0));
      else graph.setNodeAttribute(id, 'color', colorMode === 'kind' ? KIND_COLOR[d.kind] ?? KIND_COLOR.concept : communityColor(d.world ?? 0));
    });
    renderer.refresh(); renderLegend();
  });
}

// ---- patterns & tools modals ----------------------------------------------
function showModal(html: string) { $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden'); }

async function runAnalyze() {
  showModal('<h2>Analyzing…</h2><p class="empty">Mining hubs, clusters, decisions and recurring themes.</p>');
  try {
    await api('/api/analyze', { method: 'POST' });
    const { patterns } = await api('/api/patterns');
    const groups: Record<string, any[]> = {};
    for (const p of patterns) (groups[p.kind] ??= []).push(p);
    const order = ['decision', 'hub', 'recurring', 'co_occurrence'];
    const titles: Record<string, string> = { decision: 'Decisions', hub: 'Hubs', recurring: 'Recurring themes', co_occurrence: 'Co-occurring pairs' };
    const body = order.filter((k) => groups[k]?.length).map((k) =>
      `<h3 style="color:var(--accent2);margin:14px 0 4px">${titles[k]} (${groups[k].length})</h3>` +
      groups[k].slice(0, 25).map((p) => `<div class="pattern"><div>${escapeHtml(p.title)}</div><div class="empty">${escapeHtml(p.description ?? '')}</div></div>`).join('')
    ).join('');
    showModal(`<h2>Patterns & Decisions</h2>${body || '<p class="empty">No patterns yet — ingest more context first.</p>'}`);
  } catch {
    showModal('<h2>Analysis failed</h2><p class="empty">Could not reach the server.</p>');
  }
}

async function showTools() {
  const render = (tools: any[]) => `
    <h2>Self-Updating Tools</h2>
    <p class="empty">The network proposes new tools from its own structure. Approve to expose them over MCP.</p>
    <button id="propose">✨ Propose from patterns</button>
    ${tools.length ? tools.map((t) => `
      <div class="tool">
        <div class="name">${escapeHtml(t.name)} <span class="status ${t.status}">${t.status}</span></div>
        <div class="meta">${escapeHtml(t.description ?? '')}</div>
        <div class="meta">Why: ${escapeHtml(t.rationale ?? '')}</div>
        ${t.status !== 'active' ? `<button data-approve="${t.name}">Approve</button>` : `<button data-run="${t.name}">Run</button>`}
        ${t.status !== 'rejected' ? `<button data-reject="${t.name}">Reject</button>` : ''}
      </div>`).join('') : '<p class="empty" style="margin-top:10px">No tools yet. Click “Propose from patterns”.</p>'}`;
  const refresh = async () => {
    const { tools } = await api('/api/tools');
    showModal(render(tools));
    $('#propose')?.addEventListener('click', async () => { await api('/api/tools/propose', { method: 'POST' }); refresh(); });
    document.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/tools/${(b as HTMLElement).dataset.approve}/approve`, { method: 'POST' }); refresh(); }));
    document.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/tools/${(b as HTMLElement).dataset.reject}/reject`, { method: 'POST' }); refresh(); }));
    document.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', async () => { const r = await api(`/api/tools/${(b as HTMLElement).dataset.run}/run`, { method: 'POST', body: '{}' }); alert(JSON.stringify(r.result, null, 2)); }));
  };
  refresh();
}

function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }

// ---- boot ------------------------------------------------------------------
async function main() {
  renderer = new Sigma(graph, $('#sigma') as HTMLDivElement, {
    labelColor: { color: '#c8d3e6' }, labelSize: 12, labelDensity: 0.7, labelGridCellSize: 70,
    defaultEdgeColor: 'rgba(120,140,170,0.12)', minCameraRatio: 0.05, maxCameraRatio: 12,
  });

  renderer.on('clickNode', ({ node }) => {
    if (graph.getNodeAttribute(node, 'isCluster')) drillCluster(node);
    else openNode(Number(node));
  });
  renderer.on('clickStage', () => { $('#panel').classList.add('hidden'); clearHighlight(); });
  renderer.getCamera().on('updated', () => { if (!highlighted) applyLOD(); });

  $('#panel-close').addEventListener('click', () => { $('#panel').classList.add('hidden'); clearHighlight(); });
  $('#modal-close').addEventListener('click', () => $('#modal').classList.add('hidden'));
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) $('#modal').classList.add('hidden'); });
  $('#btn-analyze').addEventListener('click', runAnalyze);
  $('#btn-tools').addEventListener('click', showTools);

  setupSearch();
  setupLive();
  await loadGraph();
  await refreshStats();
}

main();
