import path from 'node:path';
import fs from 'node:fs';
import type { Config } from '../config.js';
import { homeCacheDir } from '../config.js';

/**
 * On-device embeddings via transformers.js (all-MiniLM-L6-v2, 384-dim).
 * Lazy-loaded so the model is only pulled/initialized when embeddings are
 * actually used. When disabled (config.embeddings = false) the network still
 * works fully with lexical + co-occurrence linking — keeping resource use low.
 */
export class Embedder {
  private pipe: any | null = null;
  private loading: Promise<any> | null = null;
  readonly enabled: boolean;

  constructor(cfg: Config) {
    this.enabled = cfg.embeddings;
  }

  private async load(): Promise<any> {
    if (this.pipe) return this.pipe;
    if (!this.loading) {
      this.loading = (async () => {
        const { pipeline, env } = await import('@xenova/transformers');
        const cacheDir = process.env.CNN_MODEL_CACHE || path.join(homeCacheDir, 'models');
        fs.mkdirSync(cacheDir, { recursive: true });
        env.allowLocalModels = true;
        env.cacheDir = cacheDir;
        const pipe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        this.pipe = pipe;
        return pipe;
      })();
    }
    return this.loading;
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this.enabled) return null;
    const clean = text.trim().slice(0, 512);
    if (!clean) return null;
    const pipe = await this.load();
    const out = await pipe(clean, { pooling: 'mean', normalize: true });
    return Float32Array.from(out.data as Float32Array);
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  // vectors are L2-normalized on output, so dot == cosine.
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
