import { describe, expect, it } from "vitest";
import type { GraphDefinition } from "../../src/shared/contracts.js";
import { validateGraphDefinition, validateGraphDraft } from "../../src/shared/validation.js";

function graph(overrides: Partial<GraphDefinition> = {}): GraphDefinition {
  return {
    nodes: [
      { id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } },
      { id: "agent", type: "agent", name: "Agent", config: { agentProductId: "codex", modelId: null, permissionMode: "request_approval", instruction: "Work", inputs: [{ id: "task", name: "Task", required: true }, { id: "feedback", name: "Feedback", kind: "feedback" }], outputs: [{ id: "result", name: "Result" }] } },
      { id: "loop", type: "loop_counter", name: "Loop", config: { maxIterations: 3 } },
      { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
    ],
    edges: [
      { id: "i-a", source: "input", sourcePort: "task", target: "agent", targetPort: "task" },
      { id: "a-l", source: "agent", sourcePort: "result", target: "loop", targetPort: "input" },
      { id: "l-a", source: "loop", sourcePort: "loop", target: "agent", targetPort: "feedback", condition: { branch: "loop" } },
      { id: "l-o", source: "loop", sourcePort: "done", target: "output", targetPort: "result", condition: { branch: "done" } },
    ],
    start: ["input"], end: ["output"], ...overrides,
  };
}

describe("graph definition validation", () => {
  it.each(["literal", "template", "passthrough"])("rejects the retired %s node type in saved drafts", (type) => {
    const draft = {
      nodes: [{ id: "retired", type, name: "Retired", config: {} }],
      edges: [],
      start: [],
      end: [],
    };

    expect(validateGraphDraft(draft)).toContain(`Unsupported node type: ${type}`);
  });

  it("accepts a named-port Input to Agent to Output dataflow", () => {
    const value = {
      nodes: [
        { id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } },
        { id: "agent", type: "agent", name: "Planner", config: { agentProductId: "codex", modelId: null, permissionMode: "request_approval", instruction: "Create a plan", inputs: [{ id: "brief", name: "Brief", required: true }], outputs: [{ id: "plan", name: "Plan" }] } },
        { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
      ],
      edges: [
        { id: "input-agent", source: "input", sourcePort: "task", target: "agent", targetPort: "brief" },
        { id: "agent-output", source: "agent", sourcePort: "plan", target: "output", targetPort: "result" },
      ],
      start: ["input"], end: ["output"],
    };

    expect(validateGraphDefinition(value)).toEqual([]);
  });

  it("rejects unknown ports and multiple edges targeting one input port", () => {
    const value = {
      nodes: [
        { id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } },
        { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
      ],
      edges: [
        { id: "one", source: "input", sourcePort: "missing", target: "output", targetPort: "result" },
        { id: "two", source: "input", sourcePort: "task", target: "output", targetPort: "result" },
      ],
      start: ["input"], end: ["output"],
    };

    const errors = validateGraphDefinition(value).join(" " );
    expect(errors).toContain("unknown source port");
    expect(errors).toContain("only one incoming edge");
  });

  it("requires every dataflow edge to name both ports", () => {
    const value = graph({
      edges: graph().edges.map((edge) => edge.id === "i-a"
        ? { id: edge.id, source: edge.source, target: edge.target }
        : edge),
    });

    const errors = validateGraphDraft(value).join(" ");
    expect(errors).toContain("Edge i-a requires a source port");
    expect(errors).toContain("Edge i-a requires a target port");
  });

  it("keeps user Input as an external-only source and Output as a terminal sink", () => {
    const value = {
      nodes: [
        { id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } },
        { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
      ],
      edges: [
        { id: "backward", source: "output", sourcePort: "result", target: "input", targetPort: "task" },
      ],
      start: ["output"], end: ["input"],
    };

    const errors = validateGraphDefinition(value).join(" " );
    expect(errors).toContain("Input node cannot receive edges");
    expect(errors).toContain("Output node cannot send edges");
    expect(errors).toContain("start must be the Input node");
    expect(errors).toContain("end must be the Output node");
  });

  it("requires exactly one user Input and one Output in dataflow graphs", () => {
    const value = {
      nodes: [
        { id: "input-1", type: "input", name: "Input 1", config: { fields: [{ id: "task", name: "Task", description: "", multiline: true }] } },
        { id: "input-2", type: "input", name: "Input 2", config: { fields: [{ id: "task", name: "Task", description: "", multiline: true }] } },
        { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result" }] } },
      ],
      edges: [{ id: "edge", source: "input-1", sourcePort: "task", target: "output", targetPort: "result" }],
      start: ["input-1"], end: ["output"],
    };

    expect(validateGraphDefinition(value).join(" " )).toContain("exactly one Input node");
  });

  it("requires start and end to reference the real Input and Output nodes", () => {
    const value = {
      nodes: [
        { id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", multiline: true }] } },
        { id: "agent", type: "agent", name: "Agent", config: { agentProductId: "codex", modelId: null, permissionMode: "request_approval", instruction: "Work", inputs: [{ id: "task", name: "Task" }], outputs: [{ id: "result", name: "Result" }] } },
        { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result" }] } },
      ],
      edges: [
        { id: "one", source: "input", sourcePort: "task", target: "agent", targetPort: "task" },
        { id: "two", source: "agent", sourcePort: "result", target: "output", targetPort: "result" },
      ],
      start: ["agent"], end: ["agent"],
    };

    const errors = validateGraphDefinition(value).join(" " );
    expect(errors).toContain("start must be the Input node");
    expect(errors).toContain("end must be the Output node");
  });

  it("requires every required port to be connected and feedback to come from Loop", () => {
    const value = {
      nodes: [
        { id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } },
        { id: "agent", type: "agent", name: "Agent", config: { agentProductId: "codex", modelId: null, permissionMode: "request_approval", instruction: "Work", inputs: [{ id: "task", name: "Task", required: true }, { id: "feedback", name: "Feedback", kind: "feedback" }], outputs: [{ id: "result", name: "Result" }] } },
        { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
      ],
      edges: [
        { id: "bad-feedback", source: "input", sourcePort: "task", target: "agent", targetPort: "feedback" },
        { id: "result", source: "agent", sourcePort: "result", target: "output", targetPort: "result" },
      ],
      start: ["input"], end: ["output"],
    };

    const errors = validateGraphDefinition(value).join(" " );
    expect(errors).toContain("required input port agent:task is not connected");
    expect(errors).toContain("feedback port agent:feedback must receive a Loop branch");
  });

  it("returns draft errors instead of traversing malformed edges", () => {
    expect(validateGraphDefinition({
      nodes: [{ id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } }],
      edges: [null],
      start: ["input"],
      end: [],
    })).toContain("Every edge must be an object");
  });

  it("persists structurally valid incomplete drafts without treating them as runnable", () => {
    const draft: GraphDefinition = {
      nodes: [{ id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } }],
      edges: [], start: [], end: [],
    };

    expect(validateGraphDraft(draft)).toEqual([]);
    expect(validateGraphDefinition(draft).join(" " )).toContain("start");
  });

  it("rejects nodes that are outside the executable start-to-end path", () => {
    const value = graph({
      nodes: [...graph().nodes, { id: "orphan", type: "agent", name: "Orphan", config: { agentProductId: "codex", modelId: null, permissionMode: "request_approval", instruction: "Unused", outputs: [{ id: "result", name: "Result" }] } }],
    });

    expect(validateGraphDefinition(value).join(" " )).toContain("Orphan");
  });

  it("accepts the dataflow Graph shape with bounded loop branches", () => {
    expect(validateGraphDefinition(graph())).toEqual([]);
  });

  it.each([
    ["duplicate node", graph({ nodes: [...graph().nodes, graph().nodes[0]!] }), "unique"],
    ["unknown endpoint", graph({ edges: [{ id: "bad", source: "missing", target: "output", targetPort: "result" }] }), "unknown source"],
    ["missing start", graph({ start: [] }), "start"],
    ["invalid loop count", graph({ nodes: [{ id: "loop", type: "loop_counter", name: "Loop", config: { maxIterations: 0 } }] }), ">= 1"],
    ["missing loop exit", graph({ edges: graph().edges.filter((edge) => edge.condition?.branch !== "done") }), "Done"],
  ])("rejects %s", (_name, value, expected) => {
    expect(validateGraphDefinition(value as GraphDefinition).join(" ")).toContain(expected);
  });

  it("rejects loop branches on non-loop nodes", () => {
    const value = graph({
      edges: graph().edges.map((edge) => edge.id === "a-l"
        ? { ...edge, condition: { branch: "loop" as const } }
        : edge),
    });

    expect(validateGraphDefinition(value).join(" ")).toContain("cannot use loop branches");
  });

  it("requires Loop source ports to match their branch", () => {
    const value = graph({
      edges: graph().edges.map((edge) => edge.id === "l-a"
        ? { ...edge, sourcePort: "done" }
        : edge),
    });

    expect(validateGraphDefinition(value).join(" ")).toContain(
      "Loop Counter loop branch loop must use source port loop",
    );
  });

  it("rejects duplicate edges into the same Loop destinations", () => {
    const value = graph({
      edges: [
        ...graph().edges,
        { id: "l-a-2", source: "loop", sourcePort: "loop", target: "agent", targetPort: "feedback", condition: { branch: "loop" } },
        { id: "l-o-2", source: "loop", sourcePort: "done", target: "output", targetPort: "result", condition: { branch: "done" } },
      ],
    });

    const errors = validateGraphDefinition(value).join(" " );
    expect(errors).toContain("Input port agent:feedback allows only one incoming edge");
    expect(errors).toContain("Input port output:result allows only one incoming edge");
  });
});
