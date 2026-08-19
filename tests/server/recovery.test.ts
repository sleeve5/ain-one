import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/db.js";
import { createRepositories } from "../../src/server/repositories.js";
import { TurnCoordinator } from "../../src/server/turn-coordinator.js";

function createRecoveryFixture() {
  const db = createDatabase(":memory:");
  const repositories = createRepositories(db);
  const coordinator = new TurnCoordinator({
    repositories,
    connectors: {},
  });

  const project = repositories.createProject(`/tmp/project-${randomUUID()}`, "test");
  const conversation = repositories.createConversation({
    projectId: project.id,
    agentProductId: "codex",
    modelId: "gpt-test",
  });

  return { repositories, coordinator, conversation };
}

describe("startup recovery", () => {
  it("marks starting/running/cancelling Turns as interrupted and pauses queue", async () => {
    const { repositories, coordinator, conversation } = createRecoveryFixture();
    const snapshot = {
      modelId: "gpt-test",
      permissionMode: "request_approval" as const,
      pluginVersions: [],
    };

    repositories.enqueueMessage(conversation.id, "first");
    const claim = repositories.claimNextMessage(conversation.id, snapshot);
    if (!claim) {
      throw new Error("expected a claimed message");
    }
    repositories.markTurnRunning(claim.turn.id, "native-1");

    await coordinator.recoverInterruptedTurns();

    expect(repositories.getActiveTurn(conversation.id)).toBeNull();
    expect(repositories.getLatestTurn(conversation.id)?.status).toBe("interrupted");
    expect(repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
  });

  it("keeps getActiveTurn non-terminal and recovers the currently active work", async () => {
    const { repositories, coordinator, conversation } = createRecoveryFixture();
    const snapshot = {
      modelId: "gpt-test",
      permissionMode: "request_approval" as const,
      pluginVersions: [],
    };

    repositories.enqueueMessage(conversation.id, "old uncertain");
    const first = repositories.claimNextMessage(conversation.id, snapshot);
    if (!first) {
      throw new Error("expected first claimed message");
    }
    repositories.finishTurn(first.turn.id, "interrupted");
    repositories.setConversationQueuePaused(conversation.id, false);

    repositories.enqueueMessage(conversation.id, "current active");
    const second = repositories.claimNextMessage(conversation.id, snapshot);
    if (!second) {
      throw new Error("expected second claimed message");
    }
    repositories.markTurnRunning(second.turn.id, "native-2");

    expect(repositories.getActiveTurn(conversation.id)?.id).toBe(second.turn.id);

    await coordinator.recoverInterruptedTurns();

    expect(repositories.getActiveTurn(conversation.id)).toBeNull();
    expect(repositories.getTurn(first.turn.id)?.status).toBe("interrupted");
    expect(repositories.getTurn(second.turn.id)?.status).toBe("interrupted");
    expect(repositories.getLatestTurn(conversation.id)?.id).toBe(second.turn.id);
  });
});
