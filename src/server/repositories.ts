import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type {
  AgentProductId,
  ConnectorEvent,
  Conversation,
  ConversationSettingsInput,
  CreateConversationInput,
  NativeSessionRecord,
  NormalizedError,
  NormalizedEvent,
  Project,
  PluginVersion,
  QueuedMessage,
  TerminalTurnStatus,
  Turn,
  TurnSnapshot,
} from "../shared/contracts.js";

export interface Repositories {
  createProject(path: string, name: string): Project;
  listProjects(archived?: boolean): Project[];
  renameProject(projectId: string, name: string): "updated" | "not_found";
  archiveProject(projectId: string, archived: boolean): "updated" | "not_found" | "turn_active";
  deleteArchivedProject(projectId: string): "deleted" | "not_found" | "not_archived" | "turn_active";
  getProject(projectId: string): Project | null;
  getProjectByPath(path: string): Project | null;
  createConversation(input: CreateConversationInput): Conversation;
  listConversations(projectId: string, archived?: boolean): Conversation[];
  renameConversation(conversationId: string, title: string): "updated" | "not_found";
  archiveConversation(conversationId: string, archived: boolean): "updated" | "not_found" | "turn_active";
  deleteArchivedConversation(conversationId: string): "deleted" | "not_found" | "not_archived" | "turn_active";
  forkConversation(conversationId: string): Conversation | null;
  getConversation(conversationId: string): Conversation | null;
  getAgentExecutablePaths(): Partial<Record<AgentProductId, string>>;
  setAgentExecutablePath(agentProductId: AgentProductId, executablePath: string | null): void;
  isAgentEnabled(agentProductId: AgentProductId): boolean;
  setAgentEnabled(agentProductId: AgentProductId, enabled: boolean): void;
  hasActiveTurnForAgent(agentProductId: AgentProductId): boolean;
  updateConversationSettings(
    conversationId: string,
    settings: ConversationSettingsInput,
  ): "updated" | "not_found" | "turn_active";
  setPluginEnablements(scope: PluginScope, plugins: PluginVersion[]): "updated";
  listPluginEnablements(scope: PluginScope): PluginVersion[];
  isPluginScopeConfigured(scope: PluginScope): boolean;
  resolvePluginVersions(projectId: string, conversationId: string): PluginVersion[];
  setConversationQueuePaused(conversationId: string, queuePaused: boolean): void;
  recordQueueDispatchFailure(conversationId: string, error: NormalizedError): void;
  enqueueMessage(conversationId: string, content: string): QueuedMessage;
  stageMessage(conversationId: string, messageId: string, deliveryId: string): QueuedMessage | null;
  rollbackStagedMessage(conversationId: string, messageId: string, deliveryId: string): boolean;
  acknowledgeMessageDelivery(conversationId: string, messageId: string, deliveryId: string, snapshot: TurnSnapshot): { turnId: string; alreadyAcknowledged: boolean } | null;
  completeActiveTurnAtSafePoint(conversationId: string): string | null;
  markStagedMessagesUncertain(): number;
  markConversationStagedMessageUncertain(conversationId: string): boolean;
  resolveUncertainMessage(
    conversationId: string,
    messageId: string,
    action: "retry" | "accept",
  ): boolean;
  consumePendingMessage(conversationId: string, messageId: string): boolean;
  enqueueInterruptedTurnRetry(
    conversationId: string,
    turnId: string,
  ): { message: QueuedMessage; created: boolean } | null;
  listQueuedMessages(conversationId: string): QueuedMessage[];
  deletePendingMessage(
    conversationId: string,
    messageId: string,
  ): "deleted" | "not_found" | "not_pending";
  claimNextMessage(
    conversationId: string,
    snapshot: TurnSnapshot,
  ): { message: QueuedMessage; turn: Turn } | null;
  markTurnRunning(turnId: string, nativeTurnId: string | null): boolean;
  markTurnCancelling(turnId: string): boolean;
  finishTurn(turnId: string, status: TerminalTurnStatus, error?: NormalizedError): void;
  commitTerminalTurn(input: {
    conversationId: string;
    turnId: string;
    status: TerminalTurnStatus;
    error?: NormalizedError;
    requeueMessage?: boolean;
  }): "committed" | "already_committed" | "stale";
  requeueClaimedMessage(turnId: string): void;
  getActiveTurn(conversationId: string): Turn | null;
  getLatestTurn(conversationId: string): Turn | null;
  getTurn(turnId: string): Turn | null;
  listConversationIdsWithActiveTurns(): string[];
  interruptActiveTurns(): number;
  getNativeSession(conversationId: string): NativeSessionRecord | null;
  upsertNativeSession(conversationId: string, nativeSessionId: string | null): NativeSessionRecord;
  appendEvent(conversationId: string, event: ConnectorEvent): NormalizedEvent;
  eventsAfter(conversationId: string, sequence: number, limit?: number): NormalizedEvent[];
}

export type PluginScope =
  | { type: "global" }
  | { type: "project"; id: string }
  | { type: "conversation"; id: string };

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
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO projects (id, path, name, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(project.id, project.path, project.name, project.createdAt, project.updatedAt);

    return project;
  }

  listProjects(archived = false): Project[] {
    const rows = this.getRows<DbProjectRow>(
      `SELECT id, path, name, archived_at, created_at, updated_at
       FROM projects
       WHERE archived_at IS ${archived ? "NOT " : ""}NULL
       ORDER BY updated_at DESC, rowid DESC`,
    );
    return rows.map(mapProject);
  }

  getProject(projectId: string): Project | null {
    const row = this.getRow<DbProjectRow>(
      `SELECT id, path, name, archived_at, created_at, updated_at
       FROM projects
       WHERE id = ?`,
      projectId,
    );

    return row ? mapProject(row) : null;
  }

  getProjectByPath(path: string): Project | null {
    const row = this.getRow<DbProjectRow>(
      `SELECT id, path, name, archived_at, created_at, updated_at
       FROM projects
       WHERE path = ?`,
      path,
    );
    return row ? mapProject(row) : null;
  }

  renameProject(projectId: string, name: string): "updated" | "not_found" {
    return this.updateNamedRecord("projects", projectId, "name", name);
  }

  archiveProject(projectId: string, archived: boolean): "updated" | "not_found" | "turn_active" {
    if (archived && this.listProjectConversationIds(projectId).some((id) => this.getActiveTurn(id))) {
      return "turn_active";
    }
    return this.updateArchive("projects", projectId, archived);
  }

  deleteArchivedProject(projectId: string): "deleted" | "not_found" | "not_archived" | "turn_active" {
    return this.immediateTransaction(() => {
      const project = this.getProject(projectId);
      if (!project) return "not_found";
      if (!project.archivedAt) return "not_archived";
      const conversationIds = this.listProjectConversationIds(projectId);
      if (conversationIds.some((id) => this.getActiveTurn(id))) return "turn_active";
      this.deletePluginScopes("conversation", conversationIds);
      this.deletePluginScopes("project", [projectId]);
      if (conversationIds.length > 0) {
        const placeholders = conversationIds.map(() => "?").join(", " );
        this.db.prepare(`DELETE FROM turns WHERE conversation_id IN (${placeholders})`).run(...conversationIds);
      }
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
      return "deleted";
    });
  }

  createConversation(input: CreateConversationInput): Conversation {
    const now = isoNow();
    const conversation: Conversation = {
      id: randomUUID(),
      projectId: input.projectId,
      title: null,
      agentProductId: input.agentProductId,
      modelId: input.modelId,
      permissionMode: input.permissionMode ?? "request_approval",
      queuePaused: false,
      autoQueue: input.agentProductId === "trae" && input.autoQueue === true,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO conversations (
            id, project_id, agent_product_id, model_id, permission_mode,
            queue_paused, auto_queue, title, archived_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        conversation.id,
        conversation.projectId,
        conversation.agentProductId,
        conversation.modelId,
        conversation.permissionMode,
        conversation.queuePaused ? 1 : 0,
        conversation.autoQueue ? 1 : 0,
        conversation.createdAt,
        conversation.updatedAt,
      );

    return conversation;
  }

  listConversations(projectId: string, archived = false): Conversation[] {
    const rows = this.getRows<DbConversationRow>(
      `SELECT
         id,
         project_id,
         agent_product_id,
         model_id,
         permission_mode,
         queue_paused,
         auto_queue,
         title,
         archived_at,
         created_at,
         updated_at
       FROM conversations
       WHERE project_id = ? AND archived_at IS ${archived ? "NOT " : ""}NULL
       ORDER BY updated_at DESC, rowid DESC`,
      projectId,
    );

    return rows.map(mapConversation);
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
         auto_queue,
         title,
         archived_at,
         created_at,
         updated_at
       FROM conversations
       WHERE id = ?`,
      conversationId,
    );

    return row ? mapConversation(row) : null;
  }

  renameConversation(conversationId: string, title: string): "updated" | "not_found" {
    return this.updateNamedRecord("conversations", conversationId, "title", title);
  }

  archiveConversation(conversationId: string, archived: boolean): "updated" | "not_found" | "turn_active" {
    if (archived && this.getActiveTurn(conversationId)) return "turn_active";
    return this.updateArchive("conversations", conversationId, archived);
  }

  deleteArchivedConversation(conversationId: string): "deleted" | "not_found" | "not_archived" | "turn_active" {
    return this.immediateTransaction(() => {
      const conversation = this.getConversation(conversationId);
      if (!conversation) return "not_found";
      if (!conversation.archivedAt) return "not_archived";
      if (this.getActiveTurn(conversationId)) return "turn_active";
      this.db.prepare("DELETE FROM plugin_enablements WHERE scope_type = 'conversation' AND scope_id = ?").run(conversationId);
      this.db.prepare("DELETE FROM plugin_enablement_scopes WHERE scope_type = 'conversation' AND scope_id = ?").run(conversationId);
      this.db.prepare("DELETE FROM turns WHERE conversation_id = ?").run(conversationId);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
      return "deleted";
    });
  }

  forkConversation(conversationId: string): Conversation | null {
    return this.immediateTransaction(() => {
      const source = this.getConversation(conversationId);
      if (!source) return null;
      const fork = this.createConversation({
        projectId: source.projectId, agentProductId: source.agentProductId,
        modelId: source.modelId, permissionMode: source.permissionMode, autoQueue: source.autoQueue,
      });
      this.renameConversation(fork.id, `${source.title ?? "Conversation"} (branch)`);
      const pendingMessages = new Set(this.listQueuedMessages(source.id).map((message) => message.id));
      const events = this.eventsAfter(source.id, 0).filter((event) =>
        event.type !== "user_message" || !pendingMessages.has(String(event.payload.messageId)),
      );
      for (const event of events) {
        this.insertEvent(fork.id, { type: event.type, payload: event.payload }, event.createdAt);
      }
      const sourceScope = { type: "conversation", id: source.id } as const;
      if (this.isPluginScopeConfigured(sourceScope)) {
        const forkScope = { type: "conversation", id: fork.id } as const;
        this.replacePluginEnablements(forkScope, this.listPluginEnablements(sourceScope));
        this.db.prepare(
          `INSERT INTO plugin_enablement_scopes (scope_type, scope_id, updated_at) VALUES (?, ?, ?)`,
        ).run(forkScope.type, forkScope.id, isoNow());
      }
      return this.getConversation(fork.id);
    });
  }

  getAgentExecutablePaths(): Partial<Record<AgentProductId, string>> {
    const rows = this.getRows<{ agent_product_id: AgentProductId; executable_path: string }>(
      "SELECT agent_product_id, executable_path FROM agent_installations ORDER BY agent_product_id",
    );
    return Object.fromEntries(
      rows.map((row) => [row.agent_product_id, row.executable_path]),
    ) as Partial<Record<AgentProductId, string>>;
  }

  setAgentExecutablePath(agentProductId: AgentProductId, executablePath: string | null): void {
    if (executablePath === null) {
      this.db
        .prepare("DELETE FROM agent_installations WHERE agent_product_id = ?")
        .run(agentProductId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO agent_installations (agent_product_id, executable_path, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(agent_product_id) DO UPDATE SET
           executable_path = excluded.executable_path,
           updated_at = excluded.updated_at`,
      )
      .run(agentProductId, executablePath, isoNow());
  }

  isAgentEnabled(agentProductId: AgentProductId): boolean {
    const row = this.getRow<{ enabled: number }>(
      "SELECT enabled FROM agent_settings WHERE agent_product_id = ?",
      agentProductId,
    );
    return row?.enabled !== 0;
  }

  setAgentEnabled(agentProductId: AgentProductId, enabled: boolean): void {
    this.db.prepare(
      `INSERT INTO agent_settings (agent_product_id, enabled, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(agent_product_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    ).run(agentProductId, enabled ? 1 : 0, isoNow());
  }

  hasActiveTurnForAgent(agentProductId: AgentProductId): boolean {
    return Boolean(this.getRow(
      `SELECT t.id
       FROM turns t
       JOIN conversations c ON c.id = t.conversation_id
       WHERE c.agent_product_id = ?
         AND t.status IN ('starting', 'running', 'cancelling')
       LIMIT 1`,
      agentProductId,
    ));
  }

  updateConversationSettings(
    conversationId: string,
    settings: ConversationSettingsInput,
  ): "updated" | "not_found" | "turn_active" {
    return this.immediateTransaction(() => {
      const conversation = this.getConversation(conversationId);
      if (!conversation) {
        return "not_found";
      }
      if (this.getActiveTurn(conversationId)) {
        return "turn_active";
      }

      this.db
        .prepare(
          `UPDATE conversations
           SET model_id = ?, permission_mode = ?, auto_queue = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          settings.modelId,
          settings.permissionMode,
          conversation.agentProductId === "trae" && (settings.autoQueue ?? conversation.autoQueue) ? 1 : 0,
          isoNow(),
          conversationId,
        );
      return "updated";
    });
  }

  setPluginEnablements(scope: PluginScope, plugins: PluginVersion[]): "updated" {
    return this.immediateTransaction(() => {
      this.replacePluginEnablements(scope, plugins);
      this.db
        .prepare(
          `INSERT INTO plugin_enablement_scopes (scope_type, scope_id, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(scope_type, scope_id) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(scope.type, pluginScopeKey(scope), isoNow());
      return "updated";
    });
  }

  listPluginEnablements(scope: PluginScope): PluginVersion[] {
    return this.getRows<{ plugin_id: string; version_id: string }>(
      `SELECT plugin_id, version_id
       FROM plugin_enablements
       WHERE scope_type = ? AND scope_id = ?
       ORDER BY plugin_id`,
      scope.type,
      pluginScopeKey(scope),
    ).map((row) => ({ pluginId: row.plugin_id, versionId: row.version_id }));
  }

  resolvePluginVersions(projectId: string, conversationId: string): PluginVersion[] {
    const resolved = new Map<string, PluginVersion>();
    for (const scope of [
      { type: "global" } as const,
      { type: "project", id: projectId } as const,
      { type: "conversation", id: conversationId } as const,
    ]) {
      const key = pluginScopeKey(scope);
      if (scope.type !== "global" && this.isPluginScopeConfigured(scope)) {
        resolved.clear();
      }
      const rows = this.getRows<{ plugin_id: string; version_id: string }>(
        `SELECT plugin_id, version_id
         FROM plugin_enablements
         WHERE scope_type = ? AND scope_id = ?
         ORDER BY plugin_id`,
        scope.type,
        key,
      );
      for (const row of rows) {
        resolved.set(row.plugin_id, {
          pluginId: row.plugin_id,
          versionId: row.version_id,
        });
      }
    }
    return [...resolved.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
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

  recordQueueDispatchFailure(conversationId: string, error: NormalizedError): void {
    this.immediateTransaction(() => {
      this.db
        .prepare(
          `UPDATE conversations
           SET queue_paused = 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(isoNow(), conversationId);
      this.insertEvent(conversationId, {
        type: "warning",
        payload: { code: "queue_dispatch_failed", message: error.message },
      });
    });
  }

  enqueueMessage(conversationId: string, content: string): QueuedMessage {
    return this.immediateTransaction(() => {
      this.db.prepare(
        `UPDATE conversations SET title = COALESCE(title, ?), updated_at = ? WHERE id = ?`,
      ).run(compactTitle(content), isoNow(), conversationId);
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
        status: "pending",
        deliveryId: null,
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
      this.insertEvent(conversationId, {
        type: "user_message", payload: { text: content, role: "user", messageId: message.id },
      });
      return message;
    });
  }

  stageMessage(conversationId: string, messageId: string, deliveryId: string): QueuedMessage | null {
    return this.immediateTransaction(() => {
      const occupied = this.getRow<{ id: string }>(
        "SELECT id FROM queued_messages WHERE conversation_id = ? AND status = 'staged' AND id <> ? LIMIT 1",
        conversationId, messageId,
      );
      if (occupied) return null;
      const existing = this.getRow<DbQueuedMessageRow>(
        `SELECT id, conversation_id, content, status, delivery_id, created_at
         FROM queued_messages WHERE conversation_id = ? AND id = ?`,
        conversationId, messageId,
      );
      if (!existing) return null;
      const head = this.getRow<{ id: string }>(
        `SELECT id FROM queued_messages WHERE conversation_id = ? AND status = 'pending' ORDER BY enqueue_seq ASC LIMIT 1`,
        conversationId,
      );
      if (existing.status === "pending" && head?.id !== messageId) return null;
      if (existing.status === "staged" && existing.delivery_id === deliveryId) return mapQueuedMessage(existing);
      if (existing.status !== "pending") return null;
      const result = this.db.prepare(
        `UPDATE queued_messages SET status = 'staged', delivery_id = ?, updated_at = ?
         WHERE conversation_id = ? AND id = ? AND status = 'pending'`,
      ).run(deliveryId, isoNow(), conversationId, messageId) as { changes: number };
      return result.changes > 0 ? { ...mapQueuedMessage(existing), status: "staged", deliveryId } : null;
    });
  }

  rollbackStagedMessage(conversationId: string, messageId: string, deliveryId: string): boolean {
    return (this.db.prepare(
      `UPDATE queued_messages SET status = 'pending', delivery_id = NULL, updated_at = ?
       WHERE conversation_id = ? AND id = ? AND status = 'staged' AND delivery_id = ?`,
    ).run(isoNow(), conversationId, messageId, deliveryId) as { changes: number }).changes > 0;
  }

  acknowledgeMessageDelivery(conversationId: string, messageId: string, deliveryId: string, snapshot: TurnSnapshot): { turnId: string; alreadyAcknowledged: boolean } | null {
    return this.immediateTransaction(() => {
      const row = this.getRow<DbQueuedMessageRow>(
        `SELECT id, conversation_id, content, status, delivery_id, created_at
         FROM queued_messages WHERE conversation_id = ? AND id = ? AND delivery_id = ?`,
        conversationId, messageId, deliveryId,
      );
      if (!row || (row.status !== "staged" && row.status !== "consumed")) return null;
      const alreadyAcknowledged = row.status === "consumed";
      const existingTurn = this.getRow<{ id: string }>("SELECT id FROM turns WHERE message_id = ? LIMIT 1", messageId);
      const turnId = existingTurn?.id ?? randomUUID();
      if (!alreadyAcknowledged) {
        const now = isoNow();
        const previous = this.getRow<{ id: string }>(
          "SELECT id FROM turns WHERE conversation_id = ? AND status IN ('starting', 'running') ORDER BY updated_at DESC LIMIT 1", conversationId,
        );
        if (previous) {
          this.db.prepare("UPDATE turns SET status = 'completed', updated_at = ? WHERE id = ?").run(now, previous.id);
          this.insertEvent(conversationId, { type: "turn_status", payload: { turnId: previous.id, status: "completed" } });
        }
        if (!existingTurn) {
          this.db.prepare("INSERT INTO turns (id, conversation_id, status, message_id, native_turn_id, error_json, created_at, updated_at) VALUES (?, ?, 'running', ?, NULL, NULL, ?, ?)")
            .run(turnId, conversationId, messageId, now, now);
          this.db.prepare("INSERT INTO turn_snapshots (turn_id, model_id, permission_mode, plugin_versions_json, auto_queue) VALUES (?, ?, ?, ?, ?)")
            .run(turnId, snapshot.modelId, snapshot.permissionMode, JSON.stringify(snapshot.pluginVersions), snapshot.autoQueue ? 1 : 0);
        }
        this.db.prepare("UPDATE queued_messages SET status = 'consumed', updated_at = ? WHERE id = ? AND status = 'staged'")
          .run(now, messageId);
        this.insertUserMessageOnce(conversationId, row);
        this.insertEvent(conversationId, { type: "turn_status", payload: { turnId, status: "running" } });
      }
      return { turnId, alreadyAcknowledged };
    });
  }

  completeActiveTurnAtSafePoint(conversationId: string): string | null {
    return this.immediateTransaction(() => {
      const active = this.getRow<{ id: string }>(
        "SELECT id FROM turns WHERE conversation_id = ? AND status IN ('starting', 'running') ORDER BY updated_at DESC LIMIT 1", conversationId,
      );
      if (!active) return null;
      const now = isoNow();
      this.db.prepare("UPDATE turns SET status = 'completed', updated_at = ? WHERE id = ?").run(now, active.id);
      this.db.prepare("UPDATE conversations SET queue_paused = 0, updated_at = ? WHERE id = ?").run(now, conversationId);
      this.insertEvent(conversationId, { type: "turn_status", payload: { turnId: active.id, status: "completed" } });
      return active.id;
    });
  }

  markStagedMessagesUncertain(): number {
    return (this.db.prepare("UPDATE queued_messages SET status = 'uncertain', updated_at = ? WHERE status = 'staged'")
      .run(isoNow()) as { changes: number }).changes;
  }

  markConversationStagedMessageUncertain(conversationId: string): boolean {
    return this.immediateTransaction(() => {
      const now = isoNow();
      const result = this.db.prepare(
        `UPDATE queued_messages SET status = 'uncertain', updated_at = ?
         WHERE conversation_id = ? AND status = 'staged'`,
      ).run(now, conversationId) as { changes: number };
      if (result.changes > 0) {
        this.db.prepare("UPDATE conversations SET queue_paused = 1, updated_at = ? WHERE id = ?")
          .run(now, conversationId);
      }
      return result.changes > 0;
    });
  }

  resolveUncertainMessage(
    conversationId: string,
    messageId: string,
    action: "retry" | "accept",
  ): boolean {
    return this.immediateTransaction(() => {
      const message = this.getRow<DbQueuedMessageRow>(
        `SELECT id, conversation_id, content, status, delivery_id, created_at
         FROM queued_messages WHERE conversation_id = ? AND id = ? AND status = 'uncertain'`,
        conversationId, messageId,
      );
      if (!message) return false;
      const now = isoNow();
      if (action === "retry") {
        this.db.prepare(
          "UPDATE queued_messages SET status = 'pending', delivery_id = NULL, updated_at = ? WHERE id = ?",
        ).run(now, messageId);
      } else {
        this.db.prepare(
          "UPDATE queued_messages SET status = 'consumed', updated_at = ? WHERE id = ?",
        ).run(now, messageId);
        this.insertUserMessageOnce(conversationId, message);
      }
      this.db.prepare("UPDATE conversations SET queue_paused = 0, updated_at = ? WHERE id = ?")
        .run(now, conversationId);
      return true;
    });
  }

  consumePendingMessage(conversationId: string, messageId: string): boolean {
    const result = this.db.prepare(
      `UPDATE queued_messages SET status = 'consumed', updated_at = ?
       WHERE conversation_id = ? AND id = ? AND status = 'pending'`,
    ).run(isoNow(), conversationId, messageId) as { changes: number };
    return result.changes > 0;
  }

  enqueueInterruptedTurnRetry(
    conversationId: string,
    turnId: string,
  ): { message: QueuedMessage; created: boolean } | null {
    return this.immediateTransaction(() => {
      const latestTurn = this.getRow<{ id: string; status: Turn["status"] }>(
        `SELECT id, status
         FROM turns
         WHERE conversation_id = ?
         ORDER BY updated_at DESC, rowid DESC
         LIMIT 1`,
        conversationId,
      );
      if (latestTurn?.id !== turnId || latestTurn.status !== "interrupted") {
        return null;
      }

      const existing = this.getRow<DbQueuedMessageRow & { status: string }>(
        `SELECT id, conversation_id, content, status, created_at
         FROM queued_messages
         WHERE retry_of_turn_id = ?`,
        turnId,
      );
      if (existing) {
        if (existing.conversation_id !== conversationId || existing.status !== "pending") {
          return null;
        }
        return { message: mapQueuedMessage(existing), created: false };
      }

      const source = this.getRow<{ content: string }>(
        `SELECT q.content
         FROM turns t
         JOIN queued_messages q ON q.id = t.message_id
         WHERE t.id = ? AND t.conversation_id = ? AND t.status = 'interrupted'`,
        turnId,
        conversationId,
      );
      if (!source) {
        return null;
      }

      const firstSequence = this.getRow<{ enqueue_seq: number }>(
        `SELECT COALESCE(MIN(enqueue_seq), 1) - 1 AS enqueue_seq
         FROM queued_messages
         WHERE conversation_id = ?`,
        conversationId,
      );
      if (!firstSequence) {
        throw new Error("Failed to allocate retry message sequence");
      }

      const now = isoNow();
      const message: QueuedMessage = {
        id: randomUUID(),
        conversationId,
        content: source.content,
        status: "pending",
        deliveryId: null,
        createdAt: now,
      };
      this.db
        .prepare(
          `INSERT INTO queued_messages (
            id, conversation_id, enqueue_seq, content, status, claimed_turn_id,
            retry_of_turn_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
        )
        .run(
          message.id,
          conversationId,
          firstSequence.enqueue_seq,
          message.content,
          turnId,
          now,
          now,
        );
      return { message, created: true };
    });
  }

  listQueuedMessages(conversationId: string): QueuedMessage[] {
    const rows = this.getRows<DbQueuedMessageRow>(
      `SELECT id, conversation_id, content, status, delivery_id, created_at
       FROM queued_messages
       WHERE conversation_id = ? AND status IN ('pending', 'staged', 'uncertain')
       ORDER BY enqueue_seq ASC`,
      conversationId,
    );

    return rows.map(mapQueuedMessage);
  }

  deletePendingMessage(
    conversationId: string,
    messageId: string,
  ): "deleted" | "not_found" | "not_pending" {
    const result = this.db
      .prepare(
        `DELETE FROM queued_messages
         WHERE conversation_id = ? AND id = ? AND status = 'pending'`,
      )
      .run(conversationId, messageId) as { changes: number };

    if (result.changes > 0) {
      return "deleted";
    }

    const existing = this.getRow<{ status: string }>(
      `SELECT status
       FROM queued_messages
       WHERE conversation_id = ? AND id = ?`,
      conversationId,
      messageId,
    );

    if (!existing) {
      return "not_found";
    }

    return "not_pending";
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
        `SELECT id, conversation_id, content, status, delivery_id, created_at
         FROM queued_messages
         WHERE conversation_id = ? AND status IN ('pending', 'staged', 'uncertain')
         ORDER BY enqueue_seq ASC
         LIMIT 1`,
        conversationId,
      );

      if (!row) {
        return null;
      }
      if (row.status !== "pending") {
        this.db.prepare("UPDATE conversations SET queue_paused = 1, updated_at = ? WHERE id = ?")
          .run(isoNow(), conversationId);
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
            turn_id, model_id, permission_mode, plugin_versions_json, auto_queue
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(turn.id, snapshot.modelId, snapshot.permissionMode, JSON.stringify(snapshot.pluginVersions), snapshot.autoQueue ? 1 : 0);

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

  markTurnRunning(turnId: string, nativeTurnId: string | null): boolean {
    return this.immediateTransaction(() => {
      const now = isoNow();
      const result = this.db
        .prepare(
          `UPDATE turns
           SET status = 'running', native_turn_id = ?, updated_at = ?
           WHERE id = ? AND status = 'starting'`,
        )
        .run(nativeTurnId, now, turnId);

      if (result.changes === 0) {
        return false;
      }

      this.db
        .prepare(
          `UPDATE queued_messages
           SET status = 'consumed', updated_at = ?
           WHERE id = (SELECT message_id FROM turns WHERE id = ?)`,
        )
        .run(now, turnId);
      const message = this.getRow<DbQueuedMessageRow>(
        `SELECT id, conversation_id, content, status, delivery_id, created_at
         FROM queued_messages WHERE id = (SELECT message_id FROM turns WHERE id = ?)`,
        turnId,
      );
      if (message) this.insertUserMessageOnce(message.conversation_id, message);
      return true;
    });
  }

  markTurnCancelling(turnId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE turns
         SET status = 'cancelling', updated_at = ?
         WHERE id = ? AND status IN ('starting', 'running')`,
      )
      .run(isoNow(), turnId) as { changes: number };
    return result.changes > 0;
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

  commitTerminalTurn(input: {
    conversationId: string;
    turnId: string;
    status: TerminalTurnStatus;
    error?: NormalizedError;
    requeueMessage?: boolean;
  }): "committed" | "already_committed" | "stale" {
    return this.immediateTransaction(() => {
      const turn = this.getRow<{ conversation_id: string; status: Turn["status"] }>(
        "SELECT conversation_id, status FROM turns WHERE id = ?",
        input.turnId,
      );
      if (!turn || turn.conversation_id !== input.conversationId) {
        return "stale";
      }

      const alreadyCommitted = turn.status === input.status;
      if (
        !alreadyCommitted &&
        turn.status !== "starting" &&
        turn.status !== "running" &&
        turn.status !== "cancelling"
      ) {
        return "stale";
      }

      const now = isoNow();
      if (!alreadyCommitted) {
        this.db
          .prepare(
            `UPDATE turns
             SET status = ?, error_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.status,
            input.error ? JSON.stringify(input.error) : null,
            now,
            input.turnId,
          );
      }
      if (input.status === "completed" || input.status === "cancelled") {
        this.db
          .prepare(
            `UPDATE queued_messages
             SET status = 'consumed', updated_at = ?
             WHERE claimed_turn_id = ? AND status = 'claimed'`,
          )
          .run(now, input.turnId);
      }
      if (input.requeueMessage) {
        this.db
          .prepare(
            `UPDATE queued_messages
             SET status = 'pending', claimed_turn_id = NULL, updated_at = ?
             WHERE claimed_turn_id = ?`,
          )
          .run(now, input.turnId);
      }
      this.db
        .prepare(
          `UPDATE conversations
           SET queue_paused = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.status === "completed" || input.status === "cancelled" ? 0 : 1,
          now,
          input.conversationId,
        );
      return alreadyCommitted ? "already_committed" : "committed";
    });
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
    return this.immediateTransaction(() => {
      const now = isoNow();
      this.db.prepare(
        "UPDATE queued_messages SET status = 'uncertain', updated_at = ? WHERE status = 'staged'",
      ).run(now);
      const active = this.db.prepare(
        `SELECT t.id, t.conversation_id, c.agent_product_id, c.auto_queue,
                (SELECT e.payload_json FROM events e
                 WHERE e.conversation_id = t.conversation_id AND e.type = 'queue_status'
                 ORDER BY e.sequence DESC LIMIT 1) AS queue_payload
         FROM turns t JOIN conversations c ON c.id = t.conversation_id
         WHERE t.status IN ('starting', 'running', 'cancelling')`,
      ).all() as Array<{ id: string; conversation_id: string; agent_product_id: string; auto_queue: number; queue_payload: string | null }>;
      const waiting = active.filter((turn) => {
        if (turn.agent_product_id !== "trae" || turn.auto_queue !== 1 || !turn.queue_payload) return false;
        try {
          const payload = JSON.parse(turn.queue_payload) as Record<string, unknown>;
          return payload.status === "waiting" && payload.hasPendingInput === false;
        } catch {
          return false;
        }
      });
      for (const turn of waiting) {
        this.db.prepare("UPDATE turns SET status = 'completed', updated_at = ? WHERE id = ?").run(now, turn.id);
        this.db.prepare("UPDATE conversations SET queue_paused = 0, updated_at = ? WHERE id = ?").run(now, turn.conversation_id);
        this.insertEvent(turn.conversation_id, { type: "turn_status", payload: { turnId: turn.id, status: "completed" } });
      }
      this.db.prepare(
        `UPDATE conversations SET queue_paused = 1, updated_at = ?
         WHERE id IN (SELECT conversation_id FROM queued_messages WHERE status = 'uncertain')`,
      ).run(now);
      this.db
        .prepare(
          `UPDATE conversations
           SET queue_paused = 1, updated_at = ?
           WHERE id IN (
             SELECT conversation_id
             FROM turns
             WHERE status IN ('starting', 'running', 'cancelling')
           )`,
        )
        .run(now);
      const result = this.db
        .prepare(
          `UPDATE turns
           SET status = 'interrupted', updated_at = ?
           WHERE status IN ('starting', 'running', 'cancelling')`,
        )
        .run(now) as { changes: number };
      return result.changes + waiting.length;
    });
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
    return this.immediateTransaction(() => this.insertEvent(conversationId, event));
  }

  eventsAfter(conversationId: string, sequence: number, limit?: number): NormalizedEvent[] {
    const boundedLimit = limit === undefined ? -1 : Math.max(1, Math.floor(limit));
    const rows = this.getRows<DbEventRow>(
      `SELECT id, conversation_id, sequence, type, payload_json, created_at
       FROM events
       WHERE conversation_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
      conversationId,
      sequence,
      boundedLimit,
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

  private insertUserMessageOnce(conversationId: string, message: DbQueuedMessageRow): void {
    const existing = this.getRow<{ id: string }>(
      `SELECT id FROM events WHERE conversation_id = ? AND type = 'user_message'
       AND json_extract(payload_json, '$.messageId') = ? LIMIT 1`,
      conversationId, message.id,
    );
    if (!existing) this.insertEvent(conversationId, {
      type: "user_message", payload: { text: message.content, role: "user", messageId: message.id },
    });
  }

  private updateNamedRecord(
    table: "projects" | "conversations",
    id: string,
    column: "name" | "title",
    value: string,
  ): "updated" | "not_found" {
    const result = this.db.prepare(
      `UPDATE ${table} SET ${column} = ?, updated_at = ? WHERE id = ?`,
    ).run(value.trim(), isoNow(), id) as { changes: number };
    return result.changes > 0 ? "updated" : "not_found";
  }

  private updateArchive(
    table: "projects" | "conversations",
    id: string,
    archived: boolean,
  ): "updated" | "not_found" {
    const now = isoNow();
    const result = this.db.prepare(
      `UPDATE ${table} SET archived_at = ?, updated_at = ? WHERE id = ?`,
    ).run(archived ? now : null, now, id) as { changes: number };
    return result.changes > 0 ? "updated" : "not_found";
  }

  private insertEvent(
    conversationId: string,
    event: ConnectorEvent,
    createdAt = isoNow(),
  ): NormalizedEvent {
    const nextSequenceRow = this.getRow<{ sequence: number }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
       FROM events
       WHERE conversation_id = ?`,
      conversationId,
    );
    if (!nextSequenceRow) {
      throw new Error("Failed to allocate event sequence");
    }

    const normalized: NormalizedEvent = {
      id: randomUUID(),
      conversationId,
      sequence: nextSequenceRow.sequence,
      type: event.type,
      payload: event.payload,
      createdAt,
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
  }

  private replacePluginEnablements(scope: PluginScope, plugins: PluginVersion[]): void {
    const scopeId = pluginScopeKey(scope);
    this.db
      .prepare("DELETE FROM plugin_enablements WHERE scope_type = ? AND scope_id = ?")
      .run(scope.type, scopeId);
    const insert = this.db.prepare(
      `INSERT INTO plugin_enablements (scope_type, scope_id, plugin_id, version_id, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const plugin of plugins) {
      insert.run(scope.type, scopeId, plugin.pluginId, plugin.versionId, isoNow());
    }
  }

  private listProjectConversationIds(projectId: string): string[] {
    return this.getRows<{ id: string }>(
      "SELECT id FROM conversations WHERE project_id = ?",
      projectId,
    ).map((row) => row.id);
  }

  private deletePluginScopes(scopeType: "project" | "conversation", scopeIds: string[]): void {
    const deleteEnablements = this.db.prepare(
      "DELETE FROM plugin_enablements WHERE scope_type = ? AND scope_id = ?",
    );
    const deleteScopes = this.db.prepare(
      "DELETE FROM plugin_enablement_scopes WHERE scope_type = ? AND scope_id = ?",
    );
    for (const scopeId of scopeIds) {
      deleteEnablements.run(scopeType, scopeId);
      deleteScopes.run(scopeType, scopeId);
    }
  }

  isPluginScopeConfigured(scope: PluginScope): boolean {
    return Boolean(this.getRow(
      `SELECT 1
       FROM plugin_enablement_scopes
       WHERE scope_type = ? AND scope_id = ?`,
      scope.type,
      pluginScopeKey(scope),
    ));
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
  ts.plugin_versions_json,
  ts.auto_queue
FROM turns t
JOIN turn_snapshots ts ON ts.turn_id = t.id`;

function isoNow(): string {
  return new Date().toISOString();
}

function pluginScopeKey(scope: PluginScope): string {
  return scope.type === "global" ? "global" : scope.id;
}

interface DbProjectRow {
  id: string;
  path: string;
  name: string;
  archived_at: string | null;
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
  auto_queue: number;
  title: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DbQueuedMessageRow {
  id: string;
  conversation_id: string;
  content: string;
  status: string;
  delivery_id: string | null;
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
  auto_queue: number;
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
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversation(row: DbConversationRow): Conversation {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    agentProductId: row.agent_product_id,
    modelId: row.model_id,
    permissionMode: row.permission_mode,
    queuePaused: row.queue_paused === 1,
    autoQueue: row.auto_queue === 1,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compactTitle(content: string): string {
  const title = content.trim().replace(/\s+/g, " ");
  const characters = Array.from(title);
  return characters.length > 60 ? `${characters.slice(0, 57).join("")}…` : title;
}

function mapQueuedMessage(row: DbQueuedMessageRow): QueuedMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    content: row.content,
    status: row.status === "staged" || row.status === "uncertain" ? row.status : "pending",
    deliveryId: row.delivery_id,
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
      ...(row.auto_queue === 1 ? { autoQueue: true } : {}),
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
