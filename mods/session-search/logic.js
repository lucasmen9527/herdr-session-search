// 不依赖 herdr / gpui 的纯逻辑，node --test 直接测

const AGENTS = {
  claude: { name: "Claude", color: "#d97757" },
  codex: { name: "Codex", color: "#10a37f" },
  omp: { name: "OMP", color: "#8b7cf6" },
  pi: { name: "Pi", color: "#8b7cf6" },
  gemini: { name: "Gemini", color: "#5b8def" },
  opencode: { name: "OpenCode", color: "#e3814f" },
};

export function agentLabel(agent) {
  return AGENTS[agent] ?? { name: agent, color: "#888888" };
}

export function relativeTime(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function shortPath(path, home) {
  if (!path) return "";
  if (home && (path === home || path.startsWith(home + "/"))) return "~" + path.slice(home.length);
  return path;
}

/** 这个会话是否正跑在某个终端里：agent-resume 标签记的会话 id，或者启动命令里带着会话 id */
export function findLiveTerminal(terms, s) {
  for (const t of terms ?? []) {
    if (t.state !== "live") continue;
    const label = t.labels?.["agent-resume"];
    if (label) {
      try {
        if (JSON.parse(label).session === s.sessionId) return t;
      } catch {}
    }
    const argv = Array.isArray(t.argv) ? t.argv.join(" ") : "";
    if (s.sessionId && argv.includes(s.sessionId)) return t;
  }
  return null;
}

const tabName = (title) => {
  const chars = [...(title ?? "").replace(/\s+/g, " ").trim()];
  return chars.length > 20 ? chars.slice(0, 20).join("") + "…" : chars.join("");
};

/** 恢复要执行的命令。需要额外环境变量时（Orca 的 CODEX_HOME）用 env 包一层 */
export function buildLaunch(s, home, exists = () => true) {
  const r = s.resume ?? { argv: [] };
  const envArgs = Object.entries(r.env ?? {}).map(([k, v]) => `${k}=${v}`);
  const argv = envArgs.length ? ["env", ...envArgs, ...r.argv] : [...r.argv];
  const ok = Boolean(s.cwd) && exists(s.cwd);
  return {
    argv,
    folder: ok ? s.cwd : home,
    name: tabName(s.title),
    warning: ok ? null : `${s.cwd ?? "(未知目录)"} 不存在，已在 home 目录里恢复`,
  };
}

/** 选一个 space 放恢复出来的 tab：有终端正在这个目录 > space 的目录就是它；都没有返回 null（新建 space） */
export function pickSpace(spaceList, paneList, folder) {
  const spaceOfTab = new Map();
  for (const sp of spaceList ?? []) for (const tab of sp.tabs ?? []) spaceOfTab.set(tab.id, sp);
  const local = (sp) => sp && !sp.machine;
  const byPane = (paneList ?? []).find((p) => p.cwd === folder && local(spaceOfTab.get(p.tab)));
  if (byPane) return spaceOfTab.get(byPane.tab);
  return (spaceList ?? []).find((sp) => local(sp) && sp.folder === folder) ?? null;
}
