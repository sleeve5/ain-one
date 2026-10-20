import { describe, expect, it } from "vitest";
import type { GraphProject } from "../../src/shared/contracts.js";
import { autoLayoutGraph, parseGraphConfig, serializeGraphConfig } from "../../src/web/graph-config.js";

describe("portable Graph configuration", () => {
  it("exports behavior and layout without installation-owned metadata", () => {
    const config = JSON.parse(serializeGraphConfig(graphFixture())) as Record<string, unknown>;

    expect(config).toMatchObject({ formatVersion: 1, name: "Review flow", description: "Review then publish" });
    expect(config).toHaveProperty("definition");
    expect(config).toHaveProperty("positions");
    expect(config).toHaveProperty("viewport");
    expect(config).not.toHaveProperty("id");
    expect(config).not.toHaveProperty("projectId");
    expect(config).not.toHaveProperty("createdAt");
    expect(config).not.toHaveProperty("updatedAt");
  });

  it("preserves supplied positions and automatically places missing nodes", () => {
    const current = graphFixture();
    const config = JSON.parse(serializeGraphConfig(current));
    config.positions = { "input-1": { x: 25, y: 40 } };

    const parsed = parseGraphConfig(JSON.stringify(config), current);

    expect(parsed.positions["input-1"]).toEqual({ x: 25, y: 40 });
    expect(parsed.positions["agent-1"]).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
    expect(parsed.positions["output-1"]!.x).toBeGreaterThan(parsed.positions["agent-1"]!.x);
  });

  it("lays out feedback loops without pushing their target after the Loop", () => {
    const laidOut = autoLayoutGraph(graphFixture());

    expect(laidOut.positions["input-1"]!.x).toBeLessThan(laidOut.positions["agent-1"]!.x);
    expect(laidOut.positions["agent-1"]!.x).toBeLessThan(laidOut.positions["loop-1"]!.x);
    expect(laidOut.positions["loop-1"]!.x).toBeLessThan(laidOut.positions["output-1"]!.x);
    expect(laidOut.definition.edges.every((edge) => edge.route === undefined)).toBe(true);
  });

  it("rejects malformed JSON and invalid Graph drafts without changing the current Graph", () => {
    const current = graphFixture();
    expect(() => parseGraphConfig("{", current)).toThrow(/JSON/);
    expect(() => parseGraphConfig(JSON.stringify({ formatVersion: 1, name: "Broken", description: "", definition: { nodes: [] } }), current)).toThrow(/edges/);
    expect(current.name).toBe("Review flow");
  });

  it("rejects malformed portable connection routes", () => {
    const current = graphFixture();
    const config = JSON.parse(serializeGraphConfig(current));
    config.definition.edges[0].route = { x: "left", y: 20 };

    expect(() => parseGraphConfig(JSON.stringify(config), current)).toThrow(/route/);
  });
});

function graphFixture(): GraphProject {
  return {
    id: "graph-1", projectId: "project-1", name: "Review flow", description: "Review then publish",
    definition: {
      nodes: [
        { id: "input-1", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } },
        { id: "agent-1", type: "agent", name: "Agent", config: { agentProductId: "codex", modelId: "gpt-5", permissionMode: "request_approval", instruction: "Review", inputs: [{ id: "task", name: "Task" }, { id: "feedback", name: "Feedback", kind: "feedback" }], outputs: [{ id: "result", name: "Result" }] } },
        { id: "loop-1", type: "loop_counter", name: "Loop", config: { maxIterations: 3 } },
        { id: "output-1", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result" }] } },
      ],
      edges: [
        { id: "input-agent", source: "input-1", sourcePort: "task", target: "agent-1", targetPort: "task" },
        { id: "agent-loop", source: "agent-1", sourcePort: "result", target: "loop-1", targetPort: "input", route: { x: 500, y: 20 } },
        { id: "loop-agent", source: "loop-1", sourcePort: "loop", target: "agent-1", targetPort: "feedback", condition: { branch: "loop" } },
        { id: "loop-output", source: "loop-1", sourcePort: "done", target: "output-1", targetPort: "result", condition: { branch: "done" } },
      ], start: ["input-1"], end: ["output-1"],
    },
    positions: { "input-1": { x: 80, y: 180 }, "agent-1": { x: 350, y: 180 }, "loop-1": { x: 620, y: 180 }, "output-1": { x: 890, y: 180 } },
    viewport: { x: 1, y: 2, zoom: 0.8 }, archivedAt: null,
    createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z",
  };
}
