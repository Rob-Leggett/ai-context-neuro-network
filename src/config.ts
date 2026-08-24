import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export interface Config {
  dbPath: string;
  host: string;
  port: number;
  /** Enable on-device embeddings (transformers.js). Off = lexical-only, lowest resource. */
  embeddings: boolean;
  /** Cosine similarity threshold for auto-linking concepts. */
  autoLinkThreshold: number;
  /** Root directory for persistent data. */
  dataDir: string;
}

function resolveDataDir(): string {
  const fromEnv = process.env.CNN_DATA_DIR;
  const dir = fromEnv ? path.resolve(fromEnv) : path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig(): Config {
  const dataDir = resolveDataDir();
  return {
    dataDir,
    dbPath: process.env.CNN_DB_PATH || path.join(dataDir, 'neuro.sqlite'),
    host: process.env.CNN_HOST || '127.0.0.1',
    port: Number(process.env.CNN_PORT || 4319),
    embeddings: process.env.CNN_EMBEDDINGS !== '0',
    autoLinkThreshold: Number(process.env.CNN_AUTOLINK_THRESHOLD || 0.62),
  };
}

export const homeCacheDir = path.join(os.homedir(), '.cache', 'ai-context-neuro-network');
