import { describe, expect, it } from "vitest";
import {
  parseAgentSettings,
  parseCreateConversation,
  parsePluginEnablements,
  parseQueueMessage,
} from "../../src/shared/validation.js";

describe("API validation", () => {
  it("accepts a supported Agent Product and rejects an unknown product", () => {
    expect(
      parseCreateConversation({
        projectId: "p1",
        agentProductId: "codex",
        modelId: "gpt-5",
      }),
    ).toMatchObject({ agentProductId: "codex" });
    expect(() =>
      parseCreateConversation({ projectId: "p1", agentProductId: "other" }),
    ).toThrow("Unsupported Agent Product");
  });

  it("rejects an empty queued message", () => {
    expect(() => parseQueueMessage({ content: "  " })).toThrow(
      "Message cannot be empty",
    );
  });

  it("rejects non-object payloads", () => {
    expect(() => parseCreateConversation(null)).toThrow(
      "Invalid create conversation payload",
    );
    expect(() => parseQueueMessage([])).toThrow(
      "Invalid queue message payload",
    );
  });

  it("rejects fields with the wrong types", () => {
    expect(() =>
      parseCreateConversation({ projectId: 1, agentProductId: "codex" }),
    ).toThrow("projectId must be a string");
    expect(() =>
      parseCreateConversation({
        projectId: "p1",
        agentProductId: "codex",
        modelId: 5,
      }),
    ).toThrow("modelId must be a string or null");
    expect(() => parseQueueMessage({ content: 1 })).toThrow(
      "content must be a string",
    );
  });

  it("rejects an empty project ID", () => {
    expect(() =>
      parseCreateConversation({ projectId: "  ", agentProductId: "codex" }),
    ).toThrow("projectId cannot be empty");
  });

  it("parses executable overrides and rejects empty paths", () => {
    expect(parseAgentSettings({ executablePath: "/opt/bin/codex" })).toEqual({
      executablePath: "/opt/bin/codex",
    });
    expect(parseAgentSettings({ executablePath: null })).toEqual({ executablePath: null });
    expect(() => parseAgentSettings({ executablePath: "  " })).toThrow(
      "executablePath cannot be empty",
    );
  });

  it("rejects duplicate plugin enablements", () => {
    expect(() =>
      parsePluginEnablements({
        pluginVersions: [
          { pluginId: "formatter", versionId: "v1" },
          { pluginId: "formatter", versionId: "v2" },
        ],
      }),
    ).toThrow("pluginId must be unique");
  });
});
