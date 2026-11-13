// 索引库：会话元数据 + 消息全文（FTS5 trigram，中文子串可搜）
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// 清洗规则或表结构变了就加 1：旧索引整体重建
const SCHEMA_VERSION = 2;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version !== SCHEMA_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS messages_fts; DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS sessions;
      CREATE TABLE sessions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,          -- 来源文件，或 opencode 的 db 路径
        root TEXT NOT NULL,            -- 来源根目录（codex 恢复时据此决定 CODEX_HOME）
        title TEXT, title_rank INTEGER NOT NULL DEFAULT 0,
        first_prompt TEXT, last_text TEXT,
        cwd TEXT, model TEXT,
        created_at INTEGER, updated_at INTEGER,
        msg_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(agent, session_id)
      );
      CREATE INDEX sessions_updated ON sessions(updated_at);
      CREATE INDEX sessions_cwd ON sessions(cwd);
      CREATE TABLE files(
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL, mtime INTEGER NOT NULL,
        offset INTEGER NOT NULL,       -- jsonl 已读到的字节位置（总在行尾）
        session INTEGER
      );
      CREATE TABLE messages(
        id INTEGER PRIMARY KEY,
        session INTEGER NOT NULL,
        role TEXT NOT NULL,
        ts INTEGER,
        text TEXT NOT NULL
      );
      CREATE INDEX messages_session ON messages(session);
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        text, content='messages', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }
  return db;
}

/** 在一个事务里执行 fn；出错回滚 */
export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
