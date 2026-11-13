// 扫描各 agent 的会话存储，增量写入索引库
import { createHash } from "node:crypto";
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tx } from "./db.mjs";
import { claudeLine, codexLine, geminiMessage, newAcc, ompLine } from "./parsers.mjs";
import { oneLine, toMs } from "./text.mjs";

const CHUNK = 4 * 1024 * 1024;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** 会话来源表。depth1：会话文件只在 root/<目录>/ 下一层（更深的是子智能体 transcript，跳过） */
export function defaultSources(home = homedir(), env = process.env) {
  const codexHome = env.CODEX_HOME?.trim() || join(home, ".codex");
  const orcaCodexHome = join(home, "Library", "Application Support", "orca", "codex-runtime-home", "home");
  return [
    { agent: "claude", kind: "jsonl", root: join(home, ".claude", "projects"), depth1: true, line: claudeLine },
    { agent: "codex", kind: "jsonl", root: join(codexHome, "sessions"), codexHome, line: codexLine },
    // Orca 里启动的 Codex 用的是 Orca 自己的 CODEX_HOME，恢复时要带上
    { agent: "codex", kind: "jsonl", root: join(orcaCodexHome, "sessions"), codexHome: orcaCodexHome, resumeHome: orcaCodexHome, line: codexLine },
    { agent: "omp", kind: "jsonl", root: join(home, ".omp", "agent", "sessions"), depth1: true, line: ompLine },
    { agent: "pi", kind: "jsonl", root: join(home, ".pi", "agent", "sessions"), depth1: true, line: ompLine },
    { agent: "gemini", kind: "gemini", root: join(home, ".gemini", "tmp") },
    { agent: "opencode", kind: "opencode", root: join(home, ".local", "share", "opencode", "opencode.db") },
  ];
}

function listFiles(source) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (source.depth1 && depth >= 1) continue;
        walk(p, depth + 1);
      } else if (e.isFile()) {
        if (source.kind === "jsonl" && e.name.endsWith(".jsonl") && (!source.depth1 || depth === 1)) out.push(p);
        if (source.kind === "gemini" && basename(dir) === "chats" && /\.jsonl?$/.test(e.name)) out.push(p);
      }
    }
  };
  walk(source.root, 0);
  return out;
}

/** 从 offset 起逐行读 jsonl，返回读到的最后一个完整行尾位置 */
function readLines(path, offset, onLine) {
  const fd = openSync(path, "r");
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = offset;
  let consumed = offset;
  let rest = Buffer.alloc(0);
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      let data = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, start)) {
        const line = data.subarray(start, i).toString("utf8");
        consumed += i - start + 1;
        start = i + 1;
        if (line.trim()) {
          let o;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          onLine(o);
        }
      }
      rest = Buffer.from(data.subarray(start));
    }
  } finally {
    closeSync(fd);
  }
  return consumed;
}

class Writer {
  constructor(db) {
    this.db = db;
    this.q = {
      file: db.prepare("SELECT * FROM files WHERE path = ?"),
      session: db.prepare("SELECT * FROM sessions WHERE id = ?"),
      byKey: db.prepare("SELECT * FROM sessions WHERE agent = ? AND session_id = ?"),
      insertSession: db.prepare(`INSERT INTO sessions(agent, session_id, source, root) VALUES (?, ?, ?, ?)`),
      updateSession: db.prepare(`UPDATE sessions SET source = ?, root = ?, title = ?, title_rank = ?, first_prompt = ?,
        last_text = ?, cwd = ?, model = ?, created_at = ?, updated_at = ?, msg_count = ? WHERE id = ?`),
      insertMessage: db.prepare("INSERT INTO messages(session, role, ts, text) VALUES (?, ?, ?, ?)"),
      clearMessages: db.prepare("DELETE FROM messages WHERE session = ?"),
      upsertFile: db.prepare(`INSERT INTO files(path, size, mtime, offset, session) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, offset = excluded.offset, session = excluded.session`),
    };
  }

  /** 已有会话的元数据作为增量解析的起点 */
  seed(row) {
    const acc = newAcc();
    if (row) {
      Object.assign(acc.meta, {
        sessionId: row.session_id, cwd: row.cwd, title: row.title, titleRank: row.title_rank,
        model: row.model, createdAt: row.created_at,
      });
    }
    return acc;
  }

  /** 把 acc 写进库。reset：先清掉这个会话旧的消息（整文件重读时） */
  save({ agent, source, root, acc, reset, prior, fallbackTs }) {
    const m = acc.meta;
    if (!m.sessionId) return null;
    let row = prior && prior.session_id === m.sessionId ? prior : this.q.byKey.get(agent, m.sessionId);
    if (!row) {
      const id = this.q.insertSession.run(agent, m.sessionId, source, root).lastInsertRowid;
      row = this.q.session.get(id);
    }
    if (reset) {
      this.q.clearMessages.run(row.id);
      row = { ...row, msg_count: 0, first_prompt: null, last_text: null, updated_at: null };
    }
    let firstPrompt = row.first_prompt;
    let lastTs = row.updated_at ?? null;
    for (const msg of acc.messages) {
      this.q.insertMessage.run(row.id, msg.role, msg.ts, msg.text);
      if (!firstPrompt && msg.role === "user") firstPrompt = oneLine(msg.text, 200);
      if (msg.ts && (!lastTs || msg.ts > lastTs)) lastTs = msg.ts;
    }
    const last = acc.messages.at(-1);
    const lastText = last ? oneLine(last.text.replace(/\s+/g, " "), 300) : row.last_text;
    this.q.updateSession.run(
      source, root, m.title ?? null, m.titleRank ?? 0, firstPrompt ?? null, lastText ?? null,
      m.cwd ?? null, m.model ?? null, m.createdAt ?? null, lastTs ?? fallbackTs ?? m.createdAt ?? null,
      (row.msg_count ?? 0) + acc.messages.length, row.id,
    );
    return row.id;
  }
}

function indexJsonl(w, source, path, stats) {
  const st = statSync(path);
  const mtime = Math.round(st.mtimeMs);
  const known = w.q.file.get(path);
  if (known && known.size === st.size && known.mtime === mtime) return;
  const prior = known?.session ? w.q.session.get(known.session) : null;
  const append = Boolean(prior && known.offset <= st.size && known.size <= st.size);
  const acc = w.seed(append ? prior : null);
  if (source.agent === "claude") acc.meta.sessionId = basename(path, ".jsonl");
  const offset = readLines(path, append ? known.offset : 0, (o) => source.line(o, acc));
  if (!acc.meta.sessionId) acc.meta.sessionId = basename(path).match(UUID_RE)?.[0];
  if (!append && !acc.messages.length && !acc.meta.title) {
    // 没有可搜内容的空壳会话：记下文件以免反复读，不建会话
    w.q.upsertFile.run(path, st.size, mtime, offset, null);
    return;
  }
  const root = source.agent === "codex" ? (source.resumeHome ?? "") : source.root;
  const id = w.save({ agent: source.agent, source: path, root, acc, reset: !append, prior, fallbackTs: mtime });
  w.q.upsertFile.run(path, st.size, mtime, offset, id);
  stats.files++;
  stats.messages += acc.messages.length;
}

function indexGemini(w, source, path, stats) {
  const st = statSync(path);
  const mtime = Math.round(st.mtimeMs);
  const known = w.q.file.get(path);
  if (known && known.size === st.size && known.mtime === mtime) return;
  const acc = newAcc();
  const text = readFileSync(path, "utf8");
  let records = [];
  try {
    if (path.endsWith(".jsonl")) {
      records = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    } else {
      const doc = JSON.parse(text);
      acc.meta.sessionId = doc.sessionId;
      acc.meta.createdAt = toMs(doc.startTime);
      records = doc.messages ?? [];
    }
  } catch {
    return;
  }
  for (const r of records) {
    if (r.sessionId && !acc.meta.sessionId) acc.meta.sessionId = r.sessionId;
    geminiMessage(r, acc);
  }
  acc.meta.projectHash = basename(dirname(dirname(path)));
  if (!acc.messages.length) {
    w.q.upsertFile.run(path, st.size, mtime, st.size, null);
    return;
  }
  const id = w.save({ agent: "gemini", source: path, root: acc.meta.projectHash, acc, reset: true, fallbackTs: mtime });
  w.q.upsertFile.run(path, st.size, mtime, st.size, id);
  stats.files++;
  stats.messages += acc.messages.length;
}

function indexOpencode(w, source, seen, stats) {
  if (!existsSync(source.root)) return;
  let oc;
  try {
    oc = new DatabaseSync(source.root, { readOnly: true });
  } catch {
    return;
  }
  try {
    const sessions = oc.prepare("SELECT id, title, directory, time_created, time_updated FROM session WHERE parent_id IS NULL").all();
    const parts = oc.prepare(`SELECT p.data AS pdata, m.data AS mdata, p.time_created AS ts FROM part p
      JOIN message m ON m.id = p.message_id WHERE p.session_id = ? ORDER BY p.time_created, p.id`);
    for (const s of sessions) {
      const key = `opencode:${s.id}`;
      seen.add(key);
      const known = w.q.file.get(key);
      if (known && known.mtime === s.time_updated) continue;
      const acc = newAcc();
      Object.assign(acc.meta, { sessionId: s.id, cwd: s.directory, createdAt: s.time_created });
      if (s.title && !/^New session - /.test(s.title)) Object.assign(acc.meta, { title: s.title, titleRank: 2 });
      for (const r of parts.all(s.id)) {
        let p, m;
        try {
          p = JSON.parse(r.pdata);
          m = JSON.parse(r.mdata);
        } catch {
          continue;
        }
        if (p.type !== "text" || p.synthetic || (m.role !== "user" && m.role !== "assistant")) continue;
        if (m.role === "assistant" && m.modelID) acc.meta.model = m.modelID;
        geminiMessage({ type: m.role === "user" ? "user" : "gemini", content: p.text, timestamp: r.ts }, acc);
      }
      const id = acc.messages.length || acc.meta.title
        ? w.save({ agent: "opencode", source: source.root, root: source.root, acc, reset: true, fallbackTs: s.time_updated })
        : null;
      w.q.upsertFile.run(key, 0, s.time_updated, 0, id);
      stats.files++;
      stats.messages += acc.messages.length;
    }
  } finally {
    oc.close();
  }
}

/** Codex 的线程名在 <CODEX_HOME>/session_index.jsonl，单独补上 */
function applyCodexTitles(db, codexHome) {
  const path = join(codexHome, "session_index.jsonl");
  if (!existsSync(path)) return;
  const names = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const o = JSON.parse(line);
      if (o.id && o.thread_name) names.set(o.id, o.thread_name);
    } catch {}
  }
  const update = db.prepare("UPDATE sessions SET title = ?, title_rank = 2 WHERE agent = 'codex' AND session_id = ? AND title_rank <= 2 AND (title IS NULL OR title != ?)");
  for (const [id, name] of names) {
    const title = oneLine(name, 200);
    update.run(title, id, title);
  }
}

/** Gemini 只记 sha256(cwd)；用其他会话里见过的目录反推 */
function mapGeminiCwds(db) {
  const rows = db.prepare("SELECT id, root FROM sessions WHERE agent = 'gemini' AND cwd IS NULL").all();
  if (!rows.length) return;
  const byHash = new Map();
  for (const { cwd } of db.prepare("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL").all()) {
    byHash.set(createHash("sha256").update(cwd).digest("hex"), cwd);
  }
  const set = db.prepare("UPDATE sessions SET cwd = ? WHERE id = ?");
  for (const r of rows) if (byHash.has(r.root)) set.run(byHash.get(r.root), r.id);
}

/** 删掉源文件已经不在的会话 */
function prune(db, seen) {
  const gone = db.prepare("SELECT path, session FROM files").all().filter((f) => !seen.has(f.path));
  const delFile = db.prepare("DELETE FROM files WHERE path = ?");
  const delMsgs = db.prepare("DELETE FROM messages WHERE session = ?");
  const delSession = db.prepare("DELETE FROM sessions WHERE id = ? AND NOT EXISTS (SELECT 1 FROM files WHERE session = ?)");
  for (const f of gone) {
    delFile.run(f.path);
    if (f.session && !db.prepare("SELECT 1 FROM files WHERE session = ?").get(f.session)) {
      delMsgs.run(f.session);
      delSession.run(f.session, f.session);
    }
  }
  return gone.length;
}

/** 一次增量索引。每个文件一个事务，中途被杀也只丢当前文件 */
export function runIndex(db, sources = defaultSources(), { onProgress } = {}) {
  const w = new Writer(db);
  const stats = { files: 0, messages: 0, errors: [], pruned: 0 };
  const seen = new Set();
  const started = Date.now();
  for (const source of sources) {
    if (source.kind === "opencode") {
      try {
        tx(db, () => indexOpencode(w, source, seen, stats));
      } catch (e) {
        stats.errors.push(`${source.root}: ${e.message}`);
      }
      continue;
    }
    const files = listFiles(source);
    files.forEach((path, i) => {
      seen.add(path);
      try {
        tx(db, () => (source.kind === "gemini" ? indexGemini : indexJsonl)(w, source, path, stats));
      } catch (e) {
        stats.errors.push(`${path}: ${e.message}`);
      }
      if (onProgress && i % 50 === 0) onProgress({ agent: source.agent, done: i, total: files.length });
    });
    if (source.codexHome) tx(db, () => applyCodexTitles(db, source.codexHome));
  }
  tx(db, () => {
    mapGeminiCwds(db);
    stats.pruned = prune(db, seen);
  });
  stats.ms = Date.now() - started;
  return stats;
}
