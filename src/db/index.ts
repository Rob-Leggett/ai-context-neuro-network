import Database from 'better-sqlite3';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { loadConfig } from '../config.js';

export type DB = Database.Database;

let singleton: DB | null = null;

export function openDb(dbPath?: string): DB {
  const path = dbPath ?? loadConfig().dbPath;
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  migrate(db);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  } else if (row.value !== String(SCHEMA_VERSION)) {
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(SCHEMA_VERSION));
  }
  return db;
}

/**
 * Lightweight, idempotent migrations for databases created by earlier schema
 * versions. `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL only creates new tables;
 * columns added to existing tables must be patched in here.
 */
function migrate(db: DB): void {
  const sourceCols = db.prepare(`PRAGMA table_info(sources)`).all() as { name: string }[];
  if (!sourceCols.some((c) => c.name === 'project_id')) {
    db.exec(
      `ALTER TABLE sources ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL`,
    );
  }
  // Created here (not in SCHEMA_SQL) so it runs only after project_id exists.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sources_project ON sources(project_id)`);
}

export function getDb(): DB {
  if (!singleton) singleton = openDb();
  return singleton;
}

export function now(): number {
  return Date.now();
}
