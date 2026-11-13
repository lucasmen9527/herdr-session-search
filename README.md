# herdr-session-search

A [Herdr](https://herdr.dev) mod: full-text search across the session history of every coding agent on your machine — Claude Code, Codex, OMP, Pi, Gemini CLI and OpenCode — then jump to the session if it is running, or resume it in a new tab.

[中文说明](#中文说明)

![Session history](preview.png)

## Use

- `Cmd+Shift+H` opens it (again: closes it).
- Type to search titles, your prompts and the agents' replies. Several words (space-separated) must all appear in one message. CJK substrings work, including two-character words.
- `↑` `↓` to select, `Enter` or click to open:
  - running in a Herdr terminal (an [agent-resume](https://github.com/thuanlm215/herdr-agent-resume) label or the session id in its command) → focus it;
  - otherwise → a new tab in the space already at that folder (or a new space) running the agent's resume command.
- `Tab` switches between *all* and *the focused terminal's folder*.

## Sources

| Agent | Where | Resume |
|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` (sub-agent transcripts skipped) | `claude --dangerously-skip-permissions --resume <id>` |
| Codex | `$CODEX_HOME/sessions` (default `~/.codex`) | `codex --no-daemon resume <id>` |
| Codex started by Orca | `~/Library/Application Support/orca/codex-runtime-home/home/sessions` | same, with that `CODEX_HOME` |
| OMP / Pi | `~/.omp/agent/sessions`, `~/.pi/agent/sessions` | `omp --resume <file>` / `pi --session <file>` |
| Gemini CLI | `~/.gemini/tmp/*/chats/` | `gemini --resume <id>` (folder recovered from the project hash) |
| OpenCode | `~/.local/share/opencode/opencode.db` | `opencode --session <id>` |

Only your prompts and the agents' text replies are indexed (up to 8000 characters each); tool output and injected system blocks are not.

## Index

- `~/.config/herdr-app/data/session-search/index.sqlite`: SQLite FTS5 with the trigram tokenizer; words shorter than 3 characters fall back to `LIKE`.
- Updated incrementally every time the popup opens: JSONL files are read from the last byte offset, unchanged files are skipped, deleted ones are removed.
- Measured on ~1,500 session files: first build ~25 s and 112 MB; an update with no changes ~60 ms; a search 1–50 ms.
- CLI: `node mods/session-search/indexer/cli.mjs index | search --q=<words> [--scope=<folder>] | stats`

## Install

Needs Node.js 22.5+ (built-in `node:sqlite`) and the Herdr app.

```sh
git clone https://github.com/lucasmen9527/herdr-session-search
cd herdr-session-search
node scripts/install.mjs               # copies mods/session-search, binds cmd-shift-h
node scripts/install.mjs --key cmd-k   # another key (refuses one already bound)
node scripts/install.mjs --uninstall   # removes the mod and the key; keeps the index
```

The installer writes `config.json` next to the mod with the absolute path of the `node` that ran it, because Herdr's `exec` may not see a version manager's `PATH`. Optional keys there: `dataDir` (where the index lives) and `home` (which home folder to scan).

## Develop

```sh
npm test
herdr-app check ~/.config/herdr-app/mods/session-search
node scripts/make-demo.mjs /tmp/demo/home   # fake sessions for screenshots
```

Bump `SCHEMA_VERSION` in `indexer/db.mjs` when the text cleaning or the tables change; the next run rebuilds the index.

---

## 中文说明

Herdr 插件：全文搜索本机所有 coding agent 的历史会话（Claude Code、Codex、OMP、Pi、Gemini CLI、OpenCode）。会话正在跑就跳过去，没在跑就新开 tab 恢复。

- `Cmd+Shift+H` 打开；输入关键词即搜，标题、你的提问、AI 的回复都能搜到，中文两字词也行；多个词用空格分隔
- `↑↓` 选择，回车或点击打开；`Tab` 在「全部」和「当前目录」之间切换
- 只索引提问和 AI 文字回复，不索引工具输出；首次建索引约半分钟，之后每次打开增量更新
- 安装：`node scripts/install.mjs`（需要 Node 22.5+），卸载加 `--uninstall`

## License

MIT
