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
| **Zoom micro ↔ macro** | Hierarchical clustering builds **worlds → regions → concepts**. Zoom out to a handful of named worlds, click one to dive into its regions, then individual concepts. |
| **Grows from ChatGPT & Copilot** | An MCP server (`remember` / `link` / `recall`) lets both assistants write to the network *live*, **plus** importers for ChatGPT exports and the Copilot CLI session store. |
| **Toggleable projects** | ChatGPT "projects" are imported as independent groups you can switch **on/off** — hide or reveal whole slices of history from the graph, search and stats without deleting anything. |
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

## Seeding from ChatGPT

ChatGPT has no local database, so you seed it from an official data export:

1. In ChatGPT: **Settings → Data controls → Export data**.
2. You'll get an email with a `.zip`. Unzip it — inside are the conversation files
   (a single `conversations.json`, or split `conversations-000.json`, `-001.json`, … in
   larger exports).
3. Import it — pass either a single file **or the whole unzipped export folder**:

   ```bash
   npm run import:chatgpt -- ~/Downloads/conversations.json      # single file
   npm run import:chatgpt -- ~/Downloads/my-chatgpt-export       # export folder (split files)
   ```

The importer linearizes each conversation's message tree and ingests every user/assistant
turn. Re-running with a newer export is safe — concepts are de-duplicated and simply
reinforced. For **continuous** growth (no manual exports), add the MCP server to ChatGPT
as a connector (below) and ask it to `remember` things as you chat.

### Projects (turn groups of chats on/off)

If you organise chats into **projects** in ChatGPT, the importer detects them (via the
export's project id) and creates a matching project in the network. **Everything is
imported**, and each project can be toggled **on or off** independently:

- Disabled projects stay imported but are **hidden** from the graph, search, recall and
  stats — turn them back on anytime, nothing is lost.
- The ChatGPT export does **not** include project names, so projects are seeded with
  placeholder names (`Project 1`, `Project 2`, …). Rename them in the UI (**Projects**
  button) or via the API.

Manage projects from the **Projects** button in the UI, the REST API
(`GET /api/projects`, `POST /api/projects/{id}/{enable|disable}`, `PATCH /api/projects/{id}`),
or the MCP tools (`projects`, `toggle_project`). To show only one project, disable the
others — e.g. keep just your own project enabled and switch the rest off.

---

## API documentation

- **OpenAPI 3.1 spec:** [`docs/openapi.yaml`](docs/openapi.yaml) — every endpoint with
  success **and** error responses (app-level `{ error }`, plus 400/415/500 envelopes).
  View it with any Swagger/Redoc viewer, e.g. `npx @redocly/cli preview-docs docs/openapi.yaml`.
- **Postman collection:** [`docs/postman_collection.json`](docs/postman_collection.json) —
  import into Postman; each request ships with saved success and error response examples.
  Set the `baseUrl` variable (default `http://127.0.0.1:4319`).

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
`stats`, `projects`, `toggle_project`, plus any self-created tools you approve. As you
chat, ask the assistant to "remember" things — they flow straight into the graph and
appear live in the UI.

---

## Architecture

```
src/
  config.ts            configuration & paths
  db/                  SQLite schema + connection (WAL, FTS5)
  graph/               GraphStore — nodes/edges/observations, live event bus
  graph/generic.ts     shared filter that drops filler tokens from worlds/analysis/tools
  embeddings/          on-device MiniLM embeddings + cosine similarity
  ingest/
    extract.ts         local concept/relation/decision extraction (no LLM needed)
    pipeline.ts        growth engine: extract -> reinforce -> link -> embed
    importers.ts       ChatGPT export + Copilot session-store importers
  analyze/             pattern & decision analyzer (hubs, clusters, themes)
  tools/               self-updating tool registry (safe, human-approved)
  server/              Fastify HTTP + WebSocket API, hierarchical graph view
  mcp/                 MCP stdio server (live growth channel)
web/                   Vite + Sigma.js WebGL front-end
```

### Data model (SQLite)
- `projects` — toggleable groupings of sources (e.g. ChatGPT projects). Disabling one
  hides its concepts from every view without deleting anything.
- `sources` — every imported conversation/session, optionally attributed to a `project`.
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
