import { randomUUID } from "node:crypto";
import type {
  AgentConnector,
  AgentProductId,
  LiveSession,
  NormalizedError,
  PermissionDecision,
  PluginVersion,
  TerminalTurnStatus,
  TurnSnapshot,
} from "../shared/contracts.js";
import type { Repositories } from "./repositories.js";

interface TurnCoordinatorOptions {
  repositories: Repositories;
  connectors: Partial<Record<AgentProductId, AgentConnector>>;
  resolvePluginVersions?: (input: {
    projectId: string;
    conversationId: string;
    agentProductId: AgentProductId;
  }) => PluginVersion[];
  materializePlugins?: (input: {
    turnId: string;
    agentProductId: AgentProductId;
    projectPath: string;
    conversationId: string;
    plugins: PluginVersion[];
  }) => Promise<{ turnArtifactPath: string | null }>;
}

interface ConnectorWithCallbacks extends AgentConnector {
  setTurnCallbacks?: (callbacks: {
    onTerminal: (input: {
      conversationId: string;
      turnId: string;
      nativeTurnId: string | null;
      status: TerminalTurnStatus,
      error?: NormalizedError;
    }) => Promise<void>;
  }) => void;
}

interface PreparedTurn {
  conversationId: string;
  agentProductId: AgentProductId;
  projectPath: string;
  connector: AgentConnector;
  turnId: string;
  content: string;
  snapshot: TurnSnapshot;
  mcpConfigPath: string | null;
}

export class TurnCoordinator {
  private readonly repositories: Repositories;
  private readonly connectors: Partial<Record<AgentProductId, AgentConnector>>;
  private readonly resolvePluginVersions: NonNullable<TurnCoordinatorOptions["resolvePluginVersions"]>;
  private readonly materializePlugins?: TurnCoordinatorOptions["materializePlugins"];
  private readonly liveSessions = new Map<
    string,
    { connector: AgentConnector; session: LiveSession; ownerTurnId: string; reusableLease: boolean }
  >();
  private readonly agentPreparationQueues = new Map<AgentProductId, Promise<void>>();
  private readonly continuationQueues = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(options: TurnCoordinatorOptions) {
    this.repositories = options.repositories;
    this.connectors = options.connectors;
    this.resolvePluginVersions =
      options.resolvePluginVersions ??
      ((input) => this.repositories.resolvePluginVersions(input.projectId, input.conversationId));
    this.materializePlugins = options.materializePlugins;

    for (const connector of Object.values(this.connectors)) {
      this.bindConnector(connector);
    }
  }

  async setConnector(
    agentProductId: AgentProductId,
    connector: AgentConnector,
  ): Promise<"updated" | "turn_active"> {
    return this.withAgentPreparation(agentProductId, async () => {
      const previous = this.connectors[agentProductId];
      if (previous === connector) {
        return "updated";
      }
      if (this.repositories.hasActiveTurnForAgent(agentProductId)) {
        return "turn_active";
      }

      const sessions = [...this.liveSessions.entries()].filter(
        ([, value]) => value.connector === previous,
      );
      const results = await Promise.allSettled(
        sessions.map(([, value]) => value.connector.closeSession(value.session)),
      );
      for (let index = 0; index < sessions.length; index += 1) {
        if (results[index]?.status === "fulfilled") {
          this.liveSessions.delete(sessions[index]![0]);
        }
      }
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) {
        throw failed.reason;
      }

      this.connectors[agentProductId] = connector;
      this.bindConnector(connector);
      return "updated";
    });
  }

  async runBetweenTurns(
    agentProductId: AgentProductId,
    operation: () => Promise<void>,
  ): Promise<"updated" | "turn_active"> {
    return this.withAgentPreparation(agentProductId, async () => {
      if (this.repositories.hasActiveTurnForAgent(agentProductId)) {
        return "turn_active";
      }
      await operation();
      return "updated";
    });
  }

  async enqueueMessage(conversationId: string, content: string): Promise<void> {
    this.repositories.enqueueMessage(conversationId, content);
    await this.tryContinuePending(conversationId);
    const live = this.liveSessions.get(conversationId);
    if (this.repositories.getActiveTurn(conversationId) || live?.reusableLease) return;
    try {
      await this.dispatchNext(conversationId);
    } catch (error) {
      try {
        this.repositories.recordQueueDispatchFailure(conversationId, normalizeError(error));
      } catch {
        // The message is already durable; a later explicit action can resume dispatch.
      }
    }
  }

  async dispatchNext(conversationId: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    const initialConversation = this.repositories.getConversation(conversationId);
    if (!initialConversation) {
      return;
    }

    const prepared = await this.withAgentPreparation(
      initialConversation.agentProductId,
      () => this.prepareTurn(conversationId),
    );
    if (!prepared) {
      return;
    }

    await this.startPreparedTurn(prepared);
  }

  private async prepareTurn(conversationId: string): Promise<PreparedTurn | null> {
    const conversation = this.repositories.getConversation(conversationId);
    if (!conversation || conversation.queuePaused) {
      return null;
    }
    if (!this.repositories.isAgentEnabled(conversation.agentProductId)) {
      return null;
    }

    if (this.repositories.getActiveTurn(conversationId)) {
      return null;
    }

    const connector = this.connectors[conversation.agentProductId];
    if (!connector) {
      throw new Error(`No connector registered for ${conversation.agentProductId}`);
    }

    const project = this.repositories.getProject(conversation.projectId);
    if (!project) {
      throw new Error(`Project not found for conversation ${conversationId}`);
    }

    const pluginVersions = this.resolvePluginVersions({
      projectId: project.id,
      conversationId,
      agentProductId: conversation.agentProductId,
    });
    const snapshot: TurnSnapshot = {
      modelId: conversation.modelId,
      permissionMode: conversation.permissionMode,
      pluginVersions,
    };

    const activeTurns = this.listAgentConversations(conversation.agentProductId)
      .flatMap((item) => {
        const turn = this.repositories.getActiveTurn(item.id);
        return turn ? [turn] : [];
      });
    // ponytail: plugin-bearing Turns serialize per Agent; use isolated native roots for higher concurrency.
    if (
      activeTurns.length > 0 &&
      (pluginVersions.length > 0 || activeTurns.some((turn) => turn.snapshot.pluginVersions.length > 0))
    ) {
      return null;
    }

    const claimed = this.repositories.claimNextMessage(conversationId, snapshot);
    if (!claimed) {
      return null;
    }

    let mcpConfigPath: string | null = null;
    try {
      const materialized = await this.materializePlugins?.({
        turnId: claimed.turn.id,
        agentProductId: conversation.agentProductId,
        projectPath: project.path,
        conversationId,
        plugins: pluginVersions,
      });
      mcpConfigPath = materialized?.turnArtifactPath ?? null;
    } catch (error) {
      await this.commitTerminalWithRetry({
        conversationId,
        turnId: claimed.turn.id,
        status: "start_failed",
        error: normalizeError(error),
        requeueMessage: true,
      });
      return null;
    }

    return {
      conversationId,
      agentProductId: conversation.agentProductId,
      projectPath: project.path,
      connector,
      turnId: claimed.turn.id,
      content: claimed.message.content,
      snapshot,
      mcpConfigPath,
    };
  }

  private async startPreparedTurn(prepared: PreparedTurn): Promise<void> {
    let session: LiveSession;
    try {
      const existing = this.liveSessions.get(prepared.conversationId);
      if (existing?.connector === prepared.connector && existing.reusableLease) {
        session = existing.session;
        existing.ownerTurnId = prepared.turnId;
        existing.reusableLease = false;
      } else {
        const sessionRecord = this.repositories.getNativeSession(prepared.conversationId);
        session = await prepared.connector.createOrResumeSession({
          projectPath: prepared.projectPath,
          conversationId: prepared.conversationId,
          nativeSessionId: sessionRecord?.nativeSessionId ?? null,
          onEvent: async (event) => {
          this.repositories.appendEvent(prepared.conversationId, event);
          const currentLive = this.liveSessions.get(prepared.conversationId);
          if (event.type === "queue_status" && currentLive?.session === session) {
            currentLive.reusableLease = event.payload.status !== "inactive";
          }
          const acknowledged = readAcknowledgement(event.payload);
          if (event.type === "queue_status" && acknowledged) {
            const conversation = this.repositories.getConversation(prepared.conversationId);
            if (conversation) this.repositories.acknowledgeMessageDelivery(
              prepared.conversationId, acknowledged.messageId, acknowledged.deliveryId, {
                modelId: conversation.modelId, permissionMode: conversation.permissionMode,
                pluginVersions: this.resolvePluginVersions({ projectId: conversation.projectId, conversationId: conversation.id, agentProductId: conversation.agentProductId }),
                autoQueue: true,
              },
            );
          }
          if (event.type === "queue_status" && event.payload.status === "waiting" && event.payload.hasPendingInput === false) {
            this.repositories.completeActiveTurnAtSafePoint(prepared.conversationId);
          }
          if (
            event.type === "queue_status"
            && event.payload.acceptingInput === true
            && event.payload.hasPendingInput === false
          ) {
            await this.tryContinuePending(prepared.conversationId);
          }
          },
          onNativeSessionId: async (nativeSessionId) => {
            this.repositories.upsertNativeSession(prepared.conversationId, nativeSessionId);
          },
        });
        this.repositories.upsertNativeSession(prepared.conversationId, session.nativeSessionId);
        this.liveSessions.set(prepared.conversationId, {
          connector: prepared.connector, session, ownerTurnId: prepared.turnId, reusableLease: false,
        });
      }
    } catch (error) {
      const normalized = normalizeError(error);
      if (isDefinitePreStartFailure(error)) {
        await this.commitTerminalWithRetry({
          conversationId: prepared.conversationId,
          turnId: prepared.turnId,
          status: "start_failed",
          error: normalized,
          requeueMessage: true,
        });
      } else {
        await this.commitTerminalWithRetry({
          conversationId: prepared.conversationId,
          turnId: prepared.turnId,
          status: "interrupted",
          error: normalized,
        });
      }
      await this.dispatchPendingForAgent(prepared.agentProductId);
      return;
    }

    try {
      const nativeTurn = await prepared.connector.startTurn(session, {
        content: prepared.content,
        snapshot: prepared.snapshot,
        turnId: prepared.turnId,
        mcpConfigPath: prepared.mcpConfigPath,
      });
      this.repositories.markTurnRunning(prepared.turnId, nativeTurn.nativeTurnId);
    } catch (error) {
      const normalized = normalizeError(error);
      if (isDefiniteStartRejection(error)) {
        await this.commitTerminalWithRetry({
          conversationId: prepared.conversationId,
          turnId: prepared.turnId,
          status: "start_failed",
          error: normalized,
          requeueMessage: true,
        });
      } else {
        await this.commitTerminalWithRetry({
          conversationId: prepared.conversationId,
          turnId: prepared.turnId,
          status: "interrupted",
          error: normalized,
        });
      }
      await this.dispatchPendingForAgent(prepared.agentProductId);
    }
  }

  async cancelActiveTurn(conversationId: string): Promise<boolean> {
    const activeTurn = this.repositories.getActiveTurn(conversationId);
    if (!activeTurn) {
      return false;
    }

    const conversation = this.repositories.getConversation(conversationId);
    if (!conversation) {
      return false;
    }

    const connector = this.connectors[conversation.agentProductId];
    if (!connector) {
      throw new Error(`No connector registered for ${conversation.agentProductId}`);
    }

    if (!this.repositories.markTurnCancelling(activeTurn.id)) {
      return false;
    }

    const session =
      this.liveSessions.get(conversationId)?.session ?? {
        id: conversationId,
        nativeSessionId:
          this.repositories.getNativeSession(conversationId)?.nativeSessionId ?? null,
      };

    let confirmed = false;
    let cancelError: NormalizedError | undefined;
    try {
      confirmed = (await connector.cancelTurn(session, activeTurn.nativeTurnId)).confirmed;
      if (!confirmed) {
        cancelError = {
          code: "cancel_not_confirmed",
          message: "Connector could not confirm native cancellation",
        };
      }
    } catch (error) {
      cancelError = normalizeError(error);
    }

    await this.commitTerminalWithRetry({
      conversationId,
      turnId: activeTurn.id,
      status: confirmed ? "cancelled" : "cancel_failed",
      ...(cancelError ? { error: cancelError } : {}),
    });
    await this.dispatchPendingForAgent(conversation.agentProductId);

    return true;
  }

  async respondToPermission(
    conversationId: string,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<boolean> {
    const live = this.liveSessions.get(conversationId);
    if (!live || !this.repositories.getActiveTurn(conversationId)) return false;
    await live.connector.respondToPermission(live.session, requestId, decision);
    return true;
  }

  async continueConversation(conversationId: string): Promise<boolean> {
    const conversation = this.repositories.getConversation(conversationId);
    if (!conversation) {
      return false;
    }
    this.repositories.setConversationQueuePaused(conversationId, false);
    await this.dispatchNext(conversationId);
    return true;
  }

  async retryInterruptedTurn(conversationId: string, turnId: string): Promise<boolean> {
    const conversation = this.repositories.getConversation(conversationId);
    if (!conversation) {
      return false;
    }
    const retry = this.repositories.enqueueInterruptedTurnRetry(conversationId, turnId);
    if (!retry) {
      return false;
    }
    this.repositories.setConversationQueuePaused(conversationId, false);
    await this.dispatchNext(conversationId);
    return true;
  }

  async resolveUncertainDelivery(
    conversationId: string,
    messageId: string,
    action: "retry" | "accept",
  ): Promise<boolean> {
    if (!this.repositories.resolveUncertainMessage(conversationId, messageId, action)) return false;
    await this.dispatchNext(conversationId);
    return true;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const sessions = [...this.liveSessions.entries()];
    const results = await Promise.allSettled(
      sessions.map(([, { connector, session }]) => connector.closeSession(session)),
    );
    for (let index = 0; index < sessions.length; index += 1) {
      const [conversationId, live] = sessions[index]!;
      if (results[index]?.status === "fulfilled" && this.liveSessions.get(conversationId) === live) {
        this.liveSessions.delete(conversationId);
      }
    }
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) {
      throw failed.reason;
    }
  }

  async recoverInterruptedTurns(): Promise<number> {
    return this.repositories.interruptActiveTurns();
  }

  async recoverPendingQueues(): Promise<void> {
    const conversations = this.repositories.listProjects().flatMap((project) =>
      this.repositories.listConversations(project.id),
    );
    for (const conversation of conversations) {
      if (conversation.queuePaused) {
        continue;
      }
      try {
        await this.dispatchNext(conversation.id);
      } catch {
        // A broken Conversation must not prevent the local server from starting.
      }
    }
  }

  private async handleTerminalUpdate(input: {
    conversationId: string;
    turnId: string;
    nativeTurnId: string | null;
    status: TerminalTurnStatus;
    error?: NormalizedError;
  }): Promise<void> {
    const { conversationId, status } = input;
    const live = this.liveSessions.get(conversationId);
    let result = await this.commitTerminalWithRetry(input);
    const releasedLease = result === "stale" && live?.ownerTurnId === input.turnId;
    if (releasedLease) {
      this.liveSessions.delete(conversationId);
      const active = this.repositories.getActiveTurn(conversationId);
      if (active) result = await this.commitTerminalWithRetry({ ...input, turnId: active.id });
      this.repositories.markConversationStagedMessageUncertain(conversationId);
    }
    if (result === "stale" && !releasedLease) {
      return;
    }

    const conversation = this.repositories.getConversation(conversationId);
    if (conversation) {
      try {
        await this.dispatchPendingForAgent(conversation.agentProductId);
      } catch {
        // The terminal state is already durable; a later command can wake the pending queue.
      }
    }
  }

  private listAgentConversations(agentProductId: AgentProductId) {
    return this.repositories.listProjects().flatMap((project) =>
      this.repositories.listConversations(project.id),
    ).filter((conversation) => conversation.agentProductId === agentProductId);
  }

  private async dispatchPendingForAgent(agentProductId: AgentProductId): Promise<void> {
    for (const conversation of this.listAgentConversations(agentProductId)) {
      if (!conversation.queuePaused) {
        await this.dispatchNext(conversation.id);
      }
    }
  }

  private async withAgentPreparation<T>(
    agentProductId: AgentProductId,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.agentPreparationQueues.get(agentProductId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.agentPreparationQueues.set(agentProductId, queued);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.agentPreparationQueues.get(agentProductId) === queued) {
        this.agentPreparationQueues.delete(agentProductId);
      }
    }
  }

  private async commitTerminalWithRetry(input: {
    conversationId: string;
    turnId: string;
    status: TerminalTurnStatus;
    error?: NormalizedError;
    requeueMessage?: boolean;
  }): Promise<"committed" | "already_committed" | "stale"> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return this.repositories.commitTerminalTurn(input);
      } catch (error) {
        if (attempt >= 2 || !isTransientSqliteError(error)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  }

  private bindConnector(connector: AgentConnector): void {
    const callbackCapable = connector as ConnectorWithCallbacks;
    callbackCapable.setTurnCallbacks?.({
      onTerminal: async (input) => {
        await this.handleTerminalUpdate(input);
      },
    });
  }

  private async tryContinuePending(conversationId: string): Promise<void> {
    const previous = this.continuationQueues.get(conversationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const activeTurn = this.repositories.getActiveTurn(conversationId);
      const live = this.liveSessions.get(conversationId);
      const message = this.repositories.listQueuedMessages(conversationId)[0];
      if (!live?.reusableLease || !live.connector.continueTurn || !message || message.status !== "pending") return;
      const deliveryId = randomUUID();
      const staged = this.repositories.stageMessage(conversationId, message.id, deliveryId);
      if (!staged) return;
      try {
        if (!await live.connector.continueTurn(live.session, { messageId: message.id, deliveryId, content: message.content })) {
          this.repositories.rollbackStagedMessage(conversationId, message.id, deliveryId);
        }
      } catch {
        this.repositories.rollbackStagedMessage(conversationId, message.id, deliveryId);
      }
    });
    this.continuationQueues.set(conversationId, current);
    try {
      await current;
    } finally {
      if (this.continuationQueues.get(conversationId) === current) {
        this.continuationQueues.delete(conversationId);
      }
    }
  }
}

function readAcknowledgement(payload: Record<string, unknown>): { messageId: string; deliveryId: string } | null {
  const value = payload.acknowledged;
  if (!value || typeof value !== "object") return null;
  const { messageId, deliveryId } = value as Record<string, unknown>;
  return typeof messageId === "string" && typeof deliveryId === "string" ? { messageId, deliveryId } : null;
}

function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    const details: Record<string, unknown> = {};
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string") {
      details.code = code;
    }
    return {
      code: "runtime_error",
      message: error.message,
      details: Object.keys(details).length > 0 ? details : undefined,
    };
  }

  return {
    code: "runtime_error",
    message: "Unknown runtime error",
    details: { error },
  };
}

function isDefiniteStartRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { definiteStartRejection?: unknown; code?: unknown };
  return (
    candidate.definiteStartRejection === true ||
    candidate.code === "DEFINITE_START_REJECTION"
  );
}

function isTransientSqliteError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function isDefinitePreStartFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    definiteSessionFailure?: unknown;
    definiteStartRejection?: unknown;
    code?: unknown;
  };
  return (
    candidate.definiteSessionFailure === true ||
    candidate.definiteStartRejection === true ||
    candidate.code === "DEFINITE_SESSION_FAILURE" ||
    candidate.code === "DEFINITE_START_REJECTION"
  );
}
