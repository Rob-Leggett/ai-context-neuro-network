# ⚡ Context Neuro Network

A **local-first "second brain"** that captures the connections formed while you work with
AI assistants, lets you **see them visually**, **zoom from macro clusters down to micro
concepts**, and **grows automatically** as you chat with ChatGPT and Copilot — all running
on your machine with a tiny footprint.

> Concepts are neurons. Relationships are synapses. Every conversation reinforces the network.

---

## What it does

| Capability | How |
|---|---|
| **Capture connections** | Extracts concepts, entities, decisions and their relationships from every message, with full provenance back to the source conversation. |
| **See how they connect** | A WebGL graph (Sigma.js) renders the whole network; click any node to inspect its connections and where it came from. |
| **Zoom micro ↔ macro** | Louvain community detection groups concepts into clusters. Zoom out for themes/clusters, zoom in for individual concepts (level-of-detail labels). |
| **Grows from ChatGPT & Copilot** | An MCP server (`remember` / `link` / `recall`) lets both assistants write to the network *live*, **plus** importers for ChatGPT exports and the Copilot CLI session store. |
| **Local & low-resource** | Single Node process + one SQLite file. Optional on-device embeddings (a ~25 MB MiniLM model). No cloud, no external services. |
| **UI navigable** | Search, focus/zoom-to-node, neighborhood expansion, live updates over WebSocket. |
| **Updates its own tools** | The network inspects its own structure and *proposes* new MCP tools (e.g. a recall shortcut for a hub concept). You approve them; approved tools become live MCP tools. |
| **Detects patterns & decisions** | An analyzer mines hubs, tight clusters, recurring themes and captured decisions and surfaces them at the macro level. |

---

## Quick start

```bash
npm install

# 1. Seed the network from your existing history
npm run import:copilot                                     # local Copilot CLI sessions
npm run import:chatgpt -- ~/Downloads/conversations.json   # ChatGPT export

# 2. Detect patterns & decisions (optional, also available in the UI)
npm run analyze

# 3. Launch the UI
npm run web:build      # build the frontend once
npm run dev            # start server -> http://127.0.0.1:4319
```

For live UI development with hot reload, run the API (`npm run dev`) and the Vite dev
server (`npm run web:dev` -> http://127.0.0.1:5319) side by side.

---

## Grow it live from your AI chats

The network grows automatically whenever an assistant calls its MCP tools.

**Copilot CLI** — add to `~/.copilot/mcp-config.json` (see `examples/mcp-config.example.json`):

```jsonc
{
  "mcpServers": {
    "context-neuro-network": {
      "type": "local",
      "command": "npx",
      "args": ["tsx", "src/mcp/main.ts"],
      "cwd": "/absolute/path/to/ai-context-neuro-network"
    }
  }
}
```

**ChatGPT** — add the same server as a custom MCP connector (Developer mode / connectors).

Exposed MCP tools: `remember`, `ingest_text`, `recall`, `search`, `link`, `patterns`,
`stats`, plus any self-created tools you approve. As you chat, ask the assistant to
"remember" things — they flow straight into the graph and appear live in the UI.

---

## Architecture

```
src/
  config.ts            configuration & paths
  db/                  SQLite schema + connection (WAL, FTS5)
  graph/               GraphStore — nodes/edges/observations, live event bus
  embeddings/          on-device MiniLM embeddings + cosine similarity
  ingest/
    extract.ts         local concept/relation/decision extraction (no LLM needed)
    pipeline.ts        growth engine: extract -> reinforce -> link -> embed
    importers.ts       ChatGPT export + Copilot session-store importers
  analyze/             pattern & decision analyzer (hubs, clusters, themes)
  tools/               self-updating tool registry (safe, human-approved)
  server/              Fastify HTTP + WebSocket API, Louvain graph view
  mcp/                 MCP stdio server (live growth channel)
web/                   Vite + Sigma.js WebGL front-end
```

### Data model (SQLite)
- `nodes` — concepts/entities/decisions/patterns, with `weight` (importance) and `mentions`.
- `edges` — typed, weighted relations (`related`, `similar`, `decided`, ...). Repeated
  mentions reinforce weight, so frequently-discussed ideas "light up".
- `observations` — every mention, linked to its `source` for provenance.
- `node_embeddings` — optional vectors for semantic auto-linking.
- `patterns` / `tools` — analyzer output and the self-updating tool registry.

Everything is one file (`data/neuro.sqlite`). Delete it to reset.

---

## Design principles

- **Local & private.** Nothing leaves your machine. Embeddings run on-device and are
  fully optional (`CNN_EMBEDDINGS=0` for lexical-only, lowest resource use).
- **Provenance first.** Every concept remembers the snippets it came from.
- **Safe self-extension.** Self-created tools are *data-defined* (a fixed set of
  parameterized, read-only graph actions) and inert until you approve them — never
  arbitrary code execution.
- **Reinforcement.** The more something is discussed, the heavier its node and edges.

See `.env.example` for all configuration options.
