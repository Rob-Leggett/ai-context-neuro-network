import { createContext } from '../context.js';

/**
 * Backfill on-device embeddings for the graph's most important concepts.
 *
 * Grouping (worlds/regions) is computed on the graph's top-N nodes, so we only
 * need vectors for those — embedding all ~75k nodes is unnecessary and the
 * import-time O(N^2) similarity linking does not scale. This targeted backfill
 * embeds each node's label and optional summary. Existing vectors are skipped
 * unless `--refresh` is supplied.
 *
 * Usage: tsx src/embeddings/backfill.ts [limit] [--refresh]   (default 6000)
 */
async function main(): Promise<void> {
  const refresh = process.argv.includes('--refresh');
  const limitArg = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
  const limit = Number(limitArg || 6000);
  // Force embeddings on regardless of CNN_EMBEDDINGS so the embedder loads.
  const ctx = createContext({ embeddings: true });
  const { store, embedder } = ctx;

  const nodes = store.topNodes(limit);
  const todo = refresh ? nodes : nodes.filter((n) => !store.getEmbedding(n.id));
  console.log(
    `[backfill] ${nodes.length} top nodes; ${refresh ? 'refreshing all; ' : `${nodes.length - todo.length} already embedded; `}` +
      `embedding ${todo.length}…`,
  );

  let done = 0;
  for (const n of todo) {
    const text = n.summary ? `${n.label} ${n.summary}` : n.label;
    const vec = await embedder.embed(text);
    if (vec) store.setEmbedding(n.id, vec);
    if (++done % 250 === 0) console.log(`[backfill]   ${done}/${todo.length}`);
  }

  console.log(`[backfill] done — ${store.embeddingCount()} nodes now have embeddings.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
