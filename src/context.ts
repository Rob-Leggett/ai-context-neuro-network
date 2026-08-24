import { openDb } from './db/index.js';
import { GraphStore } from './graph/store.js';
import { Embedder } from './embeddings/embedder.js';
import { IngestPipeline } from './ingest/pipeline.js';
import { loadConfig, type Config } from './config.js';

export interface AppContext {
  config: Config;
  store: GraphStore;
  embedder: Embedder;
  pipeline: IngestPipeline;
}

let ctx: AppContext | null = null;

export function createContext(overrides?: Partial<Config>): AppContext {
  const config = { ...loadConfig(), ...overrides };
  const db = openDb(config.dbPath);
  const store = new GraphStore(db);
  const embedder = new Embedder(config);
  const pipeline = new IngestPipeline({ store, embedder, config });
  return { config, store, embedder, pipeline };
}

export function getContext(): AppContext {
  if (!ctx) ctx = createContext();
  return ctx;
}
