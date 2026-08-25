import os from 'node:os';
import path from 'node:path';
import { createContext } from '../context.js';
import { importChatGPT, importCopilot } from './importers.js';

/**
 * CLI: import context into the neuro network.
 *   npm run import:chatgpt -- /path/to/conversations.json
 *   npm run import:chatgpt -- /path/to/chatgpt-export-dir   (split exports)
 *   npm run import:copilot  [-- /path/to/session-store.db]
 */
async function main() {
  const [, , mode, arg] = process.argv;
  const ctx = createContext();
  const bar = (done: number, total: number, title: string) =>
    process.stdout.write(`\r  [${done}/${total}] ${title.slice(0, 60).padEnd(60)}`);

  if (mode === 'chatgpt') {
    if (!arg) {
      console.error('Usage: npm run import:chatgpt -- <conversations.json | export-dir>');
      process.exit(1);
    }
    console.log(`Importing ChatGPT export from ${arg} ...`);
    const res = await importChatGPT(ctx, arg, bar);
    console.log(`\nDone. ${JSON.stringify(res)}`);
  } else if (mode === 'copilot') {
    const dbPath = arg || path.join(os.homedir(), '.copilot', 'session-store.db');
    console.log(`Importing Copilot sessions from ${dbPath} ...`);
    const res = await importCopilot(ctx, dbPath, bar);
    console.log(`\nDone. ${JSON.stringify(res)}`);
  } else {
    console.error('Unknown mode. Use "chatgpt" or "copilot".');
    process.exit(1);
  }
  console.log('Network stats:', ctx.store.stats());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
