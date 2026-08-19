import { randomUUID } from "node:crypto";
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
  onTerminal: (
    conversationId: string,
    status: TerminalTurnStatus,
    error?: NormalizedError,
  ) => Promise<void>;
};

class ControlledConnector implements AgentConnector {
  readonly id = "codex" as const;
  prompts: string[] = [];
  startAttempts = 0;
  private callbacks: TurnCallbacks | null = null;
  private activeConversationId: string | null = null;
  cancelConfirmed = true;

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
    return {
      id: input.conversationId,
      nativeSessionId: input.nativeSessionId ?? `native-session-${input.conversationId}`,
    };
  }

  async startTurn(session: LiveSession, input: StartTurnInput): Promise<NativeTurn> {
    this.startAttempts += 1;
    this.prompts.push(input.content);
    this.activeConversationId = session.id;
    return { nativeTurnId: `native-turn-${this.prompts.length}` };
  }

  async completeActiveTurn(status: TerminalTurnStatus = "completed"): Promise<void> {
    if (!this.callbacks || !this.activeConversationId) {
      throw new Error("No active Turn to complete");
    }
    const activeConversationId = this.activeConversationId;
    this.activeConversationId = null;
    await this.callbacks.onTerminal(activeConversationId, status);
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
    _nativeTurnId: string | null,
  ): Promise<CancelResult> {
    if (this.cancelConfirmed) {
      this.activeConversationId = null;
    }
    return { confirmed: this.cancelConfirmed && this.activeConversationId !== session.id };
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
  override async startTurn(): Promise<NativeTurn> {
    this.startAttempts += 1;
    const error = new Error("native start outcome unknown");
    throw error;
  }
}

class DefiniteRejectConnector extends ControlledConnector {
  override async startTurn(): Promise<NativeTurn> {
    this.startAttempts += 1;
    const error = new Error("native start rejected") as Error & {
      definiteStartRejection?: boolean;
    };
    error.definiteStartRejection = true;
    throw error;
  }
}

function createTestCoordinator(connector: ControlledConnector): {
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
    expect(app.repositories.listQueuedMessages(conversation.id)).toHaveLength(1);

    await runtime.completeActiveTurn();

    expect(runtime.prompts).toEqual(["first", "second"]);
  });

  it("pauses the queue after an interrupted Turn from unknown start outcome", async () => {
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

  it("requeues after definite start rejection and pauses automatic dispatch", async () => {
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

  it("does not release FIFO after failed Turn", async () => {
    const runtime = new ControlledConnector();
    const app = createTestCoordinator(runtime);
    const conversation = app.createConversation();

    await app.coordinator.enqueueMessage(conversation.id, "first");
    await app.coordinator.enqueueMessage(conversation.id, "second");
    await runtime.completeActiveTurn("failed");

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
});
