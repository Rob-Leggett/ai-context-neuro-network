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

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
// Hex (not hsl) so Sigma's WebGL renderer parses it — hsl() renders black there.
function communityColor(c: number): string { return hslToHex((c * 47) % 360, 0.65, 0.6); }

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
  // Weight intra-world links strongly and inter-world links weakly so the
  // force layout pulls each world into its own island (matching the legend).
  const sameWorld = graph.getNodeAttribute(s, 'world') === graph.getNodeAttribute(t, 'world');
  graph.addEdge(s, t, {
    weight: sameWorld ? 3 : 0.04,
    size: Math.min(3, 0.3 + e.weight * 0.15),
    color: e.kind === 'similar' ? 'rgba(167,139,250,0.22)' : e.kind === 'decided' ? 'rgba(251,191,36,0.28)' : 'rgba(120,140,170,0.13)',
  });
}

// Seed positions grouped by world so each world starts as its own island.
// forceAtlas2 then refines locally instead of collapsing everything into one blob.
function seedLayoutByWorld() {
  const order = new Map<number, number>();
  worlds.forEach((w, i) => order.set(w.id, i));
  const members = new Map<number, string[]>();
  graph.forEachNode((id, d) => {
    if (d.isCluster) return;
    const w = d.world ?? 0;
    (members.get(w) ?? members.set(w, []).get(w)!).push(id);
  });
  const n = Math.max(members.size, 1);
  const ring = 500 + n * 55;
  for (const [w, ids] of members) {
    const i = order.get(w) ?? order.size;
    const ang = (i / n) * Math.PI * 2;
    const cx = Math.cos(ang) * ring;
    const cy = Math.sin(ang) * ring;
    const spread = 40 + Math.sqrt(ids.length) * 18;
    ids.forEach((id, j) => {
      const a = j * 2.399963229; // golden angle → even spiral
      const r = spread * Math.sqrt((j + 1) / ids.length);
      graph.setNodeAttribute(id, 'x', cx + Math.cos(a) * r);
      graph.setNodeAttribute(id, 'y', cy + Math.sin(a) * r);
    });
  }
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
    seedLayoutByWorld();
    const settings = forceAtlas2.inferSettings(graph);
    forceAtlas2.assign(graph, {
      iterations: graph.order > 800 ? 90 : 180,
      settings: { ...settings, gravity: 3.5, scalingRatio: 18, edgeWeightInfluence: 1.4, barnesHutOptimize: true },
    });
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
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color || '');
  if (m) return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
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
  const seen = new Set<string>();
  const neighbors = (data.neighbors as ViewNode[])
    .filter((x) => { const k = x.label.toLowerCase().trim(); if (!k || seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .slice(0, 40);
  const obs = (data.observations as { snippet: string }[])
    .map((o) => cleanSnippet(o.snippet))
    .filter((s) => s.length > 0)
    .slice(0, 8);
  const world = worlds.find((w) => graph.hasNode(String(id)) && graph.getNodeAttribute(String(id), 'world') === w.id);
  $('#panel-body').innerHTML = `
    <h2>${escapeHtml(n.label)}</h2>
    <div><span class="chip">${n.kind}</span><span class="chip">weight ${n.weight.toFixed(1)}</span><span class="chip">${n.mentions} mentions</span>${world ? `<span class="chip">🌐 ${escapeHtml(world.label)}</span>` : ''}</div>
    ${n.summary ? `<p>${escapeHtml(n.summary)}</p>` : ''}
    <div class="section"><h3>Connections (${neighbors.length})</h3>
      ${neighbors.map((x) => `<span class="chip neighbor" data-id="${x.id}">${escapeHtml(x.label)}</span>`).join('') || '<span class="empty">No connections yet.</span>'}
    </div>
    <div class="section"><h3>Where it came from</h3>
      ${obs.map((s) => `<div class="obs">${escapeHtml(s.slice(0, 200))}${s.length > 200 ? '…' : ''}</div>`).join('') || '<span class="empty">No observations.</span>'}
    </div>`;
  panel.querySelectorAll('.neighbor').forEach((el) => el.addEventListener('click', () => focusNode(Number((el as HTMLElement).dataset.id))));
  highlightNode(String(id));
}

// Strip markdown, emoji and bare URLs so provenance snippets read as plain prose.
function cleanSnippet(s: string): string {
  return (s || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[#*`_>~|]+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/-{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  const p = renderer.getNodeDisplayData(sid) ?? { x: a.x, y: a.y };
  renderer.getCamera().animate({ x: p.x, y: p.y, ratio: 0.3 }, { duration: 500 });
  setTimeout(() => openNode(id), 120);
}

// drill into a cluster meta-node
function drillCluster(node: string) {
  const a = graph.getNodeAttributes(node);
  // Camera works in normalized "framed" coordinates — use the node's display
  // data, not its raw graph x/y (which would send the camera off-screen).
  const p = renderer.getNodeDisplayData(node) ?? { x: a.x, y: a.y };
  const targetRatio = a.level === 'world' ? (SUB_MIN + WORLD_MIN) / 2 : SUB_MIN * 0.55;
  renderer.getCamera().animate({ x: p.x, y: p.y, ratio: targetRatio }, { duration: 500 });
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
  const top = worlds.slice(0, 10);
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

async function showProjects() {
  const render = (projects: any[]) => `
    <h2>Projects</h2>
    <p class="empty">Everything is imported. Turn a project off to hide its conversations from the graph, search and stats — turn it back on anytime. Names are placeholders (the ChatGPT export omits them); click a name to rename.</p>
    ${projects.length ? projects.map((p) => `
      <div class="tool">
        <label class="toggle" style="gap:8px">
          <input type="checkbox" data-toggle="${p.id}" ${p.enabled ? 'checked' : ''} />
          <span class="name" data-rename="${p.id}" style="cursor:text" title="Click to rename">${escapeHtml(p.name)}</span>
        </label>
        <div class="meta">${p.sources ?? 0} conversations · ${p.enabled ? 'enabled' : 'disabled'}</div>
      </div>`).join('') : '<p class="empty" style="margin-top:10px">No projects imported yet. Import a ChatGPT export first.</p>'}`;
  const refresh = async () => {
    const { projects } = await api('/api/projects');
    showModal(render(projects));
    document.querySelectorAll('[data-toggle]').forEach((el) => el.addEventListener('change', async () => {
      const id = (el as HTMLElement).dataset.toggle;
      const on = (el as HTMLInputElement).checked;
      await api(`/api/projects/${id}/${on ? 'enable' : 'disable'}`, { method: 'POST' });
      await loadGraph();
      await refreshStats();
      refresh();
    }));
    document.querySelectorAll('[data-rename]').forEach((el) => el.addEventListener('click', async () => {
      const id = (el as HTMLElement).dataset.rename;
      const current = (el as HTMLElement).textContent ?? '';
      const name = prompt('Rename project', current);
      if (name && name.trim() && name.trim() !== current) {
        await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
        refresh();
      }
    }));
  };
  refresh();
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
  $('#btn-projects').addEventListener('click', showProjects);

  setupSearch();
  setupLive();
  await loadGraph();
  await refreshStats();
}

main();
