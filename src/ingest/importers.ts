import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { AppContext } from '../context.js';
import type { IngestMessage } from './pipeline.js';

/**
 * Load conversations from a ChatGPT export. Modern exports split the history
 * across several `conversations-000.json`, `conversations-001.json`, ... files,
 * so `filePath` may be either a single JSON file or the export directory.
 */
function loadChatGPTConversations(filePath: string): any[] {
  const stat = fs.statSync(filePath);
  const files: string[] = stat.isDirectory()
    ? fs
        .readdirSync(filePath)
        .filter((f) => /^conversations.*\.json$/i.test(f))
        .sort()
        .map((f) => path.join(filePath, f))
    : [filePath];
  const all: any[] = [];
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list: any[] = Array.isArray(raw) ? raw : raw.conversations ?? [];
    for (const c of list) all.push(c);
  }
  return all;
}

/** ChatGPT groups conversations into "projects" via an opaque template/gizmo id. */
function chatGPTProjectId(conv: any): string | null {
  return conv.conversation_template_id ?? conv.gizmo_id ?? null;
}

/**
 * Import a ChatGPT data export. Accepts either `conversations.json`, one of the
 * split `conversations-NNN.json` files, or the export directory. Each
 * conversation is a DAG of message nodes under `mapping`; we linearize via
 * timestamps. Conversations are grouped into toggleable projects.
 */
export async function importChatGPT(
  ctx: AppContext,
  filePath: string,
  onProgress?: (done: number, total: number, title: string) => void,
): Promise<{
  conversations: number;
  projects: number;
  conceptsTouched: number;
  edges: number;
  decisions: number;
}> {
  const conversations = loadChatGPTConversations(filePath);
  let conceptsTouched = 0;
  let edges = 0;
  let decisions = 0;

  // Resolve (and lazily create) a project per external template id. New projects
  // are seeded enabled so everything is imported and visible; toggle them off in
  // the UI/API afterwards. Names are placeholders — the export omits real names.
  const projectCache = new Map<string, number>();
  const resolveProject = (conv: any): number | null => {
    const ext = chatGPTProjectId(conv);
    if (!ext) return null;
    const cached = projectCache.get(ext);
    if (cached != null) return cached;
    const project = ctx.store.upsertProject({
      origin: 'chatgpt',
      externalId: ext,
      name: `Project ${projectCache.size + 1}`,
    });
    projectCache.set(ext, project.id);
    return project.id;
  };

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const projectId = resolveProject(conv);
    const messages = linearizeChatGPT(conv);
    if (messages.length === 0) continue;
    const res = await ctx.pipeline.ingestConversation(
      'chatgpt',
      String(conv.id ?? conv.conversation_id ?? conv.title ?? i),
      conv.title ?? 'ChatGPT conversation',
      messages,
      projectId,
    );
    conceptsTouched += res.conceptsTouched;
    edges += res.edges;
    decisions += res.decisions;
    onProgress?.(i + 1, conversations.length, conv.title ?? '(untitled)');
  }
  return {
    conversations: conversations.length,
    projects: projectCache.size,
    conceptsTouched,
    edges,
    decisions,
  };
}

function linearizeChatGPT(conv: any): IngestMessage[] {
  const mapping = conv.mapping;
  const out: IngestMessage[] = [];
  if (mapping && typeof mapping === 'object') {
    // Find leaf (node with no children) then walk up, or just collect all.
    const nodes = Object.values<any>(mapping);
    const ordered = nodes
      .filter((n) => n?.message?.content)
      .sort((a, b) => (a.message.create_time ?? 0) - (b.message.create_time ?? 0));
    for (const n of ordered) {
      const msg = n.message;
      const role = msg.author?.role ?? 'user';
      if (role === 'system') continue;
      const parts = msg.content?.parts ?? [];
      const text = parts
        .map((p: any) => (typeof p === 'string' ? p : p?.text ?? ''))
        .join('\n')
        .trim();
      if (text) out.push({ role, text, ts: (msg.create_time ?? 0) * 1000 });
    }
  } else if (Array.isArray(conv.messages)) {
    for (const m of conv.messages) {
      const text = typeof m.content === 'string' ? m.content : m.text ?? '';
      if (text) out.push({ role: m.role ?? 'user', text });
    }
  }
  return out;
}

/**
 * Import from the local Copilot CLI session store. Reads `turns` joined to
 * `sessions` and ingests each session as a conversation.
 */
export async function importCopilot(
  ctx: AppContext,
  dbPath: string,
  onProgress?: (done: number, total: number, title: string) => void,
): Promise<{ sessions: number; conceptsTouched: number; edges: number; decisions: number }> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const sessions = db
    .prepare(`SELECT id, repository, branch, summary FROM sessions ORDER BY created_at ASC`)
    .all() as { id: string; repository: string | null; branch: string | null; summary: string | null }[];

  const turnsStmt = db.prepare(
    `SELECT user_message, assistant_response FROM turns WHERE session_id = ? ORDER BY turn_index ASC`,
  );

  let conceptsTouched = 0;
  let edges = 0;
  let decisions = 0;
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const turns = turnsStmt.all(s.id) as { user_message: string | null; assistant_response: string | null }[];
    const messages: IngestMessage[] = [];
    for (const t of turns) {
      if (t.user_message) messages.push({ role: 'user', text: t.user_message });
      if (t.assistant_response) messages.push({ role: 'assistant', text: t.assistant_response });
    }
    if (messages.length === 0) continue;
    const title = s.summary ?? s.repository ?? `Copilot session ${s.id.slice(0, 8)}`;
    const res = await ctx.pipeline.ingestConversation('copilot', s.id, title, messages);
    conceptsTouched += res.conceptsTouched;
    edges += res.edges;
    decisions += res.decisions;
    onProgress?.(i + 1, sessions.length, title);
  }
  db.close();
  return { sessions: sessions.length, conceptsTouched, edges, decisions };
}
