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
      archived_at TEXT,
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
      auto_queue INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      archived_at TEXT,
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
      retry_of_turn_id TEXT,
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
      plugin_versions_json TEXT NOT NULL,
      auto_queue INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS plugin_enablements (
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_type, scope_id, plugin_id)
    );

    CREATE TABLE IF NOT EXISTS plugin_enablement_scopes (
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope_type, scope_id)
    );

    CREATE TABLE IF NOT EXISTS agent_installations (
      agent_product_id TEXT PRIMARY KEY,
      executable_path TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_settings (
      agent_product_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS graphs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      viewport_json TEXT NOT NULL,
      positions_json TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS graph_runs (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT,
      error_json TEXT,
      input_values_json TEXT,
      output_values_json TEXT,
      graph_snapshot_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS graph_node_runs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES graph_runs(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      status TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT,
      error_json TEXT,
      input_values_json TEXT,
      output_values_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS graph_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES graph_runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      node_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (run_id, sequence)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS graph_runs_one_active_per_graph
    ON graph_runs(graph_id) WHERE status = 'running';

    CREATE UNIQUE INDEX IF NOT EXISTS turns_one_active_per_conversation
    ON turns(conversation_id)
    WHERE status IN ('starting', 'running', 'cancelling');
  `);

  migrateQueuedMessageSequence(db);
  migrateWorkspaceManagement(db);
  migrateGraphManagement(db);
  migrateTraeQueue(db);
  migrateQueueDeliveries(db);
}

function migrateGraphManagement(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(graphs)").all() as Array<{ name: string }>).map((item) => item.name));
  if (!columns.has("archived_at")) db.exec("ALTER TABLE graphs ADD COLUMN archived_at TEXT");
  const runColumns = new Set((db.prepare("PRAGMA table_info(graph_runs)").all() as Array<{ name: string }>).map((item) => item.name));
  if (!runColumns.has("input_values_json")) db.exec("ALTER TABLE graph_runs ADD COLUMN input_values_json TEXT");
  if (!runColumns.has("output_values_json")) db.exec("ALTER TABLE graph_runs ADD COLUMN output_values_json TEXT");
  if (!runColumns.has("graph_snapshot_json")) db.exec("ALTER TABLE graph_runs ADD COLUMN graph_snapshot_json TEXT");
  const nodeRunColumns = new Set((db.prepare("PRAGMA table_info(graph_node_runs)").all() as Array<{ name: string }>).map((item) => item.name));
  if (!nodeRunColumns.has("input_values_json")) db.exec("ALTER TABLE graph_node_runs ADD COLUMN input_values_json TEXT");
  if (!nodeRunColumns.has("output_values_json")) db.exec("ALTER TABLE graph_node_runs ADD COLUMN output_values_json TEXT");
}

function migrateQueueDeliveries(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(queued_messages)").all() as Array<{ name: string }>).map((item) => item.name));
  if (!columns.has("delivery_id")) db.exec("ALTER TABLE queued_messages ADD COLUMN delivery_id TEXT");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS queued_messages_one_staged_idx
    ON queued_messages(conversation_id)
    WHERE status = 'staged'
  `);
}

function migrateTraeQueue(db: DatabaseSync): void {
  for (const [table, column] of [["conversations", "auto_queue"], ["turn_snapshots", "auto_queue"]] as const) {
    const exists = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((item) => item.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
}

function migrateWorkspaceManagement(db: DatabaseSync): void {
  for (const [table, column, definition] of [
    ["projects", "archived_at", "TEXT"],
    ["conversations", "title", "TEXT"],
    ["conversations", "archived_at", "TEXT"],
  ] as const) {
    const exists = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((item) => item.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrateQueuedMessageSequence(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const hasEnqueueSeq = (db
      .prepare("PRAGMA table_info(queued_messages)")
      .all() as Array<{ name: string }>).some(
      (column) => column.name === "enqueue_seq",
    );

    if (!hasEnqueueSeq) {
      db.exec("ALTER TABLE queued_messages ADD COLUMN enqueue_seq INTEGER;");
    }

    const hasRetryOfTurnId = (db
      .prepare("PRAGMA table_info(queued_messages)")
      .all() as Array<{ name: string }>).some(
      (column) => column.name === "retry_of_turn_id",
    );
    if (!hasRetryOfTurnId) {
      db.exec("ALTER TABLE queued_messages ADD COLUMN retry_of_turn_id TEXT;");
    }

    db.exec(`
      WITH current AS (
        SELECT COALESCE(MAX(enqueue_seq), 0) AS max_seq
        FROM queued_messages
      ), ranked AS (
        SELECT
          rowid AS message_rowid,
          (SELECT max_seq FROM current) + ROW_NUMBER() OVER (
            PARTITION BY conversation_id
            ORDER BY created_at ASC, rowid ASC
          ) AS enqueue_seq
        FROM queued_messages
        WHERE enqueue_seq IS NULL
      )
      UPDATE queued_messages
      SET enqueue_seq = (
        SELECT ranked.enqueue_seq
        FROM ranked
        WHERE ranked.message_rowid = queued_messages.rowid
      )
      WHERE enqueue_seq IS NULL
    `);

    const incomplete = db
      .prepare(
        "SELECT COUNT(*) AS count FROM queued_messages WHERE enqueue_seq IS NULL",
      )
      .get() as { count: number };
    if (incomplete.count > 0) {
      throw new Error("Failed to backfill queued message sequence");
    }

    db.exec("DROP INDEX IF EXISTS queued_messages_pending_idx;");
    db.exec(`
      CREATE INDEX queued_messages_pending_idx
      ON queued_messages(conversation_id, enqueue_seq)
      WHERE status = 'pending'
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS queued_messages_sequence_idx
      ON queued_messages(conversation_id, enqueue_seq)
      WHERE enqueue_seq IS NOT NULL
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS queued_messages_retry_idx
      ON queued_messages(retry_of_turn_id)
      WHERE retry_of_turn_id IS NOT NULL
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
