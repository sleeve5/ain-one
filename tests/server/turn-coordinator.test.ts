import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
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
  snapshots: StartTurnInput["snapshot"][] = [];
  mcpConfigPaths: Array<string | null | undefined> = [];
  startAttempts = 0;
  startedTurnIds: string[] = [];
  createSessionCalls = 0;
  closeSessionCalls = 0;
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
    this.snapshots.push(input.snapshot);
    this.mcpConfigPaths.push(input.mcpConfigPath);

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

  async closeSession(_session: LiveSession): Promise<void> {
    this.closeSessionCalls += 1;
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

class FailingShutdownConnector extends ControlledConnector {
  closeSessionIds: string[] = [];
  delayedCloseCompleted = false;

  override async closeSession(session: LiveSession): Promise<void> {
    this.closeSessionIds.push(session.id);
    if (this.closeSessionIds.length === 1) {
      throw new Error("first close failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.delayedCloseCompleted = true;
  }
}

class BlockingCloseConnector extends ControlledConnector {
  readonly closeStarted: Promise<void>;
  private resolveCloseStarted!: () => void;
  private resolveClose!: () => void;

  constructor() {
    super();
    this.closeStarted = new Promise((resolvePromise) => {
      this.resolveCloseStarted = resolvePromise;
    });
  }

  override async closeSession(): Promise<void> {
    this.closeSessionCalls += 1;
    this.resolveCloseStarted();
    await new Promise<void>((resolvePromise) => {
      this.resolveClose = resolvePromise;
    });
  }

  finishClose(): void {
    this.resolveClose();
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
  it("uses a replaced Connector for later Turns", async () => {
    const initial = new ControlledConnector();
    const replacement = new ControlledConnector();
    const app = createTestCoordinator(initial);
    const conversation = app.createConversation();

    await app.coordinator.setConnector("codex", replacement);
    await app.coordinator.enqueueMessage(conversation.id, "new runtime");

    expect(initial.prompts).toEqual([]);
    expect(replacement.prompts).toEqual(["new runtime"]);
    app.db.close();
  });

  it("closes idle sessions before replacing a Connector", async () => {
    const initial = new ControlledConnector();
    const replacement = new ControlledConnector();
    const app = createTestCoordinator(initial);
    const conversation = app.createConversation();
    await app.coordinator.enqueueMessage(conversation.id, "first");
    const turn = app.repositories.getActiveTurn(conversation.id)!;
    await initial.emitTerminal(turn.id, "completed");

    await app.coordinator.setConnector("codex", replacement);
    await app.coordinator.enqueueMessage(conversation.id, "second");

    expect(initial.closeSessionCalls).toBe(1);
    expect(replacement.prompts).toEqual(["second"]);
  });

  it("does not start a new Turn on a Connector while that Connector is being replaced", async () => {
    const initial = new BlockingCloseConnector();
    const replacement = new ControlledConnector();
    const app = createTestCoordinator(initial);
    const conversation = app.createConversation();
    await app.coordinator.enqueueMessage(conversation.id, "first");
    const firstTurn = app.repositories.getActiveTurn(conversation.id)!;
    await initial.emitTerminal(firstTurn.id, "completed");

    const replacing = app.coordinator.setConnector("codex", replacement);
    await initial.closeStarted;
    const dispatching = app.coordinator.enqueueMessage(conversation.id, "second");
    initial.finishClose();
    await Promise.all([replacing, dispatching]);

    expect(initial.prompts).toEqual(["first"]);
    expect(replacement.prompts).toEqual(["second"]);
  });

  it("serializes between-Turn changes behind dispatch preparation", async () => {
    const runtime = new ControlledConnector();
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject(`/tmp/project-${randomUUID()}`, "test");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "gpt-test",
    });
    let releaseMaterialization!: () => void;
    let markMaterializationStarted!: () => void;
    const materializationStarted = new Promise<void>((resolvePromise) => {
      markMaterializationStarted = resolvePromise;
    });
    const materializationGate = new Promise<void>((resolvePromise) => {
      releaseMaterialization = resolvePromise;
    });
    const coordinator = new TurnCoordinator({
      repositories,
      connectors: { codex: runtime },
      materializePlugins: async () => {
        markMaterializationStarted();
        await materializationGate;
        return { turnArtifactPath: null };
      },
    });
    repositories.enqueueMessage(conversation.id, "claim before repair");

    const dispatching = coordinator.dispatchNext(conversation.id);
    await materializationStarted;
    const operation = vi.fn(async () => undefined);
    let changing: Promise<"updated" | "turn_active">;
    try {
      changing = coordinator.runBetweenTurns("codex", operation);
      await Promise.resolve();
      expect(operation).not.toHaveBeenCalled();
    } finally {
      releaseMaterialization();
    }

    await expect(changing!).resolves.toBe("turn_active");
    await dispatching;
    expect(operation).not.toHaveBeenCalled();
    expect(repositories.getActiveTurn(conversation.id)).not.toBeNull();
    db.close();
  });

  it("freezes current settings and materialized plugins into the Turn snapshot", async () => {
    const runtime = new ControlledConnector();
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject(`/tmp/project-${randomUUID()}`, "test");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "old-model",
    });
    const pluginVersions = [{ pluginId: "formatter", versionId: "v2" }];
    repositories.updateConversationSettings(conversation.id, {
      modelId: "new-model",
      permissionMode: "full_access",
    });
    repositories.setPluginEnablements(
      { type: "conversation", id: conversation.id },
      pluginVersions,
    );
    const materialized: Array<{
      turnId: string;
      projectPath: string;
      plugins: typeof pluginVersions;
    }> = [];
    const coordinator = new TurnCoordinator({
      repositories,
      connectors: { codex: runtime },
      resolvePluginVersions: (input) =>
        repositories.resolvePluginVersions(input.projectId, input.conversationId),
      materializePlugins: async (input) => {
        materialized.push({
          turnId: input.turnId,
          projectPath: input.projectPath,
          plugins: input.plugins,
        });
        return { turnArtifactPath: `/tmp/${input.turnId}.json` };
      },
    });

    await coordinator.enqueueMessage(conversation.id, "use current settings");

    const turn = repositories.getLatestTurn(conversation.id);
    expect(turn).not.toBeNull();
    expect(materialized).toEqual([
      { turnId: turn!.id, projectPath: project.path, plugins: pluginVersions },
    ]);
    expect(runtime.snapshots).toEqual([
      {
        modelId: "new-model",
        permissionMode: "full_access",
        pluginVersions,
      },
    ]);
    expect(runtime.mcpConfigPaths).toEqual([`/tmp/${turn!.id}.json`]);
    expect(repositories.getLatestTurn(conversation.id)?.snapshot).toEqual(runtime.snapshots[0]);
    db.close();
  });

  it("requeues and pauses when plugin materialization fails before native start", async () => {
    const runtime = new ControlledConnector();
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject(`/tmp/project-${randomUUID()}`, "test");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "gpt-test",
    });
    const coordinator = new TurnCoordinator({
      repositories,
      connectors: { codex: runtime },
      materializePlugins: async () => {
        throw new Error("plugin materialization failed");
      },
    });

    await coordinator.enqueueMessage(conversation.id, "keep queued");

    expect(repositories.getLatestTurn(conversation.id)?.status).toBe("start_failed");
    expect(repositories.listQueuedMessages(conversation.id)).toEqual([
      expect.objectContaining({ content: "keep queued" }),
    ]);
    expect(repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
    expect(runtime.createSessionCalls).toBe(0);
    expect(runtime.startAttempts).toBe(0);
    db.close();
  });

  it("acknowledges a durable message when dispatch preparation fails", async () => {
    const runtime = new ControlledConnector();
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject(`/tmp/project-${randomUUID()}`, "test");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "gpt-test",
    });
    const coordinator = new TurnCoordinator({
      repositories,
      connectors: { codex: runtime },
      resolvePluginVersions: () => {
        throw new Error("broken plugin settings");
      },
    });

    await expect(
      coordinator.enqueueMessage(conversation.id, "keep exactly once"),
    ).resolves.toBeUndefined();

    expect(repositories.listQueuedMessages(conversation.id)).toEqual([
      expect.objectContaining({ content: "keep exactly once" }),
    ]);
    expect(repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
    expect(repositories.eventsAfter(conversation.id, 0)).toEqual([
      expect.objectContaining({
        type: "warning",
        payload: {
          code: "queue_dispatch_failed",
          message: "broken plugin settings",
        },
      }),
    ]);
    db.close();
  });

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

  it("retries transient SQLite failures before acknowledging a terminal Turn", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();
    await app.coordinator.enqueueMessage(conversation.id, "first");
    await app.coordinator.enqueueMessage(conversation.id, "second");
    const turn = app.repositories.getActiveTurn(conversation.id)!;
    const commit = app.repositories.commitTerminalTurn.bind(app.repositories);
    let attempts = 0;
    vi.spyOn(app.repositories, "commitTerminalTurn").mockImplementation((input) => {
      attempts += 1;
      if (attempts <= 2) {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      }
      return commit(input);
    });

    await expect(runtime.emitTerminal(turn.id, "completed")).resolves.toBeUndefined();

    expect(attempts).toBe(3);
    expect(app.repositories.getTurn(turn.id)?.status).toBe("completed");
    expect(runtime.prompts).toEqual(["first", "second"]);
  });

  it("rolls back terminal status when the queue policy cannot be committed", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();
    await app.coordinator.enqueueMessage(conversation.id, "first");
    const turn = app.repositories.getActiveTurn(conversation.id)!;
    app.db.exec(`
      CREATE TRIGGER fail_terminal_queue_policy
      BEFORE UPDATE OF queue_paused ON conversations
      BEGIN
        SELECT RAISE(ABORT, 'queue policy failed');
      END;
    `);

    expect(() =>
      app.repositories.commitTerminalTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        status: "failed",
      }),
    ).toThrow("queue policy failed");
    expect(app.repositories.getTurn(turn.id)?.status).toBe("running");
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(false);

    app.db.exec("DROP TRIGGER fail_terminal_queue_policy");
    expect(
      app.repositories.commitTerminalTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        status: "failed",
      }),
    ).toBe("committed");
    expect(app.repositories.getTurn(turn.id)?.status).toBe("failed");
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
  });

  it("commits start failure, message requeue, and queue pause atomically", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();
    await app.coordinator.enqueueMessage(conversation.id, "retry me");
    const turn = app.repositories.getActiveTurn(conversation.id)!;
    app.db.exec(`
      CREATE TRIGGER fail_start_failure_queue_policy
      BEFORE UPDATE OF queue_paused ON conversations
      BEGIN
        SELECT RAISE(ABORT, 'queue policy failed');
      END;
    `);

    expect(() =>
      app.repositories.commitTerminalTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        status: "start_failed",
        requeueMessage: true,
      }),
    ).toThrow("queue policy failed");
    expect(app.repositories.getTurn(turn.id)?.status).toBe("running");
    expect(app.repositories.listQueuedMessages(conversation.id)).toEqual([]);
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(false);

    app.db.exec("DROP TRIGGER fail_start_failure_queue_policy");
    expect(
      app.repositories.commitTerminalTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        status: "start_failed",
        requeueMessage: true,
      }),
    ).toBe("committed");
    expect(app.repositories.getTurn(turn.id)?.status).toBe("start_failed");
    expect(app.repositories.listQueuedMessages(conversation.id)).toEqual([
      expect.objectContaining({ content: "retry me" }),
    ]);
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
  });

  it("rolls back startup interruption when queue pausing cannot be committed", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();
    await app.coordinator.enqueueMessage(conversation.id, "active work");
    const turn = app.repositories.getActiveTurn(conversation.id)!;
    app.db.exec(`
      CREATE TRIGGER fail_recovery_queue_policy
      BEFORE UPDATE OF queue_paused ON conversations
      BEGIN
        SELECT RAISE(ABORT, 'recovery queue policy failed');
      END;
    `);

    await expect(app.coordinator.recoverInterruptedTurns()).rejects.toThrow(
      "recovery queue policy failed",
    );
    expect(app.repositories.getTurn(turn.id)?.status).toBe("running");
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(false);
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
    expect(
      app.db
        .prepare("SELECT status FROM queued_messages WHERE claimed_turn_id = ?")
        .get(firstTurnId),
    ).toEqual({ status: "consumed" });
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

  it("runs Turns concurrently across Conversations sharing one Agent", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const first = app.createConversation();
    const second = app.createConversation();

    await Promise.all([
      app.coordinator.enqueueMessage(first.id, "first conversation"),
      app.coordinator.enqueueMessage(second.id, "second conversation"),
    ]);

    expect(runtime.prompts).toEqual(
      expect.arrayContaining(["first conversation", "second conversation"]),
    );
    expect(runtime.prompts).toHaveLength(2);
    expect(app.repositories.hasActiveTurnForAgent("codex")).toBe(true);
    expect(app.repositories.getActiveTurn(first.id)).not.toBeNull();
    expect(app.repositories.getActiveTurn(second.id)).not.toBeNull();
  });

  it("waits to change an Agent's shared plugin set until active Turns finish", async () => {
    const runtime = new ControlledConnector();
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject(`/tmp/project-${randomUUID()}`, "test");
    const first = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "gpt-test",
    });
    const second = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "gpt-test",
    });
    const materialized: Array<Array<{ pluginId: string; versionId: string }>> = [];
    const coordinator = new TurnCoordinator({
      repositories,
      connectors: { codex: runtime },
      resolvePluginVersions: ({ conversationId }) =>
        conversationId === first.id ? [] : [{ pluginId: "reviewer", versionId: "v1" }],
      materializePlugins: async ({ plugins }) => {
        materialized.push(plugins);
        return { turnArtifactPath: null };
      },
    });

    await coordinator.enqueueMessage(first.id, "first");
    await coordinator.enqueueMessage(second.id, "second");
    expect(runtime.prompts).toEqual(["first"]);
    expect(repositories.listQueuedMessages(second.id)).toHaveLength(1);
    expect(materialized).toEqual([[]]);

    const firstTurn = repositories.getActiveTurn(first.id)!;
    await runtime.emitTerminal(firstTurn.id, "completed");
    await vi.waitFor(() => expect(runtime.prompts).toEqual(["first", "second"]));
    expect(materialized).toEqual([[], [{ pluginId: "reviewer", versionId: "v1" }]]);
    db.close();
  });

  it.each(["interrupted", "cancel_failed"] as const)(
    "does not block another Conversation when one ends as %s",
    async (status) => {
      const runtime = new ControlledConnector();
      const app = createTestCoordinator(runtime);
      const interruptedConversation = app.createConversation();
      const waitingConversation = app.createConversation();

      await app.coordinator.enqueueMessage(interruptedConversation.id, "uncertain work");
      const activeTurn = app.repositories.getActiveTurn(interruptedConversation.id);
      if (!activeTurn) {
        throw new Error("expected active Turn");
      }
      await runtime.emitTerminal(activeTurn.id, status);
      await app.coordinator.enqueueMessage(waitingConversation.id, "can run");

      expect(runtime.prompts).toEqual(["uncertain work", "can run"]);
      expect(app.repositories.getActiveTurn(waitingConversation.id)).not.toBeNull();
    },
  );

  it("closes every live native session during graceful shutdown", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    await app.coordinator.enqueueMessage(conversation.id, "still running");
    await app.coordinator.shutdown();

    expect(runtime.closeSessionCalls).toBe(1);
  });

  it("waits for every live session to close before reporting a shutdown failure", async () => {
    const runtime = new FailingShutdownConnector();
    const app = createTestCoordinator(runtime);
    const first = app.createConversation();
    const second = app.createConversation();

    await app.coordinator.enqueueMessage(first.id, "first");
    const firstTurn = app.repositories.getActiveTurn(first.id);
    if (!firstTurn) {
      throw new Error("expected first Turn");
    }
    await runtime.emitTerminal(firstTurn.id, "completed");
    await app.coordinator.enqueueMessage(second.id, "second");

    await expect(app.coordinator.shutdown()).rejects.toThrow("first close failed");
    expect(runtime.closeSessionIds).toHaveLength(2);
    expect(runtime.delayedCloseCompleted).toBe(true);
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

  it("continues only the existing pending queue after an interrupted Turn", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();
    const snapshot = {
      modelId: "gpt-test",
      permissionMode: "request_approval" as const,
      pluginVersions: [],
    };

    app.repositories.setConversationQueuePaused(conversation.id, true);
    app.repositories.enqueueMessage(conversation.id, "do not repeat");
    const interrupted = app.repositories.claimNextMessage(conversation.id, snapshot);
    if (!interrupted) {
      throw new Error("expected interrupted Turn");
    }
    app.repositories.finishTurn(interrupted.turn.id, "interrupted");
    app.repositories.enqueueMessage(conversation.id, "continue with this");

    await app.coordinator.continueConversation(conversation.id);

    expect(runtime.prompts).toEqual(["continue with this"]);
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(false);
  });

  it("retries an interrupted Turn as a new message before the pending queue", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();
    const snapshot = {
      modelId: "gpt-test",
      permissionMode: "request_approval" as const,
      pluginVersions: [],
    };

    app.repositories.setConversationQueuePaused(conversation.id, true);
    app.repositories.enqueueMessage(conversation.id, "retry this");
    const interrupted = app.repositories.claimNextMessage(conversation.id, snapshot);
    if (!interrupted) {
      throw new Error("expected interrupted Turn");
    }
    app.repositories.finishTurn(interrupted.turn.id, "interrupted");
    app.repositories.enqueueMessage(conversation.id, "already pending");

    await app.coordinator.retryInterruptedTurn(conversation.id, interrupted.turn.id);

    expect(runtime.prompts).toEqual(["retry this"]);
    expect(app.repositories.getTurn(interrupted.turn.id)?.status).toBe("interrupted");

    const retryTurn = app.repositories.getActiveTurn(conversation.id);
    if (!retryTurn) {
      throw new Error("expected retry Turn");
    }
    expect(retryTurn.id).not.toBe(interrupted.turn.id);
    await runtime.emitTerminal(retryTurn.id, "completed");
    expect(runtime.prompts).toEqual(["retry this", "already pending"]);
  });

  it("reuses the same retry message when an interrupted Turn is retried twice", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();
    const snapshot = {
      modelId: "gpt-test",
      permissionMode: "request_approval" as const,
      pluginVersions: [],
    };

    app.repositories.setConversationQueuePaused(conversation.id, true);
    app.repositories.enqueueMessage(conversation.id, "retry once");
    const interrupted = app.repositories.claimNextMessage(conversation.id, snapshot);
    if (!interrupted) {
      throw new Error("expected interrupted Turn");
    }
    app.repositories.finishTurn(interrupted.turn.id, "interrupted");

    await Promise.all([
      app.coordinator.retryInterruptedTurn(conversation.id, interrupted.turn.id),
      app.coordinator.retryInterruptedTurn(conversation.id, interrupted.turn.id),
    ]);

    expect(runtime.prompts).toEqual(["retry once"]);
    const messages = app.db
      .prepare("SELECT content FROM queued_messages WHERE conversation_id = ? ORDER BY enqueue_seq")
      .all(conversation.id) as Array<{ content: string }>;
    expect(messages).toEqual([{ content: "retry once" }, { content: "retry once" }]);
  });

  it("resumes an existing retry message left paused by a crash", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();
    const snapshot = {
      modelId: "gpt-test",
      permissionMode: "request_approval" as const,
      pluginVersions: [],
    };

    app.repositories.setConversationQueuePaused(conversation.id, true);
    app.repositories.enqueueMessage(conversation.id, "retry after crash");
    const interrupted = app.repositories.claimNextMessage(conversation.id, snapshot);
    if (!interrupted) {
      throw new Error("expected interrupted Turn");
    }
    app.repositories.finishTurn(interrupted.turn.id, "interrupted");
    expect(
      app.repositories.enqueueInterruptedTurnRetry(conversation.id, interrupted.turn.id),
    ).toMatchObject({ created: true });

    await app.coordinator.retryInterruptedTurn(conversation.id, interrupted.turn.id);

    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(false);
    expect(runtime.prompts).toEqual(["retry after crash"]);
  });

  it("does not retry an interrupted Turn that is no longer the latest Turn", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();
    const snapshot = {
      modelId: "gpt-test",
      permissionMode: "request_approval" as const,
      pluginVersions: [],
    };

    app.repositories.setConversationQueuePaused(conversation.id, true);
    app.repositories.enqueueMessage(conversation.id, "old uncertain work");
    const oldTurn = app.repositories.claimNextMessage(conversation.id, snapshot);
    if (!oldTurn) {
      throw new Error("expected old interrupted Turn");
    }
    app.repositories.finishTurn(oldTurn.turn.id, "interrupted");

    app.repositories.setConversationQueuePaused(conversation.id, false);
    app.repositories.enqueueMessage(conversation.id, "new uncertain work");
    const newTurn = app.repositories.claimNextMessage(conversation.id, snapshot);
    if (!newTurn) {
      throw new Error("expected new interrupted Turn");
    }
    app.repositories.finishTurn(newTurn.turn.id, "interrupted");
    app.repositories.setConversationQueuePaused(conversation.id, true);

    await expect(
      app.coordinator.retryInterruptedTurn(conversation.id, oldTurn.turn.id),
    ).resolves.toBe(false);
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
    expect(runtime.prompts).toEqual([]);
  });

  it("does not reuse a consumed retry row to clear a recovery gate", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();
    const snapshot = {
      modelId: "gpt-test",
      permissionMode: "request_approval" as const,
      pluginVersions: [],
    };

    app.repositories.setConversationQueuePaused(conversation.id, true);
    app.repositories.enqueueMessage(conversation.id, "retry once");
    const interrupted = app.repositories.claimNextMessage(conversation.id, snapshot);
    if (!interrupted) {
      throw new Error("expected interrupted Turn");
    }
    app.repositories.finishTurn(interrupted.turn.id, "interrupted");
    const retry = app.repositories.enqueueInterruptedTurnRetry(
      conversation.id,
      interrupted.turn.id,
    );
    if (!retry) {
      throw new Error("expected retry message");
    }
    app.db.prepare("UPDATE queued_messages SET status = 'consumed' WHERE id = ?").run(retry.message.id);

    await expect(
      app.coordinator.retryInterruptedTurn(conversation.id, interrupted.turn.id),
    ).resolves.toBe(false);
    expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
    expect(runtime.prompts).toEqual([]);
  });

  it("does not reuse a retry row belonging to another Conversation", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const sourceConversation = app.createConversation();
    const otherConversation = app.createConversation();
    const snapshot = {
      modelId: "gpt-test",
      permissionMode: "request_approval" as const,
      pluginVersions: [],
    };

    app.repositories.setConversationQueuePaused(sourceConversation.id, true);
    app.repositories.enqueueMessage(sourceConversation.id, "retry source");
    const interrupted = app.repositories.claimNextMessage(sourceConversation.id, snapshot);
    if (!interrupted) {
      throw new Error("expected interrupted Turn");
    }
    app.repositories.finishTurn(interrupted.turn.id, "interrupted");
    const retry = app.repositories.enqueueInterruptedTurnRetry(
      sourceConversation.id,
      interrupted.turn.id,
    );
    if (!retry) {
      throw new Error("expected retry message");
    }
    app.db
      .prepare("UPDATE queued_messages SET conversation_id = ? WHERE id = ?")
      .run(otherConversation.id, retry.message.id);

    await expect(
      app.coordinator.retryInterruptedTurn(sourceConversation.id, interrupted.turn.id),
    ).resolves.toBe(false);
    expect(app.repositories.getConversation(sourceConversation.id)?.queuePaused).toBe(true);
    expect(runtime.prompts).toEqual([]);
  });

  it("keeps a committed terminal update successful when waking the next Turn fails", async () => {
    const runtime = new ControlledConnector();
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject(`/tmp/project-${randomUUID()}`, "test");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "gpt-test",
    });
    let resolutions = 0;
    const coordinator = new TurnCoordinator({
      repositories,
      connectors: { codex: runtime },
      resolvePluginVersions: () => {
        resolutions += 1;
        if (resolutions > 1) {
          throw new Error("next dispatch failed");
        }
        return [];
      },
    });

    await coordinator.enqueueMessage(conversation.id, "first");
    await coordinator.enqueueMessage(conversation.id, "second");
    const activeTurn = repositories.getActiveTurn(conversation.id);
    if (!activeTurn) {
      throw new Error("expected active Turn");
    }

    await expect(runtime.emitTerminal(activeTurn.id, "completed")).resolves.toBeUndefined();
    expect(repositories.getTurn(activeTurn.id)?.status).toBe("completed");
    expect(repositories.listQueuedMessages(conversation.id)).toEqual([
      expect.objectContaining({ content: "second" }),
    ]);
    db.close();
  });

  it("recovers unpaused pending queues without one Conversation blocking the others", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const goodConversation = app.createConversation();
    const brokenConversation = app.createConversation();
    app.repositories.enqueueMessage(goodConversation.id, "resume after restart");
    app.repositories.enqueueMessage(brokenConversation.id, "broken settings");
    const coordinator = new TurnCoordinator({
      repositories: app.repositories,
      connectors: { codex: runtime },
      resolvePluginVersions: ({ conversationId }) => {
        if (conversationId === brokenConversation.id) {
          throw new Error("broken plugin settings");
        }
        return [];
      },
    });

    await expect(coordinator.recoverPendingQueues()).resolves.toBeUndefined();

    expect(runtime.prompts).toEqual(["resume after restart"]);
    expect(app.repositories.listQueuedMessages(brokenConversation.id)).toEqual([
      expect.objectContaining({ content: "broken settings" }),
    ]);
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
