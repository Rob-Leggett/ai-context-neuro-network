import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';

// ---- types (mirror server graph-view) --------------------------------------
interface ViewNode {
  id: number; label: string; kind: string; weight: number; mentions: number; degree: number; community: number;
}
interface ViewEdge { id: number; source: number; target: number; kind: string; weight: number; }
interface GraphView { nodes: ViewNode[]; edges: ViewEdge[]; communities: { id: number; size: number; label: string }[]; }

const KIND_COLOR: Record<string, string> = {
  decision: '#fbbf24',
  pattern: '#a78bfa',
  entity: '#38bdf8',
  topic: '#34d399',
  concept: '#8aa0c0',
};

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const api = async (path: string, opts?: RequestInit) =>
  (await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts })).json();

// deterministic pleasant color per community
function communityColor(c: number): string {
  const hue = (c * 47) % 360;
  return `hsl(${hue}, 65%, 60%)`;
}

const graph = new Graph({ type: 'undirected', multi: false });
let renderer: Sigma;
let colorMode: 'community' | 'kind' = 'community';

function nodeSize(n: { weight: number; degree: number }): number {
  return Math.min(22, 3 + Math.sqrt(n.weight) * 1.3 + Math.sqrt(n.degree) * 0.8);
}

function addOrUpdateNode(n: ViewNode) {
  const size = nodeSize(n);
  const color = colorMode === 'kind' ? KIND_COLOR[n.kind] ?? KIND_COLOR.concept : communityColor(n.community);
  const id = String(n.id);
  if (graph.hasNode(id)) {
    graph.mergeNodeAttributes(id, { size, color, label: n.label, kind: n.kind, weight: n.weight, community: n.community, degree: n.degree });
  } else {
    graph.addNode(id, {
      x: Math.cos(n.id) * (100 + (n.id % 400)),
      y: Math.sin(n.id) * (100 + (n.id % 400)),
      size, color, label: n.label, kind: n.kind, weight: n.weight, community: n.community, degree: n.degree,
    });
  }
}

function addEdge(e: ViewEdge) {
  const s = String(e.source); const t = String(e.target);
  if (!graph.hasNode(s) || !graph.hasNode(t) || s === t) return;
  if (graph.hasEdge(s, t)) return;
  graph.addEdge(s, t, {
    size: Math.min(3, 0.3 + e.weight * 0.15),
    color: e.kind === 'similar' ? 'rgba(167,139,250,0.25)' : e.kind === 'decided' ? 'rgba(251,191,36,0.3)' : 'rgba(120,140,170,0.15)',
  });
}

async function loadGraph() {
  const view: GraphView = await api('/api/graph?limit=1500');
  graph.clear();
  for (const n of view.nodes) addOrUpdateNode(n);
  for (const e of view.edges) addEdge(e);

  // Force-directed layout so structure is visible (macro clusters emerge).
  if (graph.order > 0) {
    const settings = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, { iterations: graph.order > 800 ? 120 : 220, settings: { ...settings, gravity: 1, scalingRatio: 12, barnesHutOptimize: true } });
  }
  renderer?.refresh();
  renderLegend(view.communities);
}

// ---- level-of-detail: labels appear as you zoom in (micro), hidden at macro
function applyLOD() {
  const ratio = renderer.getCamera().ratio; // >1 = zoomed out
  renderer.setSetting('nodeReducer', (node, data) => {
    const res: any = { ...data };
    const importance = (data.weight ?? 1) + (data.degree ?? 0);
    // Show a label only when the node is important enough for the current zoom.
    const threshold = 6 * ratio;
    res.forceLabel = importance > threshold;
    if (ratio > 2.2 && importance <= threshold) res.label = ''; // declutter macro view
    return res;
  });
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
  $('#panel-body').innerHTML = `
    <h2>${escapeHtml(n.label)}</h2>
    <div><span class="chip">${n.kind}</span><span class="chip">weight ${n.weight.toFixed(1)}</span><span class="chip">${n.mentions} mentions</span></div>
    ${n.summary ? `<p>${escapeHtml(n.summary)}</p>` : ''}
    <div class="section"><h3>Connections (${neighbors.length})</h3>
      ${neighbors.map((x) => `<span class="chip neighbor" data-id="${x.id}">${escapeHtml(x.label)}</span>`).join('') || '<span class="empty">No connections yet.</span>'}
    </div>
    <div class="section"><h3>Where it came from</h3>
      ${obs.map((o) => `<div class="obs">${escapeHtml(o.snippet.slice(0, 220))}</div>`).join('') || '<span class="empty">No observations.</span>'}
    </div>`;
  panel.querySelectorAll('.neighbor').forEach((el) =>
    el.addEventListener('click', () => focusNode(Number((el as HTMLElement).dataset.id))),
  );
  highlightNode(String(id));
}

function highlightNode(id: string) {
  highlighted = id;
  renderer.setSetting('nodeReducer', (node, data) => {
    const res: any = { ...data };
    if (node === id) { res.highlighted = true; res.forceLabel = true; res.zIndex = 2; }
    else if (highlighted && !graph.areNeighbors(highlighted, node)) { res.color = '#2a3446'; res.label = ''; }
    return res;
  });
  renderer.setSetting('edgeReducer', (edge, data) => {
    const res: any = { ...data };
    const [s, t] = graph.extremities(edge);
    if (highlighted && s !== highlighted && t !== highlighted) res.hidden = true;
    return res;
  });
  renderer.refresh();
}

function clearHighlight() {
  highlighted = null;
  renderer.setSetting('edgeReducer', undefined as any);
  applyLOD();
  renderer.refresh();
}

function focusNode(id: number) {
  const sid = String(id);
  if (!graph.hasNode(sid)) { openNode(id); return; }
  const attrs = graph.getNodeAttributes(sid);
  renderer.getCamera().animate({ x: attrs.x, y: attrs.y, ratio: 0.5 }, { duration: 500 });
  setTimeout(() => openNode(id), 120);
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
      box.querySelectorAll('.row[data-id]').forEach((el) =>
        el.addEventListener('click', () => { box.classList.remove('show'); input.value = ''; focusNode(Number((el as HTMLElement).dataset.id)); }),
      );
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
function toViewNode(n: any): ViewNode { return { id: n.id, label: n.label, kind: n.kind, weight: n.weight, mentions: n.mentions, degree: (graph.hasNode(String(n.id)) ? graph.degree(String(n.id)) : 0), community: 0 }; }

// ---- stats / legend --------------------------------------------------------
async function refreshStats() { updateStats(await api('/api/stats')); }
function updateStats(s: any) {
  $('#stats').innerHTML = `<span><b>${s.nodes ?? 0}</b> concepts</span><span><b>${s.edges ?? 0}</b> links</span><span><b>${s.sources ?? 0}</b> sources</span>${s.embeddings === false ? '<span title="semantic embeddings off">lexical</span>' : ''}`;
}
function renderLegend(communities: { id: number; size: number; label: string }[]) {
  const top = communities.slice(0, 6);
  $('#legend').innerHTML = `<div style="color:var(--text);margin-bottom:4px">Clusters</div>` +
    top.map((c) => `<div class="item"><span class="dot" style="background:${communityColor(c.id)}"></span>${escapeHtml(c.label)} <span style="opacity:.6">(${c.size})</span></div>`).join('') +
    `<div class="item" style="margin-top:6px;cursor:pointer" id="toggle-color">↺ color by ${colorMode === 'community' ? 'kind' : 'cluster'}</div>`;
  $('#toggle-color')?.addEventListener('click', async () => {
    colorMode = colorMode === 'community' ? 'kind' : 'community';
    graph.forEachNode((id, data) => {
      graph.setNodeAttribute(id, 'color', colorMode === 'kind' ? KIND_COLOR[data.kind] ?? KIND_COLOR.concept : communityColor(data.community ?? 0));
    });
    renderer.refresh();
    renderLegend(communities);
  });
}

// ---- patterns & tools modals ----------------------------------------------
function showModal(html: string) { $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden'); }

async function runAnalyze() {
  showModal('<h2>Analyzing…</h2><p class="empty">Mining hubs, clusters, decisions and recurring themes.</p>');
  await api('/api/analyze', { method: 'POST' });
  const { patterns } = await api('/api/patterns');
  showModal(`<h2>Patterns & Decisions</h2>${patterns.length ? patterns.map((p: any) => `<div class="pattern"><span class="k">${p.kind}</span><div>${escapeHtml(p.title)}</div><div class="empty">${escapeHtml(p.description ?? '')}</div></div>`).join('') : '<p class="empty">No patterns yet — ingest more context.</p>'}`);
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
        ${t.status !== 'active' ? `<button data-approve="${t.name}">Approve</button>` : '<button data-run="' + t.name + '">Run</button>'}
        ${t.status !== 'rejected' ? `<button data-reject="${t.name}">Reject</button>` : ''}
      </div>`).join('') : '<p class="empty">No tools yet. Click “Propose”.</p>'}`;
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
    labelColor: { color: '#c8d3e6' },
    labelSize: 12,
    labelDensity: 0.6,
    labelGridCellSize: 80,
    defaultEdgeColor: 'rgba(120,140,170,0.12)',
    minCameraRatio: 0.05,
    maxCameraRatio: 12,
  });

  renderer.on('clickNode', ({ node }) => openNode(Number(node)));
  renderer.on('clickStage', () => clearHighlight());
  renderer.getCamera().on('updated', applyLOD);

  $('#panel-close').addEventListener('click', () => { $('#panel').classList.add('hidden'); clearHighlight(); });
  $('#modal-close').addEventListener('click', () => $('#modal').classList.add('hidden'));
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) $('#modal').classList.add('hidden'); });
  $('#btn-analyze').addEventListener('click', runAnalyze);
  $('#btn-tools').addEventListener('click', showTools);

  setupSearch();
  setupLive();
  await loadGraph();
  applyLOD();
  await refreshStats();
}

main();
