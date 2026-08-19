import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type {
  ConnectorEvent,
  Conversation,
  CreateConversationInput,
  NativeSessionRecord,
  NormalizedError,
  NormalizedEvent,
  Project,
  QueuedMessage,
  TerminalTurnStatus,
  Turn,
  TurnSnapshot,
} from "../shared/contracts.js";

export interface Repositories {
  createProject(path: string, name: string): Project;
  getProject(projectId: string): Project | null;
  createConversation(input: CreateConversationInput): Conversation;
  getConversation(conversationId: string): Conversation | null;
  setConversationQueuePaused(conversationId: string, queuePaused: boolean): void;
  enqueueMessage(conversationId: string, content: string): QueuedMessage;
  listQueuedMessages(conversationId: string): QueuedMessage[];
  claimNextMessage(
    conversationId: string,
    snapshot: TurnSnapshot,
  ): { message: QueuedMessage; turn: Turn } | null;
  markTurnRunning(turnId: string, nativeTurnId: string | null): void;
  markTurnCancelling(turnId: string): void;
  finishTurn(turnId: string, status: TerminalTurnStatus, error?: NormalizedError): void;
  requeueClaimedMessage(turnId: string): void;
  getActiveTurn(conversationId: string): Turn | null;
  getLatestTurn(conversationId: string): Turn | null;
  getTurn(turnId: string): Turn | null;
  listConversationIdsWithActiveTurns(): string[];
  interruptActiveTurns(): number;
  getNativeSession(conversationId: string): NativeSessionRecord | null;
  upsertNativeSession(conversationId: string, nativeSessionId: string | null): NativeSessionRecord;
  appendEvent(conversationId: string, event: ConnectorEvent): NormalizedEvent;
  eventsAfter(conversationId: string, sequence: number): NormalizedEvent[];
}

export function createRepositories(db: DatabaseSync): Repositories {
  return new SqliteRepositories(db);
}

class SqliteRepositories implements Repositories {
  constructor(private readonly db: DatabaseSync) {}

  createProject(path: string, name: string): Project {
    const now = isoNow();
    const project: Project = {
      id: randomUUID(),
      path,
      name,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO projects (id, path, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(project.id, project.path, project.name, project.createdAt, project.updatedAt);

    return project;
  }

  getProject(projectId: string): Project | null {
    const row = this.getRow<DbProjectRow>(
      `SELECT id, path, name, created_at, updated_at
       FROM projects
       WHERE id = ?`,
      projectId,
    );

    return row ? mapProject(row) : null;
  }

  createConversation(input: CreateConversationInput): Conversation {
    const now = isoNow();
    const conversation: Conversation = {
      id: randomUUID(),
      projectId: input.projectId,
      agentProductId: input.agentProductId,
      modelId: input.modelId,
      permissionMode: input.permissionMode ?? "request_approval",
      queuePaused: false,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO conversations (
            id, project_id, agent_product_id, model_id, permission_mode,
            queue_paused, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversation.id,
        conversation.projectId,
        conversation.agentProductId,
        conversation.modelId,
        conversation.permissionMode,
        conversation.queuePaused ? 1 : 0,
        conversation.createdAt,
        conversation.updatedAt,
      );

    return conversation;
  }

  getConversation(conversationId: string): Conversation | null {
    const row = this.getRow<DbConversationRow>(
      `SELECT
         id,
         project_id,
         agent_product_id,
         model_id,
         permission_mode,
         queue_paused,
         created_at,
         updated_at
       FROM conversations
       WHERE id = ?`,
      conversationId,
    );

    return row ? mapConversation(row) : null;
  }

  setConversationQueuePaused(conversationId: string, queuePaused: boolean): void {
    this.db
      .prepare(
        `UPDATE conversations
         SET queue_paused = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(queuePaused ? 1 : 0, isoNow(), conversationId);
  }

  enqueueMessage(conversationId: string, content: string): QueuedMessage {
    return this.immediateTransaction(() => {
      const nextSequenceRow = this.getRow<{ enqueue_seq: number }>(
        `SELECT COALESCE(MAX(enqueue_seq), 0) + 1 AS enqueue_seq
         FROM queued_messages
         WHERE conversation_id = ?`,
        conversationId,
      );
      if (!nextSequenceRow) {
        throw new Error("Failed to allocate queued message sequence");
      }

      const now = isoNow();
      const message: QueuedMessage = {
        id: randomUUID(),
        conversationId,
        content,
        createdAt: now,
      };

      this.db
        .prepare(
          `INSERT INTO queued_messages (
            id,
            conversation_id,
            enqueue_seq,
            content,
            status,
            claimed_turn_id,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        )
        .run(
          message.id,
          message.conversationId,
          nextSequenceRow.enqueue_seq,
          message.content,
          message.createdAt,
          now,
        );

      return message;
    });
  }

  listQueuedMessages(conversationId: string): QueuedMessage[] {
    const rows = this.getRows<DbQueuedMessageRow>(
      `SELECT id, conversation_id, content, created_at
       FROM queued_messages
       WHERE conversation_id = ? AND status = 'pending'
       ORDER BY enqueue_seq ASC`,
      conversationId,
    );

    return rows.map(mapQueuedMessage);
  }

  claimNextMessage(
    conversationId: string,
    snapshot: TurnSnapshot,
  ): { message: QueuedMessage; turn: Turn } | null {
    return this.immediateTransaction(() => {
      const active = this.getRow<{ id: string }>(
        `SELECT id
         FROM turns
         WHERE conversation_id = ?
           AND status IN ('starting', 'running', 'cancelling')
         LIMIT 1`,
        conversationId,
      );
      if (active) {
        return null;
      }

      const row = this.getRow<DbQueuedMessageRow>(
        `SELECT id, conversation_id, content, created_at
         FROM queued_messages
         WHERE conversation_id = ? AND status = 'pending'
         ORDER BY enqueue_seq ASC
         LIMIT 1`,
        conversationId,
      );

      if (!row) {
        return null;
      }

      const message = mapQueuedMessage(row);
      const now = isoNow();
      const turn: Turn = {
        id: randomUUID(),
        conversationId,
        status: "starting",
        messageId: message.id,
        nativeTurnId: null,
        snapshot,
        createdAt: now,
        updatedAt: now,
      };

      this.db
        .prepare(
          `INSERT INTO turns (
             id, conversation_id, status, message_id, native_turn_id, error_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
        )
        .run(turn.id, turn.conversationId, turn.status, turn.messageId, turn.createdAt, turn.updatedAt);

      this.db
        .prepare(
          `INSERT INTO turn_snapshots (
            turn_id, model_id, permission_mode, plugin_versions_json
          ) VALUES (?, ?, ?, ?)`,
        )
        .run(turn.id, snapshot.modelId, snapshot.permissionMode, JSON.stringify(snapshot.pluginVersions));

      this.db
        .prepare(
          `UPDATE queued_messages
           SET status = 'claimed', claimed_turn_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(turn.id, now, message.id);

      return { message, turn };
    });
  }

  markTurnRunning(turnId: string, nativeTurnId: string | null): void {
    const now = isoNow();
    this.db
      .prepare(
        `UPDATE turns
         SET status = 'running', native_turn_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nativeTurnId, now, turnId);

    this.db
      .prepare(
        `UPDATE queued_messages
         SET status = 'consumed', updated_at = ?
         WHERE id = (SELECT message_id FROM turns WHERE id = ?)`,
      )
      .run(now, turnId);
  }

  markTurnCancelling(turnId: string): void {
    this.db
      .prepare(
        `UPDATE turns
         SET status = 'cancelling', updated_at = ?
         WHERE id = ?`,
      )
      .run(isoNow(), turnId);
  }

  finishTurn(turnId: string, status: TerminalTurnStatus, error?: NormalizedError): void {
    this.db
      .prepare(
        `UPDATE turns
         SET status = ?, error_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, error ? JSON.stringify(error) : null, isoNow(), turnId);
  }

  requeueClaimedMessage(turnId: string): void {
    this.db
      .prepare(
        `UPDATE queued_messages
         SET status = 'pending', claimed_turn_id = NULL, updated_at = ?
         WHERE claimed_turn_id = ?`,
      )
      .run(isoNow(), turnId);
  }

  getActiveTurn(conversationId: string): Turn | null {
    return this.getTurnByWhere(
      `t.conversation_id = ?
       AND t.status IN ('starting', 'running', 'cancelling')`,
      [conversationId],
      "t.updated_at DESC, t.id DESC",
    );
  }

  getLatestTurn(conversationId: string): Turn | null {
    return this.getTurnByWhere(
      "t.conversation_id = ?",
      [conversationId],
      "t.updated_at DESC, t.rowid DESC",
    );
  }

  getTurn(turnId: string): Turn | null {
    return this.getTurnByWhere("t.id = ?", [turnId]);
  }

  listConversationIdsWithActiveTurns(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT conversation_id
         FROM turns
         WHERE status IN ('starting', 'running', 'cancelling')`,
      )
      .all() as Array<{ conversation_id: string }>;

    return rows.map((row) => row.conversation_id);
  }

  interruptActiveTurns(): number {
    const now = isoNow();
    const result = this.db
      .prepare(
        `UPDATE turns
         SET status = 'interrupted', updated_at = ?
         WHERE status IN ('starting', 'running', 'cancelling')`,
      )
      .run(now) as { changes: number };
    return result.changes;
  }

  getNativeSession(conversationId: string): NativeSessionRecord | null {
    const row = this.getRow<DbNativeSessionRow>(
      `SELECT id, conversation_id, native_session_id, created_at, updated_at
       FROM native_sessions
       WHERE conversation_id = ?`,
      conversationId,
    );

    return row ? mapNativeSession(row) : null;
  }

  upsertNativeSession(
    conversationId: string,
    nativeSessionId: string | null,
  ): NativeSessionRecord {
    const existing = this.getNativeSession(conversationId);
    if (existing) {
      const updatedAt = isoNow();
      this.db
        .prepare(
          `UPDATE native_sessions
           SET native_session_id = ?, updated_at = ?
           WHERE conversation_id = ?`,
        )
        .run(nativeSessionId, updatedAt, conversationId);
      return {
        ...existing,
        nativeSessionId,
        updatedAt,
      };
    }

    const now = isoNow();
    const record: NativeSessionRecord = {
      id: randomUUID(),
      conversationId,
      nativeSessionId,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO native_sessions (
          id, conversation_id, native_session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.conversationId, record.nativeSessionId, record.createdAt, record.updatedAt);

    return record;
  }

  appendEvent(conversationId: string, event: ConnectorEvent): NormalizedEvent {
    return this.immediateTransaction(() => {
      const nextSequenceRow = this.getRow<{ sequence: number }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
         FROM events
         WHERE conversation_id = ?`,
        conversationId,
      );
      if (!nextSequenceRow) {
        throw new Error("Failed to allocate event sequence");
      }

      const now = isoNow();
      const normalized: NormalizedEvent = {
        id: randomUUID(),
        conversationId,
        sequence: nextSequenceRow.sequence,
        type: event.type,
        payload: event.payload,
        createdAt: now,
      };

      this.db
        .prepare(
          `INSERT INTO events (
            id, conversation_id, sequence, type, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          normalized.id,
          normalized.conversationId,
          normalized.sequence,
          normalized.type,
          JSON.stringify(normalized.payload),
          normalized.createdAt,
        );

      return normalized;
    });
  }

  eventsAfter(conversationId: string, sequence: number): NormalizedEvent[] {
    const rows = this.getRows<DbEventRow>(
      `SELECT id, conversation_id, sequence, type, payload_json, created_at
       FROM events
       WHERE conversation_id = ? AND sequence > ?
       ORDER BY sequence ASC`,
      conversationId,
      sequence,
    );

    return rows.map(mapEvent);
  }

  private immediateTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private getRow<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private getRows<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  private getTurnByWhere(
    where: string,
    params: SQLInputValue[],
    orderBy = "",
  ): Turn | null {
    const row = this.getRow<DbTurnRow>(
      `${TURN_SELECT}
       WHERE ${where}
       ${orderBy ? `ORDER BY ${orderBy}` : ""}
       LIMIT 1`,
      ...params,
    );
    return row ? mapTurn(row) : null;
  }
}

const TURN_SELECT = `SELECT
  t.id,
  t.conversation_id,
  t.status,
  t.message_id,
  t.native_turn_id,
  t.created_at,
  t.updated_at,
  ts.model_id,
  ts.permission_mode,
  ts.plugin_versions_json
FROM turns t
JOIN turn_snapshots ts ON ts.turn_id = t.id`;

function isoNow(): string {
  return new Date().toISOString();
}

interface DbProjectRow {
  id: string;
  path: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface DbConversationRow {
  id: string;
  project_id: string;
  agent_product_id: Conversation["agentProductId"];
  model_id: string | null;
  permission_mode: Conversation["permissionMode"];
  queue_paused: number;
  created_at: string;
  updated_at: string;
}

interface DbQueuedMessageRow {
  id: string;
  conversation_id: string;
  content: string;
  created_at: string;
}

interface DbTurnRow {
  id: string;
  conversation_id: string;
  status: Turn["status"];
  message_id: string;
  native_turn_id: string | null;
  created_at: string;
  updated_at: string;
  model_id: string | null;
  permission_mode: TurnSnapshot["permissionMode"];
  plugin_versions_json: string;
}

interface DbNativeSessionRow {
  id: string;
  conversation_id: string;
  native_session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface DbEventRow {
  id: string;
  conversation_id: string;
  sequence: number;
  type: NormalizedEvent["type"];
  payload_json: string;
  created_at: string;
}

function mapProject(row: DbProjectRow): Project {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversation(row: DbConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    agentProductId: row.agent_product_id,
    modelId: row.model_id,
    permissionMode: row.permission_mode,
    queuePaused: row.queue_paused === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapQueuedMessage(row: DbQueuedMessageRow): QueuedMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    content: row.content,
    createdAt: row.created_at,
  };
}

function mapTurn(row: DbTurnRow): Turn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    messageId: row.message_id,
    nativeTurnId: row.native_turn_id,
    snapshot: {
      modelId: row.model_id,
      permissionMode: row.permission_mode,
      pluginVersions: JSON.parse(row.plugin_versions_json) as TurnSnapshot["pluginVersions"],
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNativeSession(row: DbNativeSessionRow): NativeSessionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    nativeSessionId: row.native_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: DbEventRow): NormalizedEvent {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    type: row.type,
    payload: JSON.parse(row.payload_json) as NormalizedEvent["payload"],
    createdAt: row.created_at,
  };
}
