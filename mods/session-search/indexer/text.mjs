// 消息文本清洗：去掉注入的系统块，保留人能搜到的内容

export const MAX_MESSAGE_CHARS = 8000;

const DROP_BLOCKS = [
  "system-reminder",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "command-message",
  "environment_context",
  "user_instructions",
  "permissions instructions",
  "INSTRUCTIONS",
  "turn_aborted",
  "task-notification",
];

/** 去掉注入块；`<command-name>/x</command-name><command-args>y</command-args>` 变成 `/x y` */
export function cleanText(raw) {
  if (typeof raw !== "string") return "";
  let s = raw;
  for (const tag of DROP_BLOCKS) {
    const name = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(`<${name}>[\\s\\S]*?</${name.split(" ")[0]}>`, "g"), " ");
  }
  s = s.replace(/<command-name>([\s\S]*?)<\/command-name>\s*(?:<command-args>([\s\S]*?)<\/command-args>)?/g,
    (_m, name, args) => `${name.trim()} ${(args ?? "").trim()}`);
  s = s.trim();
  if (s.length > MAX_MESSAGE_CHARS) s = s.slice(0, MAX_MESSAGE_CHARS);
  return s;
}

/** 像注入的上下文而不是人写的话（Codex 把 AGENTS.md、环境信息作为 user 消息塞进来） */
export function isInjected(text) {
  return /^(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<permissions|<INSTRUCTIONS>|Caveat: The messages below)/.test(text);
}

/** 从 [{type:"text",text}] / 字符串 / {text} 里取出文本 */
export function partsText(content, types = ["text", "input_text", "output_text"]) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content && typeof content.text === "string" ? content.text : "";
  return content
    .filter((p) => p && types.includes(p.type) && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

export function toMs(ts) {
  if (typeof ts === "number") return ts < 1e12 ? ts * 1000 : ts;
  if (typeof ts === "string") {
    const n = Date.parse(ts);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** 一行标题：取第一行非空文字，最多 120 字 */
export function oneLine(text, max = 120) {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? line.slice(0, max) : line;
}
