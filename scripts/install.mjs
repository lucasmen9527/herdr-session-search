#!/usr/bin/env node
// 安装到 Herdr：复制 mod、记下 node 路径、绑定快捷键（已被占用则拒绝）
//   node scripts/install.mjs [--key cmd-shift-h] [--uninstall]
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { key: { type: "string", default: "cmd-shift-h" }, uninstall: { type: "boolean" } } });
const app = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const dest = join(app, "mods", "session-search");
const keysPath = join(app, "keys.json");
const action = "mod.open:session-search";
const src = join(dirname(fileURLToPath(import.meta.url)), "..", "mods", "session-search");

const keys = JSON.parse(readFileSync(keysPath, "utf8"));
keys.global ??= {};

if (values.uninstall) {
  for (const [k, v] of Object.entries(keys.global)) if (v === action) delete keys.global[k];
  writeFileSync(keysPath, JSON.stringify(keys, null, 2) + "\n");
  rmSync(dest, { recursive: true, force: true });
  console.log(`已卸载：${dest}（索引数据保留在 ${join(app, "data", "session-search")}）`);
  process.exit(0);
}

const current = keys.global[values.key];
if (current && current !== action) {
  console.error(`快捷键 ${values.key} 已绑定为 ${JSON.stringify(current)}，换一个：--key <键>`);
  process.exit(1);
}
cpSync(src, dest, { recursive: true });
writeFileSync(join(dest, "config.json"), JSON.stringify({ node: process.execPath }, null, 2) + "\n");
if (!current) {
  keys.global[values.key] = action;
  writeFileSync(keysPath, JSON.stringify(keys, null, 2) + "\n");
}
console.log(`已安装：${dest}\n快捷键：${values.key}\nnode：${process.execPath}${existsSync(join(app, "keys.error")) ? "\n注意：keys.error 存在，检查 keys.json" : ""}`);
