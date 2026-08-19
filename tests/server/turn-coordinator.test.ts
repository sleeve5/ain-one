import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type {
  AgentCatalog,
  AgentConnector,
  AgentProbe,
  CancelResult,
  Conversation,
  LiveSession,
  MaterializeInput,
  MaterializeResult,
  NativePluginCandidate,
  NativeTurn,
  NormalizedError,
  PermissionDecision,
  SessionInput,
  StartTurnInput,
  TerminalTurnStatus,
} from "../../src/shared/contracts.js";
import { createDatabase } from "../../src/server/db.js";
import { createRepositories } from "../../src/server/repositories.js";
import { TurnCoordinator } from "../../src/server/turn-coordinator.js";

type TurnCallbacks = {
  onTerminal: (input: {
    conversationId: string;
    turnId: string;
    nativeTurnId: string | null;
    status: TerminalTurnStatus;
    error?: NormalizedError;
  }) => Promise<void>;
};

type StartedTurn = {
  turnId: string;
  conversationId: string;
  nativeTurnId: string;
  content: string;
};

class ControlledConnector implements AgentConnector {
  readonly id = "codex" as const;
  prompts: string[] = [];
  startAttempts = 0;
  startedTurnIds: string[] = [];
  createSessionCalls = 0;
  cancelRequests: Array<{ sessionId: string; nativeTurnId: string | null }> = [];
  cancelMode: "confirm" | "reject" | "throw" = "confirm";
  sessionMode: "ok" | "definite_fail" | "uncertain_fail" = "ok";
  private callbacks: TurnCallbacks | null = null;
  private startedTurns: StartedTurn[] = [];

  setTurnCallbacks(callbacks: TurnCallbacks): void {
    this.callbacks = callbacks;
  }

  async probe(): Promise<AgentProbe> {
    return { status: "available", version: "test" };
  }

  async fetchCatalog(): Promise<AgentCatalog> {
    return {
      models: ["gpt-test"],
      permissionModes: ["request_approval", "full_access"],
    };
  }

  async createOrResumeSession(input: SessionInput): Promise<LiveSession> {
    this.createSessionCalls += 1;

    if (this.sessionMode === "definite_fail") {
      const error = new Error("session create rejected") as Error & {
        definiteSessionFailure?: boolean;
      };
      error.definiteSessionFailure = true;
      throw error;
    }

    if (this.sessionMode === "uncertain_fail") {
      throw new Error("session create outcome unknown");
    }

    return {
      id: input.conversationId,
      nativeSessionId: input.nativeSessionId ?? `native-session-${input.conversationId}`,
    };
  }

  async startTurn(session: LiveSession, input: StartTurnInput): Promise<NativeTurn> {
    if (!input.turnId) {
      throw new Error("expected turnId in StartTurnInput");
    }
    this.startAttempts += 1;
    this.prompts.push(input.content);

    const started: StartedTurn = {
      turnId: input.turnId,
      conversationId: session.id,
      nativeTurnId: `native-turn-${this.startAttempts}`,
      content: input.content,
    };
    this.startedTurns.push(started);
    this.startedTurnIds.push(started.turnId);

    return { nativeTurnId: started.nativeTurnId };
  }

  async emitTerminal(
    turnId: string,
    status: TerminalTurnStatus = "completed",
    error?: NormalizedError,
  ): Promise<void> {
    if (!this.callbacks) {
      throw new Error("No callbacks configured");
    }
    const started = this.startedTurns.find((turn) => turn.turnId === turnId);
    if (!started) {
      throw new Error(`Unknown turn: ${turnId}`);
    }

    await this.callbacks.onTerminal({
      conversationId: started.conversationId,
      turnId,
      nativeTurnId: started.nativeTurnId,
      status,
      error,
    });
  }

  async respondToPermission(
    _session: LiveSession,
    _requestId: string,
    _decision: PermissionDecision,
  ): Promise<void> {
    return undefined;
  }

  async cancelTurn(
    session: LiveSession,
    nativeTurnId: string | null,
  ): Promise<CancelResult> {
    this.cancelRequests.push({ sessionId: session.id, nativeTurnId });

    if (this.cancelMode === "throw") {
      throw new Error("cancel transport failure");
    }

    if (this.cancelMode === "reject") {
      return { confirmed: false };
    }

    return { confirmed: true };
  }

  async closeSession(): Promise<void> {
    return undefined;
  }

  async discoverPlugins(): Promise<NativePluginCandidate[]> {
    return [];
  }

  async materializePlugins(_input: MaterializeInput): Promise<MaterializeResult> {
    return { applied: [] };
  }
}

class UncertainStartConnector extends ControlledConnector {
  override async startTurn(_session: LiveSession, input: StartTurnInput): Promise<NativeTurn> {
    if (!input.turnId) {
      throw new Error("expected turnId in StartTurnInput");
    }
    this.startAttempts += 1;
    throw new Error("native start outcome unknown");
  }
}

class DefiniteRejectConnector extends ControlledConnector {
  override async startTurn(_session: LiveSession, input: StartTurnInput): Promise<NativeTurn> {
    if (!input.turnId) {
      throw new Error("expected turnId in StartTurnInput");
    }
    this.startAttempts += 1;
    const error = new Error("native start rejected") as Error & {
      definiteStartRejection?: boolean;
    };
    error.definiteStartRejection = true;
    throw error;
  }
}

class EarlyTerminalConnector extends ControlledConnector {
  private emittedEarly = false;

  override async startTurn(
    session: LiveSession,
    input: StartTurnInput,
  ): Promise<NativeTurn> {
    const nativeTurn = await super.startTurn(session, input);
    if (!this.emittedEarly) {
      this.emittedEarly = true;
      await this.emitTerminal(input.turnId!, "completed");
    }
    return nativeTurn;
  }
}

function createTestCoordinator(connector: ControlledConnector): {
  db: DatabaseSync;
  coordinator: TurnCoordinator;
  repositories: ReturnType<typeof createRepositories>;
  createConversation: () => Conversation;
} {
  const db = createDatabase(":memory:");
  const repositories = createRepositories(db);
  const coordinator = new TurnCoordinator({
    repositories,
    connectors: { codex: connector },
  });
  const project = repositories.createProject(`/tmp/project-${randomUUID()}`, "test");

  return {
    db,
    coordinator,
    repositories,
    createConversation: () =>
      repositories.createConversation({
        projectId: project.id,
        agentProductId: "codex",
        modelId: "gpt-test",
      }),
  };
}

describe("TurnCoordinator", () => {
  it("runs one Turn at a time and dispatches queued messages in FIFO order", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    await app.coordinator.enqueueMessage(conversation.id, "first");
    await app.coordinator.enqueueMessage(conversation.id, "second");

    expect(runtime.prompts).toEqual(["first"]);

    const firstTurnId = app.repositories.getLatestTurn(conversation.id)?.id;
    if (!firstTurnId) {
      throw new Error("expected first turn");
    }

    await runtime.emitTerminal(firstTurnId);

    expect(runtime.prompts).toEqual(["first", "second"]);
  });

  it("keeps FIFO order when pending messages share the same created_at timestamp", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    app.repositories.setConversationQueuePaused(conversation.id, true);
    const first = app.repositories.enqueueMessage(conversation.id, "first");
    const second = app.repositories.enqueueMessage(conversation.id, "second");

    const fixed = "2026-08-19T00:00:00.000Z";
    app.db
      .prepare(`UPDATE queued_messages SET created_at = ? WHERE id IN (?, ?)`)
      .run(fixed, first.id, second.id);

    app.repositories.setConversationQueuePaused(conversation.id, false);
    await app.coordinator.dispatchNext(conversation.id);

    let activeTurn = app.repositories.getActiveTurn(conversation.id);
    if (!activeTurn) {
      throw new Error("expected first active turn");
    }
    await runtime.emitTerminal(activeTurn.id, "completed");

    activeTurn = app.repositories.getActiveTurn(conversation.id);
    if (!activeTurn) {
      throw new Error("expected second active turn");
    }
    await runtime.emitTerminal(activeTurn.id, "completed");

    expect(runtime.prompts).toEqual(["first", "second"]);
  });

  it("ignores stale terminal callbacks that do not match the current active Turn", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    await app.coordinator.enqueueMessage(conversation.id, "first");
    await app.coordinator.enqueueMessage(conversation.id, "second");

    const firstTurnId = app.repositories.getActiveTurn(conversation.id)?.id;
    if (!firstTurnId) {
      throw new Error("expected first active turn");
    }
    await runtime.emitTerminal(firstTurnId, "completed");

    const secondTurnId = app.repositories.getActiveTurn(conversation.id)?.id;
    if (!secondTurnId) {
      throw new Error("expected second active turn");
    }

    await runtime.emitTerminal(firstTurnId, "failed", {
      code: "stale",
      message: "late callback",
    });

    expect(app.repositories.getTurn(secondTurnId)?.status).toBe("running");
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(false);
  });

  it("does not resurrect a Turn completed before startTurn resolves", async () => {
    const runtime = new EarlyTerminalConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    app.repositories.setConversationQueuePaused(conversation.id, true);
    app.repositories.enqueueMessage(conversation.id, "first");
    app.repositories.enqueueMessage(conversation.id, "second");
    app.repositories.setConversationQueuePaused(conversation.id, false);

    await app.coordinator.dispatchNext(conversation.id);

    const secondTurn = app.repositories.getActiveTurn(conversation.id);
    if (!secondTurn) {
      throw new Error("expected second Turn to be active");
    }
    const firstTurnId = runtime.startedTurnIds[0];
    if (!firstTurnId) {
      throw new Error("expected first Turn ID");
    }

    expect(app.repositories.getTurn(firstTurnId)?.status).toBe("completed");
    expect(app.repositories.getTurn(secondTurn.id)?.status).toBe("running");
    expect(runtime.prompts).toEqual(["first", "second"]);
    expect(runtime.startAttempts).toBe(2);
  });

  it("serializes concurrent dispatches so one session/start wins and cancel targets the active native turn", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    app.repositories.enqueueMessage(conversation.id, "first");

    await Promise.all([
      app.coordinator.dispatchNext(conversation.id),
      app.coordinator.dispatchNext(conversation.id),
    ]);

    expect(runtime.createSessionCalls).toBe(1);
    expect(runtime.startAttempts).toBe(1);

    const activeTurn = app.repositories.getActiveTurn(conversation.id);
    if (!activeTurn) {
      throw new Error("expected active turn after dispatch");
    }

    await app.coordinator.cancelActiveTurn(conversation.id);

    expect(runtime.cancelRequests).toEqual([
      expect.objectContaining({ nativeTurnId: activeTurn.nativeTurnId }),
    ]);
  });

  it("pauses queue and keeps message bound after unknown start outcome", async () => {
    const runtime = new UncertainStartConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    await app.coordinator.enqueueMessage(conversation.id, "unsafe to repeat");
    await app.coordinator.dispatchNext(conversation.id);

    expect(app.repositories.getActiveTurn(conversation.id)).toBeNull();
    expect(app.repositories.getLatestTurn(conversation.id)?.status).toBe("interrupted");
    expect(app.repositories.listQueuedMessages(conversation.id)).toHaveLength(0);
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
    expect(runtime.startAttempts).toBe(1);
  });

  it("requeues exactly once after definite start rejection and pauses automatic dispatch", async () => {
    const runtime = new DefiniteRejectConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    await app.coordinator.enqueueMessage(conversation.id, "retry me");
    const [requeued] = app.repositories.listQueuedMessages(conversation.id);
    if (!requeued) {
      throw new Error("expected message to be requeued");
    }

    await app.coordinator.dispatchNext(conversation.id);

    expect(app.repositories.getActiveTurn(conversation.id)).toBeNull();
    expect(app.repositories.getLatestTurn(conversation.id)?.status).toBe("start_failed");
    expect(app.repositories.listQueuedMessages(conversation.id)).toEqual([
      expect.objectContaining({ id: requeued.id, content: "retry me" }),
    ]);
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
    expect(runtime.startAttempts).toBe(1);
  });

  it("treats definite session creation failure as start_failed and requeues once", async () => {
    const runtime = new ControlledConnector();
    runtime.sessionMode = "definite_fail";

    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    await app.coordinator.enqueueMessage(conversation.id, "retry me");
    await app.coordinator.dispatchNext(conversation.id);

    expect(runtime.startAttempts).toBe(0);
    expect(app.repositories.getLatestTurn(conversation.id)?.status).toBe("start_failed");
    expect(app.repositories.listQueuedMessages(conversation.id)).toHaveLength(1);
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
  });

  it("treats uncertain session creation failure as interrupted and keeps message bound", async () => {
    const runtime = new ControlledConnector();
    runtime.sessionMode = "uncertain_fail";

    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    await app.coordinator.enqueueMessage(conversation.id, "unsafe to repeat");
    await app.coordinator.dispatchNext(conversation.id);

    expect(runtime.startAttempts).toBe(0);
    expect(app.repositories.getLatestTurn(conversation.id)?.status).toBe("interrupted");
    expect(app.repositories.listQueuedMessages(conversation.id)).toHaveLength(0);
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
  });

  it("does not release FIFO after failed Turn", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    await app.coordinator.enqueueMessage(conversation.id, "first");
    await app.coordinator.enqueueMessage(conversation.id, "second");

    const activeTurnId = app.repositories.getActiveTurn(conversation.id)?.id;
    if (!activeTurnId) {
      throw new Error("expected first active turn");
    }
    await runtime.emitTerminal(activeTurnId, "failed");

    expect(runtime.prompts).toEqual(["first"]);
    expect(app.repositories.listQueuedMessages(conversation.id)).toEqual([
      expect.objectContaining({ content: "second" }),
    ]);
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
  });

  it("releases FIFO after confirmed cancellation", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    await app.coordinator.enqueueMessage(conversation.id, "first");
    await app.coordinator.enqueueMessage(conversation.id, "second");

    await app.coordinator.cancelActiveTurn(conversation.id);

    expect(runtime.prompts).toEqual(["first", "second"]);
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(false);
  });

  it("marks cancel_failed and keeps queue paused when cancel is not confirmed", async () => {
    const runtime = new ControlledConnector();
    runtime.cancelMode = "reject";

    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    await app.coordinator.enqueueMessage(conversation.id, "first");
    await app.coordinator.enqueueMessage(conversation.id, "second");
    await app.coordinator.cancelActiveTurn(conversation.id);

    expect(runtime.prompts).toEqual(["first"]);
    expect(app.repositories.getLatestTurn(conversation.id)?.status).toBe("cancel_failed");
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
    expect(app.repositories.listQueuedMessages(conversation.id)).toEqual([
      expect.objectContaining({ content: "second" }),
    ]);
  });

  it("marks cancel_failed and keeps queue paused when cancel throws", async () => {
    const runtime = new ControlledConnector();
    runtime.cancelMode = "throw";

    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    await app.coordinator.enqueueMessage(conversation.id, "first");
    await app.coordinator.enqueueMessage(conversation.id, "second");
    await app.coordinator.cancelActiveTurn(conversation.id);

    expect(runtime.prompts).toEqual(["first"]);
    expect(app.repositories.getLatestTurn(conversation.id)?.status).toBe("cancel_failed");
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
    expect(app.repositories.listQueuedMessages(conversation.id)).toEqual([
      expect.objectContaining({ content: "second" }),
    ]);
  });
});
