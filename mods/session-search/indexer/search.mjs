// 搜索：≥3 字的词走 FTS5 trigram，更短的词（如两个汉字）用 LIKE 兜底

const SNIPPET_RADIUS = 60;

export function terms(query) {
  return (query ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8);
}

const ftsPhrase = (t) => `"${t.replace(/"/g, '""')}"`;
const likeArg = (t) => `%${t.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

/** 每个会话怎么恢复：在 cwd 里跑 argv（env 是要额外设置的环境变量） */
export function resumeCommand(s, { skipPermissions = true } = {}) {
  switch (s.agent) {
    case "claude":
      return { argv: ["claude", ...(skipPermissions ? ["--dangerously-skip-permissions"] : []), "--resume", s.session_id] };
    case "codex":
      // root：非默认的 CODEX_HOME（Orca 启动的会话），默认目录时为空
      return { argv: ["codex", "--no-daemon", "resume", s.session_id], env: s.root ? { CODEX_HOME: s.root } : undefined };
    case "omp":
      return { argv: ["omp", "--resume", s.source] };
    case "pi":
      return { argv: ["pi", "--session", s.source] };
    case "gemini":
      return { argv: ["gemini", "--resume", s.session_id] };
    case "opencode":
      return { argv: ["opencode", "--session", s.session_id] };
    default:
      return null;
  }
}

function snippet(text, ts) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of ts) {
    at = lower.indexOf(t.toLowerCase());
    if (at >= 0) break;
  }
  const flat = (s) => s.replace(/\s+/g, " ");
  if (at < 0) return flat(text.slice(0, SNIPPET_RADIUS * 2));
  const start = Math.max(0, at - SNIPPET_RADIUS);
  return (start > 0 ? "…" : "") + flat(text.slice(start, at + SNIPPET_RADIUS * 2));
}

function shape(row, extra = {}) {
  return {
    agent: row.agent,
    sessionId: row.session_id,
    title: row.title || row.first_prompt || "(无标题)",
    cwd: row.cwd,
    model: row.model,
    updatedAt: row.updated_at,
    msgCount: row.msg_count,
    preview: row.last_text,
    resume: resumeCommand(row),
    ...extra,
  };
}

function scopeClause(scope, params) {
  if (!scope) return "";
  params.push(scope, `${scope.replace(/\/+$/, "")}/%`);
  return " AND (s.cwd = ? OR s.cwd LIKE ?)";
}

/** query 为空：最近的会话；否则全文搜索（标题命中也算） */
export function search(db, { query, scope, agent, limit = 80 } = {}) {
  const ts = terms(query);
  const agentClause = agent ? " AND s.agent = ?" : "";
  if (!ts.length) {
    const params = [];
    const sql = `SELECT s.* FROM sessions s WHERE 1=1${scopeClause(scope, params)}${agentClause}
      ORDER BY s.updated_at DESC LIMIT ?`;
    if (agent) params.push(agent);
    return db.prepare(sql).all(...params, limit).map((r) => shape(r));
  }

  // 消息命中：所有词都要出现在同一条消息里
  const long = ts.filter((t) => [...t].length >= 3);
  const short = ts.filter((t) => [...t].length < 3);
  const params = [];
  let sql = "SELECT m.session, m.text FROM messages m";
  const where = [];
  if (long.length) {
    sql += " JOIN messages_fts f ON f.rowid = m.id";
    where.push("messages_fts MATCH ?");
    params.push(long.map(ftsPhrase).join(" AND "));
  }
  for (const t of short) {
    where.push("m.text LIKE ? ESCAPE '\\'");
    params.push(likeArg(t));
  }
  sql += ` JOIN sessions s ON s.id = m.session WHERE ${where.join(" AND ")}${scopeClause(scope, params)}${agentClause}`;
  if (agent) params.push(agent);
  sql += " ORDER BY s.updated_at DESC, m.id DESC";

  const bySession = new Map();
  for (const hit of db.prepare(sql).iterate(...params)) {
    const e = bySession.get(hit.session);
    if (e) e.hits++;
    else bySession.set(hit.session, { hits: 1, text: hit.text });
  }

  // 标题命中
  const tParams = [];
  let tSql = "SELECT s.id FROM sessions s WHERE " +
    ts.map(() => "(COALESCE(s.title, '') || ' ' || COALESCE(s.first_prompt, '')) LIKE ? ESCAPE '\\'").join(" AND ");
  tParams.push(...ts.map(likeArg));
  tSql += scopeClause(scope, tParams) + agentClause;
  if (agent) tParams.push(agent);
  const titleHits = new Set(db.prepare(tSql).all(...tParams).map((r) => r.id));

  const ids = [...new Set([...bySession.keys(), ...titleHits])];
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT * FROM sessions WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids);
  rows.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  return rows.slice(0, limit).map((r) => {
    const hit = bySession.get(r.id);
    return shape(r, {
      hits: hit?.hits ?? 0,
      titleHit: titleHits.has(r.id),
      preview: hit ? snippet(hit.text, ts) : r.last_text,
    });
  });
}

export function stats(db) {
  const total = db.prepare("SELECT count(*) AS n FROM sessions").get().n;
  const byAgent = db.prepare("SELECT agent, count(*) AS n FROM sessions GROUP BY agent ORDER BY n DESC").all();
  const messages = db.prepare("SELECT count(*) AS n FROM messages").get().n;
  return { sessions: total, messages, byAgent };
}
