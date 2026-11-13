import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLaunch, findLiveTerminal, pickSpace, relativeTime, shortPath } from "../mods/session-search/logic.js";

test("findLiveTerminal：按 agent-resume 标签或启动命令认出正在跑的会话", () => {
  const s = { sessionId: "abc-123" };
  const terms = [
    { address: "t1", state: "finished", labels: { "agent-resume": JSON.stringify({ session: "abc-123" }) } },
    { address: "t2", state: "live", labels: { "agent-resume": "{坏的 json" }, argv: ["zsh"] },
    { address: "t3", state: "live", labels: {}, argv: ["claude", "--resume", "abc-123"] },
  ];
  assert.equal(findLiveTerminal(terms, s).address, "t3", "结束的终端不算，坏标签不报错");
  assert.equal(findLiveTerminal([{ address: "t4", state: "live", labels: { "agent-resume": JSON.stringify({ session: "abc-123" }) } }], s).address, "t4");
  assert.equal(findLiveTerminal(terms, { sessionId: "zzz" }), null);
});

test("buildLaunch：带 env、目录不存在回退 home、tab 名截断", () => {
  const s = { cwd: "/w/api", title: "一二三四五六七八九十一二三四五六七八九十多出来", resume: { argv: ["codex", "resume", "x"], env: { CODEX_HOME: "/o/home" } } };
  const ok = buildLaunch(s, "/Users/me", () => true);
  assert.deepEqual(ok.argv, ["env", "CODEX_HOME=/o/home", "codex", "resume", "x"]);
  assert.equal(ok.folder, "/w/api");
  assert.equal(ok.name, "一二三四五六七八九十一二三四五六七八九十…");
  assert.equal(ok.warning, null);
  const gone = buildLaunch({ ...s, resume: { argv: ["claude", "--resume", "y"] } }, "/Users/me", () => false);
  assert.deepEqual(gone.argv, ["claude", "--resume", "y"]);
  assert.equal(gone.folder, "/Users/me");
  assert.match(gone.warning, /不存在/);
});

test("pickSpace：优先有终端正在该目录的本机 space，其次 space 目录，否则 null", () => {
  const spaces = [
    { id: "s1", folder: "/w/shop", machine: null, tabs: [{ id: "a" }] },
    { id: "s2", folder: "/w/other", machine: null, tabs: [{ id: "b" }] },
    { id: "s3", folder: "/w/api", machine: "vps", tabs: [{ id: "c" }] },
  ];
  const panes = [{ tab: "b", cwd: "/w/shop" }, { tab: "c", cwd: "/w/api" }];
  assert.equal(pickSpace(spaces, panes, "/w/shop").id, "s2");
  assert.equal(pickSpace(spaces, [], "/w/shop").id, "s1");
  assert.equal(pickSpace(spaces, panes, "/w/api"), null, "远程机器的 space 不用");
});

test("relativeTime / shortPath", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  assert.equal(relativeTime(now - 30e3, now), "刚刚");
  assert.equal(relativeTime(now - 5 * 3600e3, now), "5 小时前");
  assert.equal(relativeTime(now - 3 * 86400e3, now), "3 天前");
  assert.equal(shortPath("/Users/me/projects/x", "/Users/me"), "~/projects/x");
  assert.equal(shortPath("/opt/x", "/Users/me"), "/opt/x");
});
