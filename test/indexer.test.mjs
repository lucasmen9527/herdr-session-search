import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../mods/session-search/indexer/db.mjs";
import { defaultSources, runIndex } from "../mods/session-search/indexer/index.mjs";
import { search } from "../mods/session-search/indexer/search.mjs";
import { cleanText } from "../mods/session-search/indexer/text.mjs";

const jl = (...objs) => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "ss-home-"));
  const proj = join(home, ".claude", "projects", "-work-shop");
  mkdirSync(join(proj, "aaaa1111-0000-0000-0000-000000000000", "subagents"), { recursive: true });
  writeFileSync(join(proj, "aaaa1111-0000-0000-0000-000000000000.jsonl"), jl(
    { type: "user", sessionId: "aaaa1111-0000-0000-0000-000000000000", cwd: "/work/shop", timestamp: "2026-11-10T01:00:00Z",
      message: { role: "user", content: "<system-reminder>忽略我</system-reminder>桌面客户端 APP32 闪退怎么办" } },
    { type: "assistant", timestamp: "2026-11-10T01:01:00Z", cwd: "/work/shop",
      message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "改用 APP32.exe 启动" }, { type: "tool_use", name: "Bash" }] } },
    { type: "user", isMeta: true, timestamp: "2026-11-10T01:02:00Z", message: { role: "user", content: "meta 不该被索引" } },
    { type: "user", timestamp: "2026-11-10T01:03:00Z", message: { role: "user", content: [{ type: "tool_result", content: "工具输出不索引" }] } },
    { type: "ai-title", aiTitle: "虚拟机里桌面客户端闪退" },
  ));
  // 子智能体 transcript：不能出现在列表里
  writeFileSync(join(proj, "aaaa1111-0000-0000-0000-000000000000", "subagents", "agent-x.jsonl"), jl(
    { type: "user", sessionId: "aaaa1111-0000-0000-0000-000000000000", message: { role: "user", content: "子智能体内容 sidecar" } },
  ));
  const codexHome = join(home, ".codex");
  const day = join(codexHome, "sessions", "2026", "11", "10");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-2026-11-10T02-00-00-bbbb2222-0000-0000-0000-000000000000.jsonl"), jl(
    { timestamp: "2026-11-10T02:00:00Z", type: "session_meta", payload: { id: "bbbb2222-0000-0000-0000-000000000000", cwd: "/work/api", timestamp: "2026-11-10T02:00:00Z" } },
    { timestamp: "2026-11-10T02:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /work/api ..." }] } },
    { timestamp: "2026-11-10T02:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "订单接口 支付回调请求不到" }] } },
    { timestamp: "2026-11-10T02:00:03Z", type: "turn_context", payload: { model: "gpt-6.1" } },
    { timestamp: "2026-11-10T02:00:04Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已定位到配置缺失" }] } },
  ));
  writeFileSync(join(codexHome, "session_index.jsonl"), jl({ id: "bbbb2222-0000-0000-0000-000000000000", thread_name: "支付回调排查" }));
  const omp = join(home, ".omp", "agent", "sessions", "-work-web");
  mkdirSync(omp, { recursive: true });
  writeFileSync(join(omp, "2026-11-09T00-00-00-000Z_cccc3333.jsonl"), jl(
    { type: "session", id: "cccc3333", cwd: "/work/web", timestamp: "2026-11-09T00:00:00Z", title: "herdr 对比", titleSource: "auto" },
    { type: "message", timestamp: "2026-11-09T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "对比 orca 和 herdr" }] } },
  ));
  return { home, codexHome, claudeFile: join(proj, "aaaa1111-0000-0000-0000-000000000000.jsonl") };
}

function setup() {
  const fx = fixtureHome();
  const db = openDb(join(fx.home, "index.sqlite"));
  const sources = defaultSources(fx.home, { CODEX_HOME: fx.codexHome });
  return { ...fx, db, sources, cleanup: () => (db.close(), rmSync(fx.home, { recursive: true, force: true })) };
}

test("cleanText 去掉注入块并展开斜杠命令", () => {
  assert.equal(cleanText("<system-reminder>x</system-reminder> 你好"), "你好");
  assert.equal(cleanText("<command-name>/model</command-name>\n<command-args>opus</command-args>"), "/model opus");
  assert.equal(cleanText("<task-notification><task-id>x</task-id></task-notification>"), "");
});

test("索引各家会话：标题、cwd、模型、恢复命令", () => {
  const t = setup();
  try {
    const stats = runIndex(t.db, t.sources);
    assert.deepEqual(stats.errors, []);
    const all = search(t.db, {});
    assert.deepEqual(all.map((s) => s.agent).sort(), ["claude", "codex", "omp"]);
    const claude = all.find((s) => s.agent === "claude");
    assert.equal(claude.title, "虚拟机里桌面客户端闪退");
    assert.equal(claude.cwd, "/work/shop");
    assert.equal(claude.model, "claude-opus-5-5");
    assert.equal(claude.msgCount, 2, "meta 和 tool_result 不计入");
    assert.deepEqual(claude.resume.argv, ["claude", "--dangerously-skip-permissions", "--resume", "aaaa1111-0000-0000-0000-000000000000"]);
    const codex = all.find((s) => s.agent === "codex");
    assert.equal(codex.title, "支付回调排查", "取 session_index.jsonl 的线程名");
    assert.equal(codex.msgCount, 2, "AGENTS.md 注入不计入");
    assert.equal(codex.resume.env, undefined, "默认 CODEX_HOME 不额外设置");
    assert.deepEqual(all.find((s) => s.agent === "omp").resume.argv.slice(0, 2), ["omp", "--resume"]);
  } finally {
    t.cleanup();
  }
});

test("搜索：中文两字词、长词、多词、标题、范围", () => {
  const t = setup();
  try {
    runIndex(t.db, t.sources);
    const ids = (q, o = {}) => search(t.db, { query: q, ...o }).map((s) => s.agent).sort();
    assert.deepEqual(ids("闪退"), ["claude"], "两个字走 LIKE");
    assert.deepEqual(ids("APP32.exe"), ["claude"], "AI 回复也能搜到");
    assert.deepEqual(ids("支付回调 订单"), ["codex"], "多词 AND");
    assert.deepEqual(ids("herdr 对比"), ["omp"]);
    assert.deepEqual(ids("工具输出不索引"), []);
    assert.deepEqual(ids("sidecar"), [], "子智能体 transcript 不进索引");
    assert.deepEqual(ids("AGENTS.md"), [], "注入内容不进索引");
    assert.deepEqual(ids("", { scope: "/work/api" }), ["codex"]);
    assert.deepEqual(ids("闪退", { scope: "/work/api" }), []);
    const hit = search(t.db, { query: "APP32" })[0];
    assert.match(hit.preview, /APP32/);
  } finally {
    t.cleanup();
  }
});

test("增量：追加行只读新内容；未变化跳过；删除文件同步清理", () => {
  const t = setup();
  try {
    runIndex(t.db, t.sources);
    assert.equal(runIndex(t.db, t.sources).files, 0, "没变化不重读");
    appendFileSync(t.claudeFile, jl(
      { type: "user", timestamp: "2026-11-11T01:00:00Z", message: { role: "user", content: "后来又问了库存系统" } },
      { type: "custom-title", customTitle: "我起的名字" },
    ));
    const s2 = runIndex(t.db, t.sources);
    assert.equal(s2.files, 1);
    assert.equal(s2.messages, 1, "只解析新增的一行消息");
    const claude = search(t.db, { query: "库存" })[0];
    assert.equal(claude.title, "我起的名字", "人起的名字优先于 ai-title");
    assert.equal(claude.msgCount, 3);
    assert.equal(claude.updatedAt, Date.parse("2026-11-11T01:00:00Z"), "更新时间取消息时间，不信 mtime");
    // 只改 mtime（被批量 touch）：内容没变，不能重复索引消息
    utimesSync(t.claudeFile, new Date(), new Date());
    runIndex(t.db, t.sources);
    assert.equal(search(t.db, { query: "库存" })[0].msgCount, 3);
    rmSync(t.claudeFile);
    const s3 = runIndex(t.db, t.sources);
    assert.equal(s3.pruned, 1);
    assert.deepEqual(search(t.db, { query: "闪退" }), []);
  } finally {
    t.cleanup();
  }
});
