import Database from "better-sqlite3";

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS concepts (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      type       TEXT NOT NULL,
      status     TEXT NOT NULL,
      product    TEXT,
      tags       TEXT NOT NULL DEFAULT '[]',
      code_areas TEXT NOT NULL DEFAULT '[]',
      task_status TEXT,
      taken_by   TEXT,
      taken_at   TEXT,
      done_at    TEXT,
      file_path  TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      body       TEXT NOT NULL,
      hash       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_concepts_file_path ON concepts(file_path);

    CREATE TABLE IF NOT EXISTS edges (
      from_id  TEXT NOT NULL,
      to_id    TEXT NOT NULL,
      relation TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id, relation)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS concepts_fts USING fts5(title, body, tags);

    CREATE TABLE IF NOT EXISTS embeddings (
      id     TEXT PRIMARY KEY,
      vector BLOB NOT NULL,
      hash   TEXT NOT NULL
    );
  `);
  // Additive migrations for .brainz dbs created before a column existed.
  // (.brainz is derived state — worst case it can be deleted and rebuilt.)
  for (const stmt of [
    `ALTER TABLE concepts ADD COLUMN code_areas TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE concepts ADD COLUMN task_status TEXT`,
    `ALTER TABLE concepts ADD COLUMN taken_by TEXT`,
    `ALTER TABLE concepts ADD COLUMN taken_at TEXT`,
    `ALTER TABLE concepts ADD COLUMN done_at TEXT`,
  ]) {
    try {
      db.exec(stmt);
    } catch {
      /* column already exists */
    }
  }
  return db;
}
