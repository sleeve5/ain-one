import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/db.js";
import { createRepositories } from "../../src/server/repositories.js";

describe("project and conversation management", () => {
  it("renames, archives, restores, and forks conversations", () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject("/tmp/management", "Management");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "gpt-5",
      permissionMode: "request_approval",
    });

    expect(conversation.title).toBeNull();
    repositories.enqueueMessage(conversation.id, "  Review the workspace architecture and propose fixes  ");
    expect(repositories.getConversation(conversation.id)?.title).toBe(
      "Review the workspace architecture and propose fixes",
    );

    expect(repositories.renameConversation(conversation.id, "Frontend review")).toBe("updated");
    const fork = repositories.forkConversation(conversation.id);
    expect(fork).toMatchObject({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "gpt-5",
      permissionMode: "request_approval",
      title: "Frontend review (branch)",
    });

    expect(repositories.archiveConversation(conversation.id, true)).toBe("updated");
    expect(repositories.listConversations(project.id)).toEqual([expect.objectContaining({ id: fork?.id })]);
    expect(repositories.listConversations(project.id, true)).toEqual([
      expect.objectContaining({ id: conversation.id, archivedAt: expect.any(String) }),
    ]);
    expect(repositories.archiveConversation(conversation.id, false)).toBe("updated");
    expect(repositories.listConversations(project.id).map((item) => item.id)).toContain(conversation.id);
    db.close();
  });

  it("does not restore or fork a Conversation that uses a retired Agent", () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject("/tmp/retired-agent", "Retired Agent");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "opencode" as never,
      modelId: "legacy-model",
    });

    expect(repositories.archiveConversation(conversation.id, true)).toBe("updated");
    expect(repositories.archiveConversation(conversation.id, false)).toBe("agent_unsupported");
    expect(repositories.forkConversation(conversation.id)).toBeNull();
    expect(repositories.getConversation(conversation.id)).toMatchObject({
      archivedAt: expect.any(String),
      agentProductId: "opencode",
    });
    db.close();
  });

  it("permanently deletes only archived conversations and their related state", () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject("/tmp/delete-archived", "Delete archived");
    const conversation = repositories.createConversation({ projectId: project.id, agentProductId: "codex", modelId: null });
    repositories.enqueueMessage(conversation.id, "saved message");
    repositories.setPluginEnablements({ type: "conversation", id: conversation.id }, [{ pluginId: "reviewer", versionId: "v1" }]);

    expect(repositories.deleteArchivedConversation(conversation.id)).toBe("not_archived");
    repositories.archiveConversation(conversation.id, true);
    expect(repositories.deleteArchivedConversation(conversation.id)).toBe("deleted");
    expect(repositories.getConversation(conversation.id)).toBeNull();
    expect(repositories.listPluginEnablements({ type: "conversation", id: conversation.id })).toEqual([]);
    db.close();
  });

  it("does not archive a Conversation or Project while a Turn is active", () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject("/tmp/archive-active", "Archive active");
    const conversation = repositories.createConversation({
      projectId: project.id, agentProductId: "codex", modelId: null,
    });
    repositories.enqueueMessage(conversation.id, "still running");
    repositories.claimNextMessage(conversation.id, {
      modelId: null, permissionMode: "request_approval", pluginVersions: [],
    });

    expect(repositories.archiveConversation(conversation.id, true)).toBe("turn_active");
    expect(repositories.archiveProject(project.id, true)).toBe("turn_active");
    expect(repositories.getConversation(conversation.id)?.archivedAt).toBeNull();
    expect(repositories.getProject(project.id)?.archivedAt).toBeNull();
    db.close();
  });

  it("forks persisted history without copying an in-flight queue", () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject("/tmp/fork-history", "Fork history");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "gpt-5",
    });
    repositories.enqueueMessage(conversation.id, "first turn");
    repositories.setPluginEnablements({ type: "conversation", id: conversation.id }, [
      { pluginId: "reviewer", versionId: "v1" },
    ]);
    const firstTurn = repositories.claimNextMessage(conversation.id, {
      modelId: "gpt-5",
      permissionMode: "request_approval",
      pluginVersions: [],
    })!;
    repositories.markTurnRunning(firstTurn.turn.id, null);
    const answer = repositories.appendEvent(conversation.id, {
      type: "assistant_message",
      payload: { text: "first answer", role: "assistant" },
    });
    repositories.finishTurn(firstTurn.turn.id, "completed");
    repositories.enqueueMessage(conversation.id, "still queued");

    const fork = repositories.forkConversation(conversation.id)!;

    expect(repositories.eventsAfter(fork.id, 0).map((event) => event.type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    expect(repositories.eventsAfter(fork.id, 0)[1]?.createdAt).toBe(answer.createdAt);
    expect(repositories.listPluginEnablements({ type: "conversation", id: fork.id })).toEqual([
      { pluginId: "reviewer", versionId: "v1" },
    ]);
    expect(repositories.listQueuedMessages(fork.id)).toEqual([]);
    db.close();
  });

  it("truncates automatic titles without splitting emoji surrogate pairs", () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject("/tmp/unicode-title", "Unicode title");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: null,
    });

    repositories.enqueueMessage(conversation.id, `${"a".repeat(56)}😀bbbb`);

    expect(repositories.getConversation(conversation.id)?.title).toBe(`${"a".repeat(56)}😀…`);
    db.close();
  });

  it("renames, archives, and restores projects without deleting their conversations", () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject("/tmp/project-management", "Old name");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: null,
    });

    expect(repositories.renameProject(project.id, "New name")).toBe("updated");
    expect(repositories.archiveProject(project.id, true)).toBe("updated");
    expect(repositories.listProjects()).toEqual([]);
    expect(repositories.listProjects(true)).toEqual([
      expect.objectContaining({ id: project.id, name: "New name", archivedAt: expect.any(String) }),
    ]);
    expect(repositories.getConversation(conversation.id)).not.toBeNull();
    expect(repositories.archiveProject(project.id, false)).toBe("updated");
    expect(repositories.listProjects()).toEqual([expect.objectContaining({ id: project.id })]);
    db.close();
  });

  it("permanently deletes only archived projects and all client-side conversation state", () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject("/tmp/delete-project-client-only", "Delete project");
    const conversation = repositories.createConversation({
      projectId: project.id, agentProductId: "codex", modelId: null,
    });
    repositories.enqueueMessage(conversation.id, "saved message");
    repositories.setPluginEnablements({ type: "project", id: project.id }, [{ pluginId: "reviewer", versionId: "v1" }]);
    repositories.setPluginEnablements({ type: "conversation", id: conversation.id }, [{ pluginId: "reviewer", versionId: "v1" }]);

    expect(repositories.deleteArchivedProject(project.id)).toBe("not_archived");
    repositories.archiveProject(project.id, true);
    expect(repositories.deleteArchivedProject(project.id)).toBe("deleted");
    expect(repositories.getProject(project.id)).toBeNull();
    expect(repositories.getConversation(conversation.id)).toBeNull();
    expect(repositories.listPluginEnablements({ type: "project", id: project.id })).toEqual([]);
    expect(repositories.listPluginEnablements({ type: "conversation", id: conversation.id })).toEqual([]);
    db.close();
  });

  it("persists Agent enablement independently from executable path overrides", () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);

    expect(repositories.isAgentEnabled("codex")).toBe(true);
    repositories.setAgentEnabled("codex", false);
    expect(repositories.isAgentEnabled("codex")).toBe(false);
    expect(repositories.getAgentExecutablePaths().codex).toBeUndefined();
    repositories.setAgentEnabled("codex", true);
    expect(repositories.isAgentEnabled("codex")).toBe(true);
    db.close();
  });
});
