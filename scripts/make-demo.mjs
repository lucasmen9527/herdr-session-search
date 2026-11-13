#!/usr/bin/env node
// 生成一个假的 home，里面放几家 agent 的演示会话，用来截 preview.png（不碰真实会话）
//   node scripts/make-demo.mjs <目录>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("usage: make-demo.mjs <dir>");
  process.exit(2);
}
const now = Date.now();
const ago = (min) => new Date(now - min * 60e3).toISOString();
const jl = (...objs) => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
let n = 0;
const uuid = () => `${(++n).toString(16).padStart(8, "0")}-demo-4000-8000-${String(n).padStart(12, "0")}`;

function claude(dir, title, turns, minutesAgo, model = "claude-opus-5-5") {
  const id = uuid();
  const proj = join(out, ".claude", "projects", dir.replace(/\//g, "-"));
  mkdirSync(proj, { recursive: true });
  const lines = [{ type: "ai-title", aiTitle: title }];
  turns.forEach(([q, a], i) => {
    const t = minutesAgo + (turns.length - i) * 3;
    lines.push({ type: "user", sessionId: id, cwd: dir, timestamp: ago(t), message: { role: "user", content: q } });
    lines.push({ type: "assistant", sessionId: id, cwd: dir, timestamp: ago(t - 1), message: { role: "assistant", model, content: [{ type: "text", text: a }] } });
  });
  writeFileSync(join(proj, `${id}.jsonl`), jl(...lines));
}

function codex(dir, title, turns, minutesAgo) {
  const id = uuid();
  const day = join(out, ".codex", "sessions", "2026", "11", "13");
  mkdirSync(day, { recursive: true });
  const lines = [{ timestamp: ago(minutesAgo + 30), type: "session_meta", payload: { id, cwd: dir } }, { type: "turn_context", payload: { model: "gpt-6.1" } }];
  turns.forEach(([q, a], i) => {
    const t = minutesAgo + (turns.length - i) * 3;
    lines.push({ timestamp: ago(t), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: q }] } });
    lines.push({ timestamp: ago(t - 1), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: a }] } });
  });
  writeFileSync(join(day, `rollout-demo-${id}.jsonl`), jl(...lines));
  writeFileSync(join(out, ".codex", "session_index.jsonl"), jl({ id, thread_name: title }), { flag: "a" });
}

function omp(dir, title, turns, minutesAgo) {
  const id = uuid();
  const d = join(out, ".omp", "agent", "sessions", dir.replace(/\//g, "-"));
  mkdirSync(d, { recursive: true });
  const lines = [{ type: "session", id, cwd: dir, timestamp: ago(minutesAgo + 30), title, titleSource: "auto" }];
  turns.forEach(([q, a], i) => {
    const t = minutesAgo + (turns.length - i) * 3;
    lines.push({ type: "message", timestamp: ago(t), message: { role: "user", content: [{ type: "text", text: q }] } });
    lines.push({ type: "message", timestamp: ago(t - 1), message: { role: "assistant", content: [{ type: "text", text: a }] } });
  });
  writeFileSync(join(d, `demo_${id}.jsonl`), jl(...lines));
}

const shop = "/Users/demo/code/shop";
const api = "/Users/demo/code/payments-api";
const web = "/Users/demo/code/web";
claude(shop, "购物车结算时金额四舍五入不对", [
  ["结算页总价和明细加起来差一分钱，帮我查下", "原因在 `formatPrice` 里先四舍五入再求和。改成先用分为单位求和，最后再格式化，已补单测。"],
], 4);
claude(api, "Stripe webhook 偶发重复扣款", [
  ["支付回调偶尔会处理两次，导致重复扣款", "webhook 没做幂等。按 event.id 建唯一索引，重复事件直接返回 200，已加集成测试覆盖重放场景。"],
  ["顺便把重试日志加上", "已在 `handleWebhook` 里记录 event.id、attempt 和耗时。"],
], 38);
codex(api, "Refactor payment retry queue", [
  ["Move the retry logic out of the controller into a queue worker", "Done. Retries now run in `RetryWorker` with exponential backoff (max 5 attempts)."],
], 95);
claude(web, "首页 LCP 从 4.2s 优化到 1.6s", [
  ["首页首屏太慢，Lighthouse 只有 52 分", "主要是 hero 大图没压缩、字体阻塞渲染。改成 AVIF + preload 字体后 LCP 从 4.2s 降到 1.6s。"],
], 180, "claude-sonnet-5-5");
omp(web, "暗色模式下表格边框看不见", [["暗色主题里表格边框和背景一个颜色", "边框改用 `--border` 变量，暗色下取 #2a2f3a，已对比度检查 3.1:1。"]], 420);
codex(shop, "Add CSV export for orders", [["Orders page needs a CSV export button", "Added `/orders/export.csv` streaming endpoint and a button in the toolbar."]], 1500);
claude(shop, "升级 React 19 后表单提交报错", [
  ["升级 React 19 以后 useFormState 报 not a function", "React 19 里改名为 `useActionState` 并移到 react 包，已全局替换并修好类型。"],
], 2900);
claude(api, "数据库连接池在高峰期耗尽", [
  ["晚高峰 API 大量 504，日志显示 pool exhausted", "慢查询占着连接不放。加了 statement_timeout=5s，并给订单表补了 (user_id, created_at) 索引，p99 从 3s 降到 180ms。"],
], 7300);
console.log(out);
