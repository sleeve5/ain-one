import { DatabaseSync } from "node:sqlite";

export function createDatabase(filename: string): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_product_id TEXT NOT NULL,
      model_id TEXT,
      permission_mode TEXT NOT NULL,
      queue_paused INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS native_sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
      native_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queued_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      enqueue_seq INTEGER NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      claimed_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (conversation_id, enqueue_seq)
    );

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      message_id TEXT NOT NULL REFERENCES queued_messages(id) ON DELETE RESTRICT,
      native_turn_id TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turn_snapshots (
      turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
      model_id TEXT,
      permission_mode TEXT NOT NULL,
      plugin_versions_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (conversation_id, sequence)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS turns_one_active_per_conversation
    ON turns(conversation_id)
    WHERE status IN ('starting', 'running', 'cancelling');
  `);

  migrateQueuedMessageSequence(db);
}

function migrateQueuedMessageSequence(db: DatabaseSync): void {
  const hasEnqueueSeq = (db
    .prepare("PRAGMA table_info(queued_messages)")
    .all() as Array<{ name: string }>).some((column) => column.name === "enqueue_seq");

  if (!hasEnqueueSeq) {
    db.exec("ALTER TABLE queued_messages ADD COLUMN enqueue_seq INTEGER;");
    db.exec(`
      WITH ranked AS (
        SELECT
          rowid AS message_rowid,
          ROW_NUMBER() OVER (
            PARTITION BY conversation_id
            ORDER BY created_at ASC, rowid ASC
          ) AS enqueue_seq
        FROM queued_messages
      )
      UPDATE queued_messages
      SET enqueue_seq = (
        SELECT ranked.enqueue_seq
        FROM ranked
        WHERE ranked.message_rowid = queued_messages.rowid
      )
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS queued_messages_pending_idx
    ON queued_messages(conversation_id, enqueue_seq)
    WHERE status = 'pending'
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS queued_messages_sequence_idx
    ON queued_messages(conversation_id, enqueue_seq)
    WHERE enqueue_seq IS NOT NULL
  `);
}
