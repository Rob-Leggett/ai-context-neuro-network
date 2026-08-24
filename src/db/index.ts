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
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  }
  return db;
}

export function getDb(): DB {
  if (!singleton) singleton = openDb();
  return singleton;
}

export function now(): number {
  return Date.now();
}
