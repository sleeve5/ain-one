import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/db.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SQLite migration", () => {
  it("backfills enqueue sequence and replaces the legacy pending index", () => {
    const dir = mkdtempSync(join(tmpdir(), "ain-one-task2-"));
    tempDirs.push(dir);
    const filename = join(dir, "legacy.sqlite");
    const legacy = new DatabaseSync(filename);

    legacy.exec(`
      CREATE TABLE queued_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        claimed_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX queued_messages_pending_idx
      ON queued_messages(conversation_id, created_at)
      WHERE status = 'pending';
    `);
    const insert = legacy.prepare(`
      INSERT INTO queued_messages (
        id, conversation_id, content, status, claimed_turn_id, created_at, updated_at
      ) VALUES (?, 'conversation-1', ?, 'pending', NULL, ?, ?)
    `);
    const timestamp = "2026-08-19T00:00:00.000Z";
    insert.run("z-first", "first", timestamp, timestamp);
    insert.run("a-second", "second", timestamp, timestamp);
    legacy.close();

    const migrated = createDatabase(filename);
    const messages = migrated
      .prepare(`
        SELECT id, enqueue_seq
        FROM queued_messages
        ORDER BY enqueue_seq
      `)
      .all() as Array<{ id: string; enqueue_seq: number | null }>;
    const indexColumns = migrated
      .prepare("PRAGMA index_info(queued_messages_pending_idx)")
      .all() as Array<{ name: string }>;
    const index = migrated
      .prepare(`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'index' AND name = 'queued_messages_pending_idx'
      `)
      .get() as { sql: string };

    expect(messages).toEqual([
      { id: "z-first", enqueue_seq: 1 },
      { id: "a-second", enqueue_seq: 2 },
    ]);
    expect(messages.every((message) => message.enqueue_seq !== null)).toBe(true);
    expect(indexColumns.map((column) => column.name)).toEqual([
      "conversation_id",
      "enqueue_seq",
    ]);
    expect(index.sql).toContain("enqueue_seq");
    expect(index.sql).not.toContain("created_at");
    migrated.close();
  });
});
