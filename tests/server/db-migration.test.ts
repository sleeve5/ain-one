import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/db.js";
import { validateGraphDefinition } from "../../src/shared/validation.js";

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
    const columns = migrated
      .prepare("PRAGMA table_info(queued_messages)")
      .all() as Array<{ name: string }>;
    const pluginScopeTable = migrated
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_enablement_scopes'")
      .get() as { name: string } | undefined;

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
    expect(columns.map((column) => column.name)).toContain("retry_of_turn_id");
    expect(pluginScopeTable?.name).toBe("plugin_enablement_scopes");
    migrated.close();
  });

  it("reopens a migrated database without renumbering existing queue gaps", () => {
    const dir = mkdtempSync(join(tmpdir(), "ain-one-queue-reopen-"));
    tempDirs.push(dir);
    const filename = join(dir, "current.sqlite");
    const first = createDatabase(filename);
    first.exec(`
      INSERT INTO projects VALUES ('project-1', '/tmp/project', 'Project', NULL, 'now', 'now');
      INSERT INTO conversations (id, project_id, agent_product_id, model_id, permission_mode, queue_paused, title, archived_at, created_at, updated_at)
      VALUES ('conversation-1', 'project-1', 'codex', NULL, 'request_approval', 0, NULL, NULL, 'now', 'now');
      INSERT INTO queued_messages (id, conversation_id, enqueue_seq, content, status, claimed_turn_id, retry_of_turn_id, created_at, updated_at)
      VALUES ('message-2', 'conversation-1', 2, 'second', 'pending', NULL, NULL, 'now', 'now');
      INSERT INTO queued_messages (id, conversation_id, enqueue_seq, content, status, claimed_turn_id, retry_of_turn_id, created_at, updated_at)
      VALUES ('message-3', 'conversation-1', 3, 'third', 'pending', NULL, NULL, 'now', 'now');
    `);
    first.close();

    const reopened = createDatabase(filename);
    expect(reopened.prepare("SELECT id, enqueue_seq FROM queued_messages ORDER BY enqueue_seq").all()).toEqual([
      { id: "message-2", enqueue_seq: 2 },
      { id: "message-3", enqueue_seq: 3 },
    ]);
    reopened.close();
  });

  it("migrates a persisted legacy serial Agent Graph to named-port dataflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "ain-one-legacy-graph-"));
    tempDirs.push(dir);
    const filename = join(dir, "legacy.sqlite");
    const legacy = createDatabase(filename);
    const definition = {
      nodes: [
        {
          id: "draft",
          type: "agent",
          name: "Draft",
          config: {
            agentProductId: "codex",
            modelId: null,
            permissionMode: "request_approval",
            prompt: "Draft: {{input}}",
          },
        },
        {
          id: "review",
          type: "agent",
          name: "Review",
          config: {
            agentProductId: "claude",
            modelId: null,
            permissionMode: "request_approval",
            prompt: "Review this",
          },
        },
      ],
      edges: [{ id: "draft-review", source: "draft", target: "review" }],
      start: ["draft"],
      end: ["review"],
    };
    legacy.exec(`
      INSERT INTO projects VALUES ('project-1', '/tmp/project', 'Project', NULL, 'now', 'now');
    `);
    legacy.prepare(`
      INSERT INTO graphs (
        id, project_id, name, description, definition_json, viewport_json,
        positions_json, archived_at, created_at, updated_at
      ) VALUES ('graph-1', 'project-1', 'Legacy Graph', 'keep me', ?, '{}', '{}', NULL, 'created', 'updated')
    `).run(JSON.stringify(definition));
    legacy.close();

    const migrated = createDatabase(filename);
    const row = migrated.prepare(`
      SELECT name, description, definition_json, archived_at, created_at
      FROM graphs WHERE id = 'graph-1'
    `).get() as {
      name: string;
      description: string;
      definition_json: string;
      archived_at: string | null;
      created_at: string;
    };
    const migratedDefinition = JSON.parse(row.definition_json) as {
      nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>;
      edges: Array<{ source: string; sourcePort?: string; target: string; targetPort?: string }>;
      start: string[];
      end: string[];
    };
    const input = migratedDefinition.nodes.find((node) => node.type === "input")!;
    const output = migratedDefinition.nodes.find((node) => node.type === "output")!;
    const review = migratedDefinition.nodes.find((node) => node.id === "review")!;

    expect(row).toMatchObject({
      name: "Legacy Graph",
      description: "keep me",
      archived_at: null,
      created_at: "created",
    });
    expect(migratedDefinition.start).toEqual([input.id]);
    expect(migratedDefinition.end).toEqual([output.id]);
    expect(migratedDefinition.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: input.id, sourcePort: "input", target: "draft", targetPort: "input" }),
      expect.objectContaining({ source: "draft", sourcePort: "output", target: "review", targetPort: "input" }),
      expect.objectContaining({ source: "review", sourcePort: "output", target: output.id, targetPort: "output" }),
    ]));
    expect(review.config).toMatchObject({
      prompt: "Review this",
      instruction: "{{input}}",
      inputs: [{ id: "input", name: "Input", required: true }],
      outputs: [{ id: "output", name: "Output" }],
    });
    expect(validateGraphDefinition(migratedDefinition)).toEqual([]);
    migrated.close();
  });

  it("infers unambiguous legacy edge ports without quarantining current drafts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ain-one-legacy-ports-"));
    tempDirs.push(dir);
    const filename = join(dir, "legacy.sqlite");
    const legacy = createDatabase(filename);
    const missingPorts = {
      nodes: [
        { id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } },
        { id: "agent", type: "agent", name: "Agent", config: { agentProductId: "codex", modelId: null, permissionMode: "request_approval", instruction: "{{input}}" } },
        { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
      ],
      edges: [
        { id: "input-agent", source: "input", target: "agent" },
        { id: "agent-output", source: "agent", target: "output" },
      ],
      start: ["input"],
      end: ["output"],
    };
    const currentDraft = {
      nodes: [{ id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", multiline: true }] } }],
      edges: [],
      start: [],
      end: [],
    };
    legacy.exec(`INSERT INTO projects VALUES ('project-1', '/tmp/project', 'Project', NULL, 'now', 'now');`);
    const insert = legacy.prepare(`
      INSERT INTO graphs (
        id, project_id, name, description, definition_json, viewport_json,
        positions_json, archived_at, created_at, updated_at
      ) VALUES (?, 'project-1', ?, '', ?, '{}', '{}', NULL, 'created', 'updated')
    `);
    insert.run("missing-ports", "Missing ports", JSON.stringify(missingPorts));
    insert.run("current-draft", "Current draft", JSON.stringify(currentDraft));
    legacy.close();

    const migrated = createDatabase(filename);
    const rows = migrated.prepare(`
      SELECT id, definition_json, archived_at FROM graphs ORDER BY id
    `).all() as Array<{ id: string; definition_json: string; archived_at: string | null }>;
    const migratedDefinition = JSON.parse(rows.find((row) => row.id === "missing-ports")!.definition_json);

    expect(validateGraphDefinition(migratedDefinition)).toEqual([]);
    expect(migratedDefinition.edges).toEqual([
      { id: "input-agent", source: "input", target: "agent", sourcePort: "task", targetPort: "input" },
      { id: "agent-output", source: "agent", target: "output", sourcePort: "output", targetPort: "result" },
    ]);
    expect(rows.find((row) => row.id === "missing-ports")?.archived_at).toBeNull();
    expect(rows.find((row) => row.id === "current-draft")).toEqual({
      id: "current-draft",
      definition_json: JSON.stringify(currentDraft),
      archived_at: null,
    });
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM migration_diagnostics").get()).toEqual({ count: 0 });
    migrated.close();
  });

  it("archives persisted Graphs that cannot be migrated safely and records diagnostics", () => {
    const dir = mkdtempSync(join(tmpdir(), "ain-one-legacy-graph-quarantine-"));
    tempDirs.push(dir);
    const filename = join(dir, "legacy.sqlite");
    const legacy = createDatabase(filename);
    const retiredDefinition = {
      nodes: [{ id: "literal", type: "literal", name: "Literal", config: { value: "keep this" } }],
      edges: [],
      start: ["literal"],
      end: ["literal"],
    };
    const openCodeDefinition = {
      nodes: [
        { id: "input", type: "input", name: "Input", config: { fields: [{ id: "input", name: "Input", description: "", multiline: true }] } },
        { id: "agent", type: "agent", name: "OpenCode", config: { agentProductId: "opencode", modelId: null, permissionMode: "request_approval", instruction: "{{input}}", inputs: [{ id: "input", name: "Input" }], outputs: [{ id: "output", name: "Output" }] } },
        { id: "output", type: "output", name: "Output", config: { fields: [{ id: "output", name: "Output" }] } },
      ],
      edges: [
        { id: "input-agent", source: "input", sourcePort: "input", target: "agent", targetPort: "input" },
        { id: "agent-output", source: "agent", sourcePort: "output", target: "output", targetPort: "output" },
      ],
      start: ["input"],
      end: ["output"],
    };
    legacy.exec(`INSERT INTO projects VALUES ('project-1', '/tmp/project', 'Project', NULL, 'now', 'now');`);
    const insert = legacy.prepare(`
      INSERT INTO graphs (
        id, project_id, name, description, definition_json, viewport_json,
        positions_json, archived_at, created_at, updated_at
      ) VALUES (?, 'project-1', ?, '', ?, '{}', '{}', NULL, 'created', 'updated')
    `);
    insert.run("retired-graph", "Retired", JSON.stringify(retiredDefinition));
    insert.run("opencode-graph", "OpenCode", JSON.stringify(openCodeDefinition));
    legacy.close();

    const migrated = createDatabase(filename);
    const rows = migrated.prepare(`
      SELECT id, definition_json, archived_at FROM graphs ORDER BY id
    `).all() as Array<{ id: string; definition_json: string; archived_at: string | null }>;
    const diagnostics = migrated.prepare(`
      SELECT entity_id, code, details_json
      FROM migration_diagnostics
      WHERE entity_type = 'graph'
      ORDER BY entity_id
    `).all() as Array<{ entity_id: string; code: string; details_json: string }>;

    expect(rows).toEqual([
      { id: "opencode-graph", definition_json: JSON.stringify(openCodeDefinition), archived_at: expect.any(String) },
      { id: "retired-graph", definition_json: JSON.stringify(retiredDefinition), archived_at: expect.any(String) },
    ]);
    expect(diagnostics).toEqual([
      {
        entity_id: "opencode-graph",
        code: "opencode_graph_retired",
        details_json: expect.stringContaining("opencode"),
      },
      {
        entity_id: "retired-graph",
        code: "legacy_graph_manual_migration_required",
        details_json: expect.stringContaining("literal"),
      },
    ]);
    migrated.close();

    const reopened = createDatabase(filename);
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM migration_diagnostics").get()).toEqual({ count: 2 });
    expect(reopened.prepare("SELECT updated_at FROM graphs WHERE id = 'retired-graph'").get()).toEqual({
      updated_at: rows.find((row) => row.id === "retired-graph")?.archived_at,
    });
    reopened.close();
  });

  it("retires persisted OpenCode conversations without deleting their recovery state", () => {
    const dir = mkdtempSync(join(tmpdir(), "ain-one-opencode-retirement-"));
    tempDirs.push(dir);
    const filename = join(dir, "legacy.sqlite");
    const legacy = createDatabase(filename);
    legacy.exec(`
      INSERT INTO projects VALUES ('project-1', '/tmp/project', 'Project', NULL, 'now', 'now');
      INSERT INTO conversations (
        id, project_id, agent_product_id, model_id, permission_mode,
        queue_paused, auto_queue, title, archived_at, created_at, updated_at
      ) VALUES ('conversation-1', 'project-1', 'opencode', 'legacy-model', 'request_approval', 0, 0, 'Legacy', NULL, 'created', 'updated');
      INSERT INTO native_sessions VALUES ('session-1', 'conversation-1', 'native-1', 'created', 'updated');
      INSERT INTO queued_messages (
        id, conversation_id, enqueue_seq, content, status, claimed_turn_id,
        retry_of_turn_id, created_at, updated_at, delivery_id
      ) VALUES ('message-1', 'conversation-1', 1, 'preserve pending', 'pending', NULL, NULL, 'created', 'updated', NULL);
      INSERT INTO queued_messages (
        id, conversation_id, enqueue_seq, content, status, claimed_turn_id,
        retry_of_turn_id, created_at, updated_at, delivery_id
      ) VALUES ('message-2', 'conversation-1', 2, 'preserve staged', 'staged', 'turn-1', NULL, 'created', 'updated', 'delivery-1');
      INSERT INTO turns VALUES ('turn-1', 'conversation-1', 'running', 'message-2', 'native-turn', NULL, 'created', 'updated');
      INSERT INTO turn_snapshots VALUES ('turn-1', 'legacy-model', 'request_approval', '[]', 0);
    `);
    legacy.close();

    const migrated = createDatabase(filename);
    expect(migrated.prepare(`
      SELECT agent_product_id, queue_paused, archived_at
      FROM conversations WHERE id = 'conversation-1'
    `).get()).toEqual({
      agent_product_id: "opencode",
      queue_paused: 1,
      archived_at: expect.any(String),
    });
    expect(migrated.prepare(`
      SELECT id, content, status, delivery_id
      FROM queued_messages WHERE conversation_id = 'conversation-1'
      ORDER BY enqueue_seq
    `).all()).toEqual([
      { id: "message-1", content: "preserve pending", status: "pending", delivery_id: null },
      { id: "message-2", content: "preserve staged", status: "uncertain", delivery_id: "delivery-1" },
    ]);
    expect(migrated.prepare("SELECT status, error_json FROM turns WHERE id = 'turn-1'").get()).toEqual({
      status: "interrupted",
      error_json: expect.stringContaining("opencode_connector_retired"),
    });
    expect(migrated.prepare("SELECT native_session_id FROM native_sessions WHERE id = 'session-1'").get()).toEqual({
      native_session_id: "native-1",
    });
    expect(migrated.prepare(`
      SELECT type, payload_json FROM events WHERE conversation_id = 'conversation-1'
    `).all()).toEqual([
      { type: "warning", payload_json: expect.stringContaining("opencode_connector_retired") },
    ]);
    expect(migrated.prepare(`
      SELECT code FROM migration_diagnostics
      WHERE entity_type = 'conversation' AND entity_id = 'conversation-1'
    `).get()).toEqual({ code: "opencode_connector_retired" });
    migrated.close();

    const reopened = createDatabase(filename);
    expect(reopened.prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE conversation_id = 'conversation-1' AND type = 'warning'
    `).get()).toEqual({ count: 1 });
    expect(reopened.prepare(`
      SELECT COUNT(*) AS count FROM migration_diagnostics
      WHERE entity_type = 'conversation' AND entity_id = 'conversation-1'
    `).get()).toEqual({ count: 1 });
    reopened.close();
  });
});
