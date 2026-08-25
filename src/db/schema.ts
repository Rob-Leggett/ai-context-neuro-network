export const SCHEMA_VERSION = 2;

/**
 * SQLite schema for the Context Neuro Network.
 *
 * Design goals: local-first, low footprint, provenance-preserving.
 * - `projects`   : logical groupings of sources (e.g. ChatGPT "projects"), each
 *                  independently toggleable on/off so you choose what feeds the graph
 * - `nodes`      : concepts / entities / decisions / patterns (the "neurons")
 * - `edges`      : typed, weighted relations between nodes (the "synapses")
 * - `observations`: every time a node was mentioned, with source provenance
 * - `sources`    : where context came from (chatgpt export, copilot session, mcp, manual)
 * - `node_embeddings`: optional on-device vectors for semantic auto-linking
 * - `patterns`   : analyzer output (recurring structure, decisions)
 * - `tools`      : self-updating tool/plugin registry
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  origin      TEXT NOT NULL DEFAULT 'chatgpt', -- source system the project came from
  external_id TEXT,                            -- e.g. ChatGPT conversation_template_id / gizmo id
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,      -- 1 = active/visible, 0 = imported but hidden
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  meta        TEXT,                            -- json
  UNIQUE(origin, external_id)
);
CREATE INDEX IF NOT EXISTS idx_projects_enabled ON projects(enabled);

CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,            -- chatgpt | copilot | mcp | manual
  external_id TEXT,                     -- conversation/session id from origin
  title       TEXT,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL, -- owning project (nullable)
  created_at  INTEGER NOT NULL,
  meta        TEXT,                     -- json
  UNIQUE(kind, external_id)
);
CREATE INDEX IF NOT EXISTS idx_sources_kind ON sources(kind);

CREATE TABLE IF NOT EXISTS nodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,      -- normalized dedupe key (lowercased label)
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'concept', -- concept | entity | decision | pattern | topic
  summary    TEXT,
  weight     REAL NOT NULL DEFAULT 1,   -- importance / activation
  mentions   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  meta       TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_weight ON nodes(weight);

CREATE TABLE IF NOT EXISTS edges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  src        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'related', -- related | causes | part_of | decided | similar | ...
  weight     REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  meta       TEXT,
  UNIQUE(src, dst, kind)
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);

CREATE TABLE IF NOT EXISTS observations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source_id  INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  snippet    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_node ON observations(node_id);
CREATE INDEX IF NOT EXISTS idx_obs_source ON observations(source_id);

CREATE TABLE IF NOT EXISTS node_embeddings (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  dim     INTEGER NOT NULL,
  vec     BLOB NOT NULL             -- Float32Array bytes
);

CREATE TABLE IF NOT EXISTS patterns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,        -- co_occurrence | hub | decision | recurring
  title       TEXT NOT NULL,
  description TEXT,
  score       REAL NOT NULL DEFAULT 0,
  node_id     INTEGER REFERENCES nodes(id) ON DELETE SET NULL, -- optional materialized node
  members     TEXT,                 -- json array of node ids
  created_at  INTEGER NOT NULL,
  UNIQUE(kind, title)
);

CREATE TABLE IF NOT EXISTS tools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  spec        TEXT NOT NULL,        -- json: input schema + handler descriptor
  origin      TEXT NOT NULL DEFAULT 'auto', -- auto | manual
  status      TEXT NOT NULL DEFAULT 'proposed', -- proposed | approved | active | rejected
  rationale   TEXT,                 -- why the system proposed it
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Full text search over nodes for fast lexical recall.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  label, summary, content='nodes', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, label, summary) VALUES (new.id, new.label, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, label, summary) VALUES('delete', old.id, old.label, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, label, summary) VALUES('delete', old.id, old.label, old.summary);
  INSERT INTO nodes_fts(rowid, label, summary) VALUES (new.id, new.label, new.summary);
END;
`;
