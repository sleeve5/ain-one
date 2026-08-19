import type {
  AgentConnector,
  AgentProductId,
  LiveSession,
  NormalizedError,
  TerminalTurnStatus,
  TurnSnapshot,
} from "../shared/contracts.js";
import type { Repositories } from "./repositories.js";

interface TurnCoordinatorOptions {
  repositories: Repositories;
  connectors: Partial<Record<AgentProductId, AgentConnector>>;
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

export class TurnCoordinator {
  private readonly repositories: Repositories;
  private readonly connectors: Partial<Record<AgentProductId, AgentConnector>>;
  private readonly liveSessions = new Map<string, LiveSession>();

  constructor(options: TurnCoordinatorOptions) {
    this.repositories = options.repositories;
    this.connectors = options.connectors;

    for (const connector of Object.values(this.connectors)) {
      const callbackCapable = connector as ConnectorWithCallbacks;
      callbackCapable.setTurnCallbacks?.({
        onTerminal: async (input) => {
          await this.handleTerminalUpdate(input);
        },
      });
    }
  }

  async enqueueMessage(conversationId: string, content: string): Promise<void> {
    this.repositories.enqueueMessage(conversationId, content);
    await this.dispatchNext(conversationId);
  }

  async dispatchNext(conversationId: string): Promise<void> {
    const conversation = this.repositories.getConversation(conversationId);
    if (!conversation || conversation.queuePaused) {
      return;
    }

    if (this.repositories.getActiveTurn(conversationId)) {
      return;
    }

    const connector = this.connectors[conversation.agentProductId];
    if (!connector) {
      throw new Error(`No connector registered for ${conversation.agentProductId}`);
    }

    const project = this.repositories.getProject(conversation.projectId);
    if (!project) {
      throw new Error(`Project not found for conversation ${conversationId}`);
    }

    const snapshot: TurnSnapshot = {
      modelId: conversation.modelId,
      permissionMode: conversation.permissionMode,
      pluginVersions: [],
    };

    const claimed = this.repositories.claimNextMessage(conversationId, snapshot);
    if (!claimed) {
      return;
    }

    let session: LiveSession;
    try {
      const sessionRecord = this.repositories.getNativeSession(conversationId);
      session = await connector.createOrResumeSession({
        projectPath: project.path,
        conversationId,
        nativeSessionId: sessionRecord?.nativeSessionId ?? null,
        onEvent: async (event) => {
          this.repositories.appendEvent(conversationId, event);
        },
        onNativeSessionId: async (nativeSessionId) => {
          this.repositories.upsertNativeSession(conversationId, nativeSessionId);
        },
      });
      this.repositories.upsertNativeSession(conversationId, session.nativeSessionId);
      this.liveSessions.set(conversationId, session);
    } catch (error) {
      const normalized = normalizeError(error);
      if (isDefinitePreStartFailure(error)) {
        this.repositories.finishTurn(claimed.turn.id, "start_failed", normalized);
        this.repositories.requeueClaimedMessage(claimed.turn.id);
      } else {
        this.repositories.finishTurn(claimed.turn.id, "interrupted", normalized);
      }
      this.repositories.setConversationQueuePaused(conversationId, true);
      return;
    }

    try {
      const nativeTurn = await connector.startTurn(session, {
        content: claimed.message.content,
        snapshot,
        turnId: claimed.turn.id,
      });
      this.repositories.markTurnRunning(claimed.turn.id, nativeTurn.nativeTurnId);
    } catch (error) {
      const normalized = normalizeError(error);
      if (isDefiniteStartRejection(error)) {
        this.repositories.finishTurn(claimed.turn.id, "start_failed", normalized);
        this.repositories.requeueClaimedMessage(claimed.turn.id);
      } else {
        this.repositories.finishTurn(claimed.turn.id, "interrupted", normalized);
      }
      this.repositories.setConversationQueuePaused(conversationId, true);
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

    this.repositories.markTurnCancelling(activeTurn.id);

    const session =
      this.liveSessions.get(conversationId) ?? {
        id: conversationId,
        nativeSessionId:
          this.repositories.getNativeSession(conversationId)?.nativeSessionId ?? null,
      };

    try {
      const result = await connector.cancelTurn(session, activeTurn.nativeTurnId);
      if (result.confirmed) {
        this.repositories.finishTurn(activeTurn.id, "cancelled");
        this.repositories.setConversationQueuePaused(conversationId, false);
        await this.dispatchNext(conversationId);
      } else {
        this.repositories.finishTurn(activeTurn.id, "cancel_failed", {
          code: "cancel_not_confirmed",
          message: "Connector could not confirm native cancellation",
        });
        this.repositories.setConversationQueuePaused(conversationId, true);
      }
    } catch (error) {
      this.repositories.finishTurn(activeTurn.id, "cancel_failed", normalizeError(error));
      this.repositories.setConversationQueuePaused(conversationId, true);
    }

    return true;
  }

  async recoverInterruptedTurns(): Promise<number> {
    const affectedConversationIds = this.repositories.listConversationIdsWithActiveTurns();
    if (affectedConversationIds.length === 0) {
      return 0;
    }

    const changed = this.repositories.interruptActiveTurns();
    for (const conversationId of affectedConversationIds) {
      this.repositories.setConversationQueuePaused(conversationId, true);
    }
    return changed;
  }

  private async handleTerminalUpdate(input: {
    conversationId: string;
    turnId: string;
    nativeTurnId: string | null;
    status: TerminalTurnStatus;
    error?: NormalizedError;
  }): Promise<void> {
    const { conversationId, turnId, status, error } = input;
    const activeTurn = this.repositories.getActiveTurn(conversationId);
    if (!activeTurn) {
      return;
    }

    if (activeTurn.id !== turnId) {
      return;
    }

    this.repositories.finishTurn(activeTurn.id, status, error);

    if (status === "completed" || status === "cancelled") {
      this.repositories.setConversationQueuePaused(conversationId, false);
      await this.dispatchNext(conversationId);
      return;
    }

    this.repositories.setConversationQueuePaused(conversationId, true);
  }
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
