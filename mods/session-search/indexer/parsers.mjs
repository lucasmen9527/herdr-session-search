// 各 agent 的逐行解析器。每个解析器把一行 JSON 归并进 acc：
//   acc.meta: { sessionId, cwd, title, titleRank, model, createdAt }
//   acc.messages: [{ role: "user" | "assistant", ts, text }]
// titleRank：3 = 人起的名字，2 = agent 自动标题，1 = 摘要类；越大越优先
import { cleanText, isInjected, partsText, toMs } from "./text.mjs";

function setTitle(meta, title, rank) {
  if (typeof title !== "string" || !title.trim()) return;
  if (rank >= (meta.titleRank ?? 0)) {
    meta.title = title.trim();
    meta.titleRank = rank;
  }
}

function push(acc, role, ts, raw) {
  const text = cleanText(raw);
  if (!text || isInjected(text)) return;
  acc.messages.push({ role, ts: toMs(ts), text });
}

/** Claude Code：~/.claude/projects/<dir>/<session>.jsonl */
export function claudeLine(o, acc) {
  const m = acc.meta;
  if (o.sessionId && !m.sessionId) m.sessionId = o.sessionId;
  if (o.cwd && !m.cwd) m.cwd = o.cwd;
  if (o.timestamp && !m.createdAt) m.createdAt = toMs(o.timestamp);
  switch (o.type) {
    case "custom-title": return setTitle(m, o.customTitle ?? o.title, 3);
    case "ai-title": return setTitle(m, o.aiTitle ?? o.title, 2);
    case "summary": return setTitle(m, o.summary, 1);
    case "user": {
      if (o.isMeta || o.isSidechain || o.isCompactSummary) return;
      return push(acc, "user", o.timestamp, partsText(o.message?.content, ["text"]));
    }
    case "assistant": {
      if (o.isSidechain) return;
      if (o.message?.model && o.message.model !== "<synthetic>") m.model = o.message.model;
      return push(acc, "assistant", o.timestamp, partsText(o.message?.content, ["text"]));
    }
  }
}

/** Codex：<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl */
export function codexLine(o, acc) {
  const m = acc.meta;
  const p = o.payload ?? {};
  if (o.type === "session_meta") {
    m.sessionId = m.sessionId ?? p.id ?? p.session_id;
    m.cwd = m.cwd ?? p.cwd;
    m.createdAt = m.createdAt ?? toMs(p.timestamp ?? o.timestamp);
    return;
  }
  // 2025 年的旧格式：首行没有 type，直接是 {id, timestamp, ...}
  if (!o.type && o.id && !m.sessionId) {
    m.sessionId = o.id;
    m.createdAt = toMs(o.timestamp);
    return;
  }
  if (o.type === "turn_context" && p.model) {
    m.model = p.model;
    m.cwd = m.cwd ?? p.cwd;
    return;
  }
  const item = o.type === "response_item" ? p : !o.type && o.role ? o : null;
  if (item?.type === "message" && (item.role === "user" || item.role === "assistant")) {
    push(acc, item.role, o.timestamp, partsText(item.content));
  }
}

/** OMP / Pi：~/.omp/agent/sessions/<dir>/<stamp>_<id>.jsonl */
export function ompLine(o, acc) {
  const m = acc.meta;
  switch (o.type) {
    case "session":
      m.sessionId = m.sessionId ?? o.id;
      m.cwd = m.cwd ?? o.cwd;
      m.createdAt = m.createdAt ?? toMs(o.timestamp);
      return setTitle(m, o.title, o.titleSource === "user" ? 3 : 2);
    case "title":
    case "title_change":
      return setTitle(m, o.title, o.source === "user" ? 3 : 2);
    case "model_change":
      if (o.model || o.modelId) m.model = o.modelId ?? o.model;
      return;
    case "message": {
      const role = o.message?.role;
      if (role !== "user" && role !== "assistant") return;
      if (role === "assistant" && o.message.model) m.model = o.message.model;
      return push(acc, role, o.timestamp, partsText(o.message.content, ["text"]));
    }
  }
}

/** Gemini：~/.gemini/tmp/<projectHash>/chats/session-*.json(l) */
export function geminiMessage(o, acc) {
  const role = o.type === "user" ? "user" : o.type === "gemini" ? "assistant" : null;
  if (!role) return;
  const content = Array.isArray(o.content) ? partsText(o.content.map((c) => ({ type: "text", ...c }))) : o.content;
  if (role === "assistant" && o.model) acc.meta.model = o.model;
  push(acc, role, o.timestamp, content);
}

export function newAcc() {
  return { meta: { titleRank: 0 }, messages: [] };
}
