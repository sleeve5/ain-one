import { describe, expect, it } from "vitest";
import {
  parseCreateConversation,
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
});
