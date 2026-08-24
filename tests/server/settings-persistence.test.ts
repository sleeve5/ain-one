import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/db.js";
import { createRepositories } from "../../src/server/repositories.js";

describe("durable conversation settings", () => {
  it("resolves plugin scope precedence and blocks changes during an active Turn", () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject(`/tmp/project-${randomUUID()}`, "test");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "old-model",
    });

    repositories.setPluginEnablements({ type: "global" }, [
      { pluginId: "formatter", versionId: "global" },
    ]);
    repositories.setPluginEnablements({ type: "project", id: project.id }, [
      { pluginId: "formatter", versionId: "project" },
      { pluginId: "lint", versionId: "project" },
    ]);

    expect(
      repositories.updateConversationSettings(conversation.id, {
        modelId: "new-model",
        permissionMode: "full_access",
      }),
    ).toBe("updated");
    expect(repositories.getConversation(conversation.id)).toMatchObject({
      agentProductId: "codex",
      modelId: "new-model",
      permissionMode: "full_access",
    });
    expect(repositories.resolvePluginVersions(project.id, conversation.id)).toEqual([
      { pluginId: "formatter", versionId: "project" },
      { pluginId: "lint", versionId: "project" },
    ]);

    repositories.setPluginEnablements({ type: "conversation", id: conversation.id }, [
      { pluginId: "lint", versionId: "project" },
    ]);
    expect(repositories.resolvePluginVersions(project.id, conversation.id)).toEqual([
      { pluginId: "lint", versionId: "project" },
    ]);

    repositories.enqueueMessage(conversation.id, "active");
    const claimed = repositories.claimNextMessage(conversation.id, {
      modelId: "new-model",
      permissionMode: "full_access",
      pluginVersions: [],
    });
    expect(claimed).not.toBeNull();

    expect(
      repositories.updateConversationSettings(conversation.id, {
        modelId: "forbidden-model",
        permissionMode: "request_approval",
      }),
    ).toBe("turn_active");
    expect(repositories.getConversation(conversation.id)?.modelId).toBe("new-model");
    db.close();
  });

  it("persists Agent executable overrides and exposes exact plugin scopes", () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject(`/tmp/project-${randomUUID()}`, "test");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: null,
    });

    repositories.setAgentExecutablePath("codex", "/opt/bin/codex");
    repositories.setPluginEnablements({ type: "global" }, [
      { pluginId: "formatter", versionId: "v1" },
    ]);
    repositories.setPluginEnablements({ type: "conversation", id: conversation.id }, [
      { pluginId: "lint", versionId: "v2" },
    ]);

    expect(repositories.getAgentExecutablePaths()).toEqual({ codex: "/opt/bin/codex" });
    expect(repositories.listPluginEnablements({ type: "global" })).toEqual([
      { pluginId: "formatter", versionId: "v1" },
    ]);
    expect(
      repositories.listPluginEnablements({ type: "conversation", id: conversation.id }),
    ).toEqual([{ pluginId: "lint", versionId: "v2" }]);

    repositories.setAgentExecutablePath("codex", null);
    expect(repositories.getAgentExecutablePaths()).toEqual({});
    db.close();
  });
});
