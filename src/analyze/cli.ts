import { createContext } from '../context.js';
import { Analyzer } from './analyzer.js';
import { openDb } from '../db/index.js';

async function main() {
  const ctx = createContext();
  const db = openDb(ctx.config.dbPath);
  const analyzer = new Analyzer(db, ctx.store);
  console.log('Analyzing network for patterns and decisions ...');
  const res = analyzer.run();
  console.log('Done:', res);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
