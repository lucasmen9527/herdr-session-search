#!/usr/bin/env node
// 命令行入口，Herdr mod 通过 exec 调用，输出一行 JSON：
//   cli.mjs index                         增量建索引（同一时间只跑一个）
//   cli.mjs search [--q 词] [--scope 目录] [--agent claude] [--limit N]
//   cli.mjs stats
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openDb } from "./db.mjs";
import { defaultSources, runIndex } from "./index.mjs";
import { search, stats } from "./search.mjs";

process.removeAllListeners("warning"); // node:sqlite 的 ExperimentalWarning 会污染 stderr

// mod 目录下的 config.json（安装时生成）：可选 dataDir（索引放哪）、home（从哪个 home 扫会话）
function readConfig() {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "config.json"), "utf8"));
  } catch {
    return {};
  }
}
const CONFIG = readConfig();
const DATA_DIR = process.env.SESSION_SEARCH_DATA || CONFIG.dataDir ||
  join(process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app"), "data", "session-search");
const DB_PATH = join(DATA_DIR, "index.sqlite");
const LOCK_PATH = join(DATA_DIR, "index.lock");
const STATUS_PATH = join(DATA_DIR, "status.json");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** 独占锁：拿不到（另一个索引进程活着）返回 false */
function lock() {
  mkdirSync(DATA_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(readFileSync(LOCK_PATH, "utf8"));
      if (pid && alive(pid)) return false;
      unlinkSync(LOCK_PATH); // 上次被杀留下的锁
    }
  }
  return false;
}

function readStatus() {
  try {
    return JSON.parse(readFileSync(STATUS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { q: { type: "string" }, scope: { type: "string" }, agent: { type: "string" }, limit: { type: "string" } },
  });
  const cmd = positionals[0] ?? "stats";
  if (cmd === "index") {
    if (!lock()) return { busy: true, status: readStatus() };
    try {
      const db = openDb(DB_PATH);
      const result = runIndex(db, defaultSources(CONFIG.home || homedir()));
      result.errorCount = result.errors.length;
      result.errors = result.errors.slice(0, 20);
      const status = { at: Date.now(), ...result, ...stats(db) };
      writeFileSync(STATUS_PATH, JSON.stringify(status));
      db.close();
      return status;
    } finally {
      unlinkSync(LOCK_PATH);
    }
  }
  const db = openDb(DB_PATH);
  try {
    if (cmd === "search") {
      const t = Date.now();
      const sessions = search(db, { query: values.q, scope: values.scope, agent: values.agent, limit: Number(values.limit) || 80 });
      return { sessions, ms: Date.now() - t, status: readStatus() };
    }
    if (cmd === "stats") return { ...stats(db), status: readStatus() };
    return { error: `unknown command ${cmd}` };
  } finally {
    db.close();
  }
}

try {
  process.stdout.write(JSON.stringify(main()) + "\n");
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e.message }) + "\n");
  process.exitCode = 1;
}
