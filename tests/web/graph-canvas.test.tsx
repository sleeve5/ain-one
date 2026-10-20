import { fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphProject, GraphRun } from "../../src/shared/contracts.js";
import type { AinOneApi, AgentSettingsView } from "../../src/web/api.js";
import { GraphCanvas } from "../../src/web/components/graph-canvas.js";
import * as graphCanvasModule from "../../src/web/components/graph-canvas.js";

describe("zero-code Graph canvas", () => {
  it("offers only user Input, Agent, Loop, and Output nodes", async () => {
    render(<GraphCanvas api={graphApi()} graphId="g1" agents={agents} language="en" />);

    expect(await screen.findByRole("button", { name: "Add Input" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add Agent" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add Loop" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add Output" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Literal|Template|Pass-through/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Start")).not.toBeInTheDocument();
    expect(screen.queryByText("End")).not.toBeInTheDocument();
  });

  it("supports select-all, copy, paste, cut, and delete without hijacking text fields", async () => {
    const api = graphApi();
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);
    await screen.findByText("Agent 1");

    fireEvent.keyDown(window, { key: "a", metaKey: true });
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    fireEvent.keyDown(window, { key: "v", metaKey: true });
    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ name: "Agent 1 copy" })]) }),
    })), { timeout: 1_500 });

    fireEvent.keyDown(window, { key: "x", metaKey: true });
    fireEvent.keyDown(window, { key: "Backspace" });
    const input = screen.getByLabelText("Task");
    fireEvent.keyDown(input, { key: "a", metaKey: true });
    expect(input).toBeInTheDocument();
  });

  it("keeps a multi-selection after selecting several nodes and deletes it as one selection", async () => {
    const api = graphApi();
    const { container } = render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);
    const agent = await screen.findByText("Agent 1");
    const loop = screen.getByText("Loop Counter 1");

    fireEvent.click(agent);
    fireEvent.keyDown(window, { key: "Control" });
    fireEvent.click(loop);
    fireEvent.keyUp(window, { key: "Control" });

    expect(agent.closest(".graph-node")).toHaveAttribute("data-selected", "true");
    expect(loop.closest(".graph-node")).toHaveAttribute("data-selected", "true");

    fireEvent.keyDown(window, { key: "Delete" });
    await vi.waitFor(() => expect(container.querySelectorAll(".graph-node")).toHaveLength(2));
  });

  it("keeps port ids and existing connections stable when a port is renamed", async () => {
    const api = graphApi();
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    fireEvent.click(await screen.findByText("Agent 1"));
    fireEvent.change(screen.getByLabelText("Input ports 1"), { target: { value: "Renamed task" } });

    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalled(), { timeout: 1_500 });
    const saved = vi.mocked(api.saveGraph).mock.calls.at(-1)?.[0] as GraphProject;
    const agent = saved.definition.nodes.find((node) => node.id === "agent-1");
    expect(agent?.type === "agent" ? agent.config.inputs?.[0] : null).toMatchObject({ id: "task", name: "Renamed task" });
    expect(saved.definition.edges.find((edge) => edge.id === "input-agent")?.targetPort).toBe("task");
  });

  it("renders stable input references as named chips without exposing serialization syntax", async () => {
    const api = graphApi();
    const { container } = render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    fireEvent.click(await screen.findByText("Agent 1"));
    const instruction = screen.getByLabelText("Instruction");
    fireEvent.click(screen.getByRole("button", { name: "Insert Task parameter" }));

    expect(instruction).toHaveTextContent("Complete the task.Task");
    expect(instruction).not.toHaveTextContent("{{task}}");
    expect(within(instruction).getByText("Task")).toHaveAttribute("data-parameter-id", "task");
    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalled(), { timeout: 1_500 });
    const saved = vi.mocked(api.saveGraph).mock.calls.at(-1)?.[0] as GraphProject;
    const agent = saved.definition.nodes.find((node) => node.id === "agent-1");
    expect(agent?.type === "agent" ? agent.config.instruction : null).toBe("Complete the task.{{task}}");
    expect(container.querySelector(".graph-ports-editor")?.tagName).toBe("SECTION");
    expect(container.querySelector(".graph-port-type")).toBeNull();
  });

  it("inserts a parameter chip at the caret and removes it with Backspace", async () => {
    const api = graphApi();
    const graph = (await api.getGraph("g1")).graph;
    graph.definition.nodes = graph.definition.nodes.map((node) => node.id === "agent-1" && node.type === "agent"
      ? { ...node, config: { ...node.config, instruction: "Before after" } } : node);
    api.getGraph = vi.fn(async () => ({ graph, latestRun: null }));
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    fireEvent.click(await screen.findByText("Agent 1"));
    const editor = screen.getByLabelText("Instruction");
    const text = editor.firstChild?.firstChild ?? editor.firstChild;
    const range = document.createRange();
    range.setStart(text!, 7); range.collapse(true);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Insert Task parameter" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert Task parameter" }));

    expect(editor.textContent).toBe("Before Taskafter");
    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalled(), { timeout: 1_500 });
    let saved = vi.mocked(api.saveGraph).mock.calls.at(-1)?.[0] as GraphProject;
    let agent = saved.definition.nodes.find((node) => node.id === "agent-1");
    expect(agent?.type === "agent" ? agent.config.instruction : null).toBe("Before {{task}}after");

    const trailingText = editor.lastChild?.firstChild ?? editor.lastChild;
    const deleteRange = document.createRange();
    deleteRange.setStart(trailingText!, 0); deleteRange.collapse(true); selection.removeAllRanges(); selection.addRange(deleteRange);
    const event = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    editor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => {
      saved = vi.mocked(api.saveGraph).mock.calls.at(-1)?.[0] as GraphProject;
      agent = saved.definition.nodes.find((node) => node.id === "agent-1");
      expect(agent?.type === "agent" ? agent.config.instruction : null).toBe("Before after");
    }, { timeout: 1_500 });
  });

  it("places Agent ports before the instruction and names newly added ports by direction", async () => {
    const user = userEvent.setup();
    render(<GraphCanvas api={graphApi()} graphId="g1" agents={agents} language="en" />);
    fireEvent.click(await screen.findByText("Agent 1"));

    const inputHeading = screen.getByText("Input ports");
    const outputHeading = screen.getByText("Output ports");
    const instruction = screen.getByText("Instruction", { selector: "label" });
    expect(inputHeading.compareDocumentPosition(instruction) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(outputHeading.compareDocumentPosition(instruction) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add Input ports" }));
    await user.click(screen.getByRole("button", { name: "Add Output ports" }));
    expect(screen.getByDisplayValue("input3")).toBeVisible();
    expect(screen.getByDisplayValue("output2")).toBeVisible();
  });

  it("keeps parameter chips linked to stable ids after a port is renamed", async () => {
    const api = graphApi();
    const graph = (await api.getGraph("g1")).graph;
    graph.definition.nodes = graph.definition.nodes.map((node) => node.id === "agent-1" && node.type === "agent"
      ? { ...node, config: { ...node.config, instruction: "Use {{task}}." } } : node);
    api.getGraph = vi.fn(async () => ({ graph, latestRun: null }));
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    fireEvent.click(await screen.findByText("Agent 1"));
    expect(within(screen.getByLabelText("Instruction")).getByText("Task")).toHaveAttribute("data-parameter-id", "task");
    fireEvent.change(screen.getByLabelText("Input ports 1"), { target: { value: "Request" } });
    expect(within(screen.getByLabelText("Instruction")).getByText("Request")).toHaveAttribute("data-parameter-id", "task");
  });

  it("does not expose an unknown internal parameter id", async () => {
    const api = graphApi();
    const graph = (await api.getGraph("g1")).graph;
    graph.definition.nodes = graph.definition.nodes.map((node) => node.id === "agent-1" && node.type === "agent"
      ? { ...node, config: { ...node.config, instruction: "Use {{removed_port_id}}." } } : node);
    api.getGraph = vi.fn(async () => ({ graph, latestRun: null }));
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    fireEvent.click(await screen.findByText("Agent 1"));
    expect(screen.getByLabelText("Instruction")).toHaveTextContent("Use Unknown parameter.");
    expect(screen.getByLabelText("Instruction")).not.toHaveTextContent("removed_port_id");
  });

  it("removes connected edges and parameter tokens when an Agent input port is deleted", async () => {
    const api = graphApi();
    const graph = (await api.getGraph("g1")).graph;
    graph.definition.nodes = graph.definition.nodes.map((node) => node.id === "agent-1" && node.type === "agent"
      ? { ...node, config: { ...node.config, instruction: "Use {{task}} and {{feedback}}." } } : node);
    api.getGraph = vi.fn(async () => ({ graph, latestRun: null }));
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    fireEvent.click(await screen.findByText("Agent 1"));
    fireEvent.click(screen.getByRole("button", { name: "Remove Feedback" }));
    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalled(), { timeout: 1_500 });
    const saved = vi.mocked(api.saveGraph).mock.calls.at(-1)?.[0] as GraphProject;
    const agent = saved.definition.nodes.find((node) => node.id === "agent-1");
    expect(agent?.type === "agent" ? agent.config.instruction : null).toBe("Use {{task}} and .");
    expect(saved.definition.edges.some((edge) => edge.target === "agent-1" && edge.targetPort === "feedback")).toBe(false);
  });

  it("repairs uniquely inferable stale ports and removes duplicate incoming edges", async () => {
    const api = graphApi();
    const stale = (await api.getGraph("g1")).graph;
    stale.definition.nodes = stale.definition.nodes.map((node) => node.id !== "agent-1" || node.type !== "agent" ? node : ({
      ...node,
      config: { ...node.config, inputs: [{ id: "renamed_task", name: "Renamed task", required: true }, { id: "loop_input", name: "Loop input", kind: "feedback" }] },
    }));
    stale.definition.edges = [
      { id: "old-input", source: "input-1", sourcePort: "task", target: "agent-1", targetPort: "task" },
      { id: "new-input", source: "input-1", sourcePort: "task", target: "agent-1", targetPort: "task" },
      { id: "loop-feedback", source: "loop-1", sourcePort: "loop", target: "agent-1", targetPort: "task", condition: { branch: "loop" } },
      { id: "agent-loop", source: "agent-1", sourcePort: "result", target: "loop-1", targetPort: "input" },
      { id: "loop-output", source: "loop-1", sourcePort: "done", target: "output-1", targetPort: "result", condition: { branch: "done" } },
    ];
    api.getGraph = vi.fn(async () => ({ graph: stale, latestRun: null }));

    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalled(), { timeout: 1_500 });
    const saved = vi.mocked(api.saveGraph).mock.calls.at(-1)?.[0] as GraphProject;
    expect(saved.definition.edges.filter((edge) => edge.target === "agent-1")).toEqual([
      expect.objectContaining({ id: "new-input", targetPort: "renamed_task" }),
      expect.objectContaining({ id: "loop-feedback", targetPort: "loop_input" }),
    ]);
  });

  it("renders Loop input on the left and Done then Loop outputs on the right", async () => {
    render(<GraphCanvas api={graphApi()} graphId="g1" agents={agents} language="en" />);

    const loop = await screen.findByTestId("rf__node-loop-1");
    expect(loop.querySelector(".graph-node__port--input .react-flow__handle-left")).toBeInTheDocument();
    expect(loop.querySelectorAll(".graph-node__port--output .react-flow__handle-right")).toHaveLength(2);
    expect([...loop.querySelectorAll(".graph-node__port--output span")].map((item) => item.textContent)).toEqual(["Done", "Loop"]);
    expect(loop.querySelector(".graph-node__port--input")).toHaveTextContent("Content");
    expect(loop.querySelector(".graph-node__port--input")).not.toHaveTextContent("Input");
  });

  it("keeps the Output connection handle without repeating an Output label", async () => {
    render(<GraphCanvas api={graphApi()} graphId="g1" agents={agents} language="en" />);

    const output = await screen.findByTestId("rf__node-output-1");
    expect(output.querySelector(".react-flow__handle")).toBeInTheDocument();
    expect(output.querySelector(".graph-node__port span")).toBeNull();
  });

  it("keeps the automatic Agent input target invisible and infers feedback from Loop connections", async () => {
    render(<GraphCanvas api={graphApi()} graphId="g1" agents={agents} language="en" />);

    const agent = await screen.findByTestId("rf__node-agent-1");
    expect(within(agent).queryByText("＋")).not.toBeInTheDocument();
    expect(within(agent).queryByLabelText("Connect new input")).not.toBeInTheDocument();
    expect(agent.querySelector('[data-handleid="__new_input"]')).toBeInTheDocument();
    fireEvent.click(await screen.findByText("Agent 1"));
    expect(screen.queryByRole("combobox", { name: /Task type|Feedback type/ })).toBeNull();
    expect(screen.queryByText("Loop input")).toBeNull();
  });

  it("creates a new Agent input instead of replacing an occupied connection", async () => {
    const graph = (await graphApi().getGraph("g1")).graph;
    const connect = (graphCanvasModule as unknown as { connect: (value: GraphProject, connection: { source: string; sourceHandle: string; target: string; targetHandle: string }) => GraphProject }).connect;

    const connected = connect(graph, { source: "loop-1", sourceHandle: "done", target: "agent-1", targetHandle: "task" });
    const target = connected.definition.nodes.find((node) => node.id === "agent-1");
    const added = target?.type === "agent" ? target.config.inputs?.find((port) => !["task", "feedback"].includes(port.id)) : null;

    expect(connected.definition.edges).toContainEqual(expect.objectContaining({ id: "input-agent", targetPort: "task" }));
    expect(added).toMatchObject({ name: "input3", kind: "input", required: true });
    expect(connected.definition.edges).toContainEqual(expect.objectContaining({ source: "loop-1", sourcePort: "done", target: "agent-1", targetPort: added?.id }));
  });

  it("renders a routed connection as a rounded orthogonal line", () => {
    const roundedOrthogonalPath = (graphCanvasModule as unknown as {
      roundedOrthogonalPath(input: { sourceX: number; sourceY: number; targetX: number; targetY: number; route: { x: number; y: number } }): string;
    }).roundedOrthogonalPath;

    const path = roundedOrthogonalPath({ sourceX: 0, sourceY: 10, targetX: 300, targetY: 90, route: { x: 120, y: 160 } });

    expect(path).toContain("Q");
    expect(path).toContain("L");
    expect(path).not.toContain("C");
    expect(path).toContain("120 160");
  });

  it.each([
    { sourceX: 0, sourceY: 100, targetX: 300, targetY: 20.000004, route: { x: 120, y: 20, targetX: 240 } },
    { sourceX: 0, sourceY: 20, targetX: 300, targetY: 100.000004, route: { x: 120, y: 100, targetX: 240 } },
    { sourceX: 300, sourceY: 100, targetX: 0, targetY: 20.000004, route: { x: 240, y: 20, targetX: 60 } },
    { sourceX: 300, sourceY: 20, targetX: 0, targetY: 100.000004, route: { x: 240, y: 100, targetX: 60 } },
  ])("rounds every meaningful corner without subpixel spikes: $sourceX,$sourceY → $targetX,$targetY", (input) => {
    const roundedOrthogonalPath = (graphCanvasModule as unknown as {
      roundedOrthogonalPath(value: typeof input): string;
    }).roundedOrthogonalPath;

    const path = roundedOrthogonalPath(input);

    expect(path.match(/ Q /g)).toHaveLength(2);
  });

  it("removes a collinear reversal instead of drawing a directional spike", () => {
    const roundedOrthogonalPath = (graphCanvasModule as unknown as {
      roundedOrthogonalPath(input: { sourceX: number; sourceY: number; targetX: number; targetY: number; route: { x: number; y: number; targetX: number } }): string;
    }).roundedOrthogonalPath;

    const path = roundedOrthogonalPath({ sourceX: 0, sourceY: 20, targetX: 300, targetY: 100, route: { x: 340, y: 20, targetX: 240 } });

    expect(path).not.toContain("340");
  });

  it("hides the Done branch label while preserving the Loop label", () => {
    const graphEdgeLabel = (graphCanvasModule as unknown as {
      graphEdgeLabel(edge: { condition?: { branch: "loop" | "done" } }): string | undefined;
    }).graphEdgeLabel;

    expect(graphEdgeLabel({ condition: { branch: "loop" } })).toBe("loop");
    expect(graphEdgeLabel({ condition: { branch: "done" } })).toBeUndefined();
  });

  it("ends connections at the outside of the target handle with an inward arrow", () => {
    const edgeTargetGeometry = (graphCanvasModule as unknown as {
      edgeTargetGeometry(input: { x: number; y: number; position: "left" | "right" | "top" | "bottom" }): { x: number; y: number; arrow: string };
    }).edgeTargetGeometry;

    expect(edgeTargetGeometry({ x: 300, y: 90, position: "left" })).toEqual({
      pathX: 292,
      pathY: 90,
      arrow: "M 300 90 L 292 85 L 292 95 Z",
    });
    expect(edgeTargetGeometry({ x: 300, y: 90, position: "top" })).toEqual({
      pathX: 300,
      pathY: 82,
      arrow: "M 300 90 L 295 82 L 305 82 Z",
    });
  });

  it("keeps aligned automatic connections perfectly straight", () => {
    const automaticOrthogonalPath = (graphCanvasModule as unknown as {
      automaticOrthogonalPath(input: { sourceX: number; sourceY: number; targetX: number; targetY: number }): string;
    }).automaticOrthogonalPath;

    expect(automaticOrthogonalPath({ sourceX: 176, sourceY: 69, targetX: 280, targetY: 69 })).toBe("M 176 69 L 280 69");
  });

  it("routes Loop feedback outside every intervening node", () => {
    const fixture = graphFixture("g-route", "Route");
    fixture.definition = {
      nodes: [
        { id: "agent", type: "agent", name: "Agent", config: { agentProductId: "codex", modelId: null, permissionMode: "request_approval", instruction: "", inputs: [{ id: "feedback", name: "Feedback", kind: "feedback" }], outputs: [{ id: "result", name: "Result" }] } },
        { id: "loop", type: "loop_counter", name: "Loop", config: { maxIterations: 3 } },
      ],
      edges: [{ id: "feedback", source: "loop", sourcePort: "loop", target: "agent", targetPort: "feedback", condition: { branch: "loop" } }],
      start: ["agent"], end: [],
    };
    fixture.positions = { agent: { x: 80, y: 100 }, loop: { x: 360, y: 100 } };
    const automaticEdgeRoute = (graphCanvasModule as unknown as {
      automaticEdgeRoute(value: GraphProject, edgeId: string): { x: number; y: number; targetX?: number } | undefined;
    }).automaticEdgeRoute;

    const route = automaticEdgeRoute(fixture, "feedback")!;
    expect(route.x).toBeGreaterThan(360 + 176);
    expect(route.targetX).toBeLessThan(80);
    expect(route.y).toBeGreaterThan(100 + 100);
  });

  it("keeps a manually dragged Loop route outside the source and target cards", () => {
    const normalizeRoute = (graphCanvasModule as unknown as {
      normalizeRoute(route: { x: number; y: number; targetX?: number }, sourceX: number, sourceY: number, targetX: number, targetY: number): { x: number; y: number; targetX?: number };
    }).normalizeRoute;

    expect(normalizeRoute({ x: 804, y: 252, targetX: 403 }, 816, 188, 352, 188)).toEqual({
      x: 848,
      y: 252,
      targetX: 328,
    });
  });

  it("gives non-aligned forward connections separate gap lanes", () => {
    const fixture = graphFixture("g-lanes", "Lanes");
    fixture.definition = {
      nodes: [
        { id: "a", type: "input", name: "A", config: { fields: [{ id: "out", name: "Out", description: "", multiline: false }] } },
        { id: "b", type: "input", name: "B", config: { fields: [{ id: "out", name: "Out", description: "", multiline: false }] } },
        { id: "c", type: "output", name: "C", config: { fields: [{ id: "in", name: "In" }] } },
        { id: "d", type: "output", name: "D", config: { fields: [{ id: "in", name: "In" }] } },
      ],
      edges: [
        { id: "a-d", source: "a", sourcePort: "out", target: "d", targetPort: "in" },
        { id: "b-c", source: "b", sourcePort: "out", target: "c", targetPort: "in" },
      ], start: ["a", "b"], end: ["c", "d"],
    };
    fixture.positions = { a: { x: 0, y: 0 }, b: { x: 0, y: 140 }, c: { x: 280, y: 0 }, d: { x: 280, y: 140 } };
    const automaticEdgeRoute = (graphCanvasModule as unknown as { automaticEdgeRoute(value: GraphProject, edgeId: string): { x: number; y: number; targetX?: number } | undefined }).automaticEdgeRoute;

    const first = automaticEdgeRoute(fixture, "a-d")!;
    const second = automaticEdgeRoute(fixture, "b-c")!;
    expect(first.x).not.toBe(second.x);
    expect(first.targetX).toBe(first.x);
    expect(second.targetX).toBe(second.x);
    expect(first.x).toBeGreaterThan(176);
    expect(first.x).toBeLessThan(280);
  });

  it("routes a forward connection below nodes that occupy its middle lane", () => {
    const fixture = graphFixture("g-obstacle", "Obstacle");
    fixture.definition = {
      nodes: [
        { id: "source", type: "input", name: "Source", config: { fields: [{ id: "out", name: "Out", description: "", multiline: false }] } },
        { id: "blocker", type: "agent", name: "Blocker", config: { agentProductId: "codex", modelId: null, permissionMode: "request_approval", instruction: "", inputs: [], outputs: [] } },
        { id: "target", type: "output", name: "Target", config: { fields: [{ id: "in", name: "In" }] } },
      ],
      edges: [{ id: "skip", source: "source", sourcePort: "out", target: "target", targetPort: "in" }],
      start: ["source"], end: ["target"],
    };
    fixture.positions = { source: { x: 0, y: 0 }, blocker: { x: 280, y: 0 }, target: { x: 560, y: 0 } };
    const automaticEdgeRoute = (graphCanvasModule as unknown as { automaticEdgeRoute(value: GraphProject, edgeId: string): { x: number; y: number; targetX?: number } | undefined }).automaticEdgeRoute;

    const route = automaticEdgeRoute(fixture, "skip")!;
    expect(route.x).toBeLessThan(280);
    expect(route.targetX).toBeGreaterThan(280 + 176);
    expect(route.y).toBeGreaterThan(56);
  });

  it.skip("lets the selected connection persist a manually adjusted route (covered in Microsoft Edge E2E)", async () => {
    const api = graphApi();
    const { container } = render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);
    await screen.findByText("Agent 1");

    fireEvent.click(container.querySelector(".react-flow__edge-path")!);
    const handle = await screen.findByRole("button", { name: "Adjust connection path" });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 240, clientY: 230 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 240, clientY: 230 });

    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalled(), { timeout: 1_500 });
    const saved = vi.mocked(api.saveGraph).mock.calls.at(-1)?.[0] as GraphProject;
    expect(saved.definition.edges.find((edge) => edge.id === "input-agent")?.route).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
  });

  it("shows graph information by default and returns to it after closing a node", async () => {
    render(<GraphCanvas api={graphApi({ withDetails: true })} graphId="g1" agents={agents} language="en" />);
    expect(await screen.findByRole("heading", { name: "Graph information" })).toBeVisible();
    fireEvent.click(await screen.findByTestId("rf__node-agent-1"));
    expect(screen.getByRole("heading", { name: "Node settings" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close node inspector" }));
    expect(screen.getByRole("heading", { name: "Graph information" })).toBeVisible();
  });

  it("shows every Loop iteration as part of the latest Graph run", async () => {
    const api = graphApi({ withDetails: true });
    const detail = await api.getGraphRun("r1");
    detail.nodeRuns = [
      { id: "agent-1", runId: "r1", nodeId: "agent-1", iteration: 1, status: "completed", input: "brief", inputValues: { task: "brief" }, output: "draft one", outputValues: { result: "draft one" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
      { id: "loop-1", runId: "r1", nodeId: "loop-1", iteration: 1, status: "completed", input: "draft one", inputValues: { input: "draft one" }, output: "draft one", outputValues: { loop: "draft one" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
      { id: "agent-2", runId: "r1", nodeId: "agent-1", iteration: 2, status: "completed", input: "draft one", inputValues: { feedback: "draft one" }, output: "draft two", outputValues: { result: "draft two" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
      { id: "loop-2", runId: "r1", nodeId: "loop-1", iteration: 2, status: "completed", input: "draft two", inputValues: { input: "draft two" }, output: "draft two", outputValues: { loop: "draft two" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
      { id: "agent-3", runId: "r1", nodeId: "agent-1", iteration: 3, status: "completed", input: "draft two", inputValues: { feedback: "draft two" }, output: "final answer", outputValues: { result: "final answer" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
    ];
    api.getGraphRun = vi.fn(async () => detail);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    const latestRun = await screen.findByLabelText("Latest Graph run results");
    expect(within(latestRun).getAllByText("Agent 1")).toHaveLength(3);
    expect(latestRun).toHaveTextContent("Iteration 1");
    expect(latestRun).toHaveTextContent("Iteration 2");
    expect(latestRun).toHaveTextContent("Iteration 3");
    expect(latestRun).toHaveTextContent("brief");
    expect(latestRun).toHaveTextContent("draft one");
    expect(latestRun).toHaveTextContent("draft two");
    expect(latestRun).toHaveTextContent("final answer");
    expect([...latestRun.querySelectorAll(".graph-run-result > header")].map((item) => item.textContent)).toEqual([
      "Agent 1Iteration 3",
      "Loop Counter 1Iteration 2",
      "Agent 1Iteration 2",
      "Loop Counter 1Iteration 1",
      "Agent 1Iteration 1",
    ]);
  });

  it("renders recent runs as rows and opens an immutable run snapshot", async () => {
    const api = graphApi({ withDetails: true });
    api.listGraphRuns = vi.fn(async () => [
      { ...(await api.getGraphRun("r1")).run, id: "r1" },
      { ...(await api.getGraphRun("r1")).run, id: "r0", status: "failed" as const },
    ]);
    const { container } = render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" view="runs" />);

    expect(await screen.findAllByRole("button", { name: /Run / })).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: /Run r1/ }));
    expect(await screen.findByLabelText("Run snapshot")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Run details" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Trajectory" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Fit View" })).toBeVisible();
    expect(container.querySelector(".graph-run-view > main > header")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Trajectory" }));
    expect(screen.getByLabelText("Graph trajectory")).toBeVisible();
    expect(screen.queryByLabelText("Run snapshot")).not.toBeInTheDocument();
  });

  it("shows every step and Loop iteration in the default Graph run details", async () => {
    const api = graphApi({ withDetails: true });
    const detail = await api.getGraphRun("r1");
    detail.nodeRuns = [
      { id: "input", runId: "r1", nodeId: "input-1", iteration: 1, status: "completed", input: "brief", inputValues: { task: "brief" }, output: "brief", outputValues: { task: "brief" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
      { id: "agent-1", runId: "r1", nodeId: "agent-1", iteration: 1, status: "completed", input: "brief", inputValues: { task: "brief" }, output: "draft one", outputValues: { result: "draft one" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
      { id: "loop-1", runId: "r1", nodeId: "loop-1", iteration: 1, status: "completed", input: "draft one", inputValues: { input: "draft one" }, output: "draft one", outputValues: { loop: "draft one" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
      { id: "agent-2", runId: "r1", nodeId: "agent-1", iteration: 2, status: "completed", input: "draft one", inputValues: { feedback: "draft one" }, output: "draft two", outputValues: { result: "draft two" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
      { id: "loop-2", runId: "r1", nodeId: "loop-1", iteration: 2, status: "completed", input: "draft two", inputValues: { input: "draft two" }, output: "draft two", outputValues: { loop: "draft two" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
      { id: "agent-3", runId: "r1", nodeId: "agent-1", iteration: 3, status: "completed", input: "draft two", inputValues: { feedback: "draft two" }, output: "final answer", outputValues: { result: "final answer" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
      { id: "loop-3", runId: "r1", nodeId: "loop-1", iteration: 3, status: "completed", input: "final answer", inputValues: { input: "final answer" }, output: "final answer", outputValues: { done: "final answer" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
      { id: "output", runId: "r1", nodeId: "output-1", iteration: 1, status: "completed", input: "final answer", inputValues: { result: "final answer" }, output: "final answer", outputValues: { result: "final answer" }, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt },
    ];
    api.listGraphRuns = vi.fn(async () => [detail.run]);
    api.getGraphRun = vi.fn(async () => detail);

    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" view="runs" />);

    const results = await screen.findByLabelText("Graph run steps");
    expect([...results.querySelectorAll(".graph-run-result > header")].map((item) => item.textContent)).toEqual([
      "User Input",
      "Agent 1Iteration 1",
      "Loop Counter 1Iteration 1",
      "Agent 1Iteration 2",
      "Loop Counter 1Iteration 2",
      "Agent 1Iteration 3",
      "Loop Counter 1Iteration 3",
      "Output",
    ]);
    expect(within(results).getAllByText("Input")).toHaveLength(3);
    expect(within(results).getAllByText("Output")).toHaveLength(4);
    expect(results).toHaveTextContent("brief");
    expect(results).toHaveTextContent("draft one");
    expect(results).toHaveTextContent("draft two");
    expect(results).toHaveTextContent("final answer");
  });

  it("keeps the last selected run when an earlier detail request finishes later", async () => {
    const api = graphApi({ withDetails: true });
    const first = await api.getGraphRun("r1");
    const second = { ...first, run: { ...first.run, id: "r0", input: "second run" } };
    api.listGraphRuns = vi.fn(async () => [first.run, second.run]);
    api.getGraphRun = vi.fn(async () => first);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" view="runs" />);
    await screen.findByRole("button", { name: "Run r0" });

    const slow = deferred<typeof first>();
    const fast = deferred<typeof second>();
    api.getGraphRun = vi.fn((id: string) => id === "r1" ? slow.promise : fast.promise);
    fireEvent.click(screen.getByRole("button", { name: "Run r1" }));
    fireEvent.click(screen.getByRole("button", { name: "Run r0" }));
    fast.resolve(second);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Run r0" }).closest(".graph-run-row")).toHaveAttribute("data-active", "true"));
    slow.resolve(first);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(screen.getByRole("button", { name: "Run r0" }).closest(".graph-run-row")).toHaveAttribute("data-active", "true");
  });

  it("ignores an active-run poll that finishes after selecting a historical run", async () => {
    const api = graphApi({ running: true, withDetails: true });
    const active = await api.getGraphRun("r1");
    const historical = {
      ...active,
      run: { ...active.run, id: "r0", status: "completed" as const, input: "historical run" },
    };
    const poll = deferred<typeof active>();
    api.listGraphRuns = vi.fn(async () => [active.run, historical.run]);
    api.getGraphRun = vi.fn()
      .mockResolvedValueOnce(active)
      .mockImplementationOnce(async () => poll.promise)
      .mockResolvedValue(historical);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" view="runs" />);

    await screen.findByRole("button", { name: "Run r0" });
    await vi.waitFor(() => expect(api.getGraphRun).toHaveBeenCalledTimes(2), { timeout: 1_500 });
    fireEvent.click(screen.getByRole("button", { name: "Run r0" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Run r0" }).closest(".graph-run-row")).toHaveAttribute("data-active", "true"));

    poll.resolve(active);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(screen.getByRole("button", { name: "Run r0" }).closest(".graph-run-row")).toHaveAttribute("data-active", "true");
  });

  it("keeps run history usable and reports a failed detail request", async () => {
    const api = graphApi({ withDetails: true });
    const detail = await api.getGraphRun("r1");
    const unavailable = { ...detail.run, id: "r0", input: "unavailable run" };
    api.listGraphRuns = vi.fn(async () => [detail.run, unavailable]);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" view="runs" />);
    await screen.findByRole("button", { name: "Run r0" });

    api.getGraphRun = vi.fn(async () => { throw new Error("Run details unavailable"); });
    await userEvent.click(screen.getByRole("button", { name: "Run r0" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Run details unavailable");
    expect(screen.getByRole("button", { name: "Run r1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Run r0" })).toBeVisible();
  });

  it("reports a failed active-run refresh without dropping the current run", async () => {
    const api = graphApi({ running: true, withDetails: true });
    const detail = await api.getGraphRun("r1");
    api.getGraphRun = vi.fn()
      .mockResolvedValueOnce(detail)
      .mockRejectedValue(new Error("Run refresh unavailable"));
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    expect(await screen.findByRole("button", { name: "Stop graph" })).toBeVisible();
    expect(await screen.findByRole("alert", {}, { timeout: 1_500 })).toHaveTextContent("Run refresh unavailable");
    expect(screen.getByRole("button", { name: "Stop graph" })).toBeVisible();
  });

  it("reruns and deletes history rows without showing detailed timestamps", async () => {
    const user = userEvent.setup();
    const api = graphApi({ withDetails: true });
    const original = (await api.getGraphRun("r1")).run;
    api.listGraphRuns = vi.fn(async () => [original]);
    api.deleteGraphRun = vi.fn(async () => undefined);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" view="runs" />);

    expect(await screen.findByRole("button", { name: "Rerun r1" })).toBeVisible();
    expect(screen.queryByText(new Date(original.createdAt).toLocaleString())).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rerun r1" }));
    expect(api.runGraph).toHaveBeenCalledWith("g1", { task: "review this" });

    await user.click(screen.getByRole("button", { name: "Delete r1" }));
    expect(screen.getByRole("dialog", { name: "Delete run" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm run deletion" }));
    expect(api.deleteGraphRun).toHaveBeenCalledWith("r1");
    expect(screen.queryByRole("button", { name: "Run r1" })).not.toBeInTheDocument();
  });

  it("loads a graph, auto-saves node edits, and runs", async () => {
    const user = userEvent.setup();
    const api = graphApi();
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    expect(await screen.findByText("User Input")).toBeInTheDocument();
    expect(await screen.findByText("Output")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Agent" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add Loop" })).toBeVisible();
    fireEvent.click(screen.getByText("Loop Counter 1"));
    await user.clear(screen.getByLabelText("Maximum iterations"));
    await user.type(screen.getByLabelText("Maximum iterations"), "4");
    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalledWith(expect.objectContaining({ definition: expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ type: "loop_counter", config: { maxIterations: 4 } })]) }) })), { timeout: 1_500 });

    await user.type(screen.getByLabelText("Task"), "review this");
    await user.click(screen.getByRole("button", { name: "Run graph" }));
    expect(api.runGraph).toHaveBeenCalledWith("g1", { task: "review this" });
    await user.click(screen.getByRole("button", { name: "Close node inspector" }));
    expect(screen.getByRole("heading", { name: "Latest Graph run" })).toBeVisible();
  });

  it("saves the current graph before running it", async () => {
    const user = userEvent.setup();
    const api = graphApi();
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    fireEvent.click(within(await screen.findByTestId("rf__node-loop-1")).getByText("Loop Counter 1"));
    await user.clear(screen.getByLabelText("Maximum iterations"));
    await user.type(screen.getByLabelText("Maximum iterations"), "2");
    await user.type(screen.getByLabelText("Task"), "iterate this");
    await user.click(screen.getByRole("button", { name: "Run graph" }));

    expect(api.saveGraph).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({
        nodes: expect.arrayContaining([expect.objectContaining({ id: "loop-1", config: { maxIterations: 2 } })]),
      }),
    }));
    expect(vi.mocked(api.saveGraph).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.runGraph).mock.invocationCallOrder[0]);
  });

  it("keeps Agent fixed after node creation and stops an active run", async () => {
    const user = userEvent.setup();
    const api = graphApi({ running: true });
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);
    expect(await screen.findByRole("button", { name: "Stop graph" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Stop graph" }));
    expect(api.cancelGraphRun).toHaveBeenCalledWith("r1");
  });

  it("keeps a run active and reports a failed stop request", async () => {
    const user = userEvent.setup();
    const api = graphApi({ running: true });
    api.cancelGraphRun = vi.fn(async () => { throw new Error("Unable to stop run"); });
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    await user.click(await screen.findByRole("button", { name: "Stop graph" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to stop run");
    expect(screen.getByRole("button", { name: "Stop graph" })).toBeVisible();
  });

  it("does not mark an already-finished run as cancelled", async () => {
    const user = userEvent.setup();
    const api = graphApi({ running: true });
    api.cancelGraphRun = vi.fn(async () => false);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    await user.click(await screen.findByRole("button", { name: "Stop graph" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Graph run is no longer active");
    expect(screen.getByRole("button", { name: "Stop graph" })).toBeVisible();
  });

  it("creates the starter Agent from an available local Agent and allows configuring it", async () => {
    const user = userEvent.setup();
    const api = graphApi();
    const localAgents: AgentSettingsView[] = [
      { id: "claude", name: "Claude Code", status: "available", executablePath: "claude", enabled: true, catalog: { models: ["sonnet"], permissionModes: ["request_approval", "full_access"] } },
      ...agents,
    ];
    render(<GraphCanvas api={api} graphId="g1" agents={localAgents} language="en" />);

    await screen.findByText("Agent 1");
    fireEvent.click(screen.getByText("Agent 1"));
    expect(screen.getByLabelText("Agent")).toBeEnabled();
    await user.selectOptions(screen.getByLabelText("Agent"), "claude");
    await user.selectOptions(screen.getByLabelText("Permission mode"), "request_approval");
    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalledWith(expect.objectContaining({ definition: expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ config: expect.objectContaining({ agentProductId: "claude" }) })]) }) })), { timeout: 1_500 });
  });

  it("orders and labels selectable Agents consistently", async () => {
    const api = graphApi();
    render(<GraphCanvas api={api} graphId="g1" agents={[
      { id: "trae", name: "Trae", status: "available", executablePath: "trae", enabled: true, catalog: { models: [], permissionModes: ["request_approval"] } },
      { id: "claude", name: "Claude", status: "available", executablePath: "claude", enabled: true, catalog: { models: [], permissionModes: ["request_approval"] } },
      { id: "codex", name: "codex-cli", status: "available", executablePath: "codex", enabled: true, catalog: { models: [], permissionModes: ["request_approval"] } },
    ]} language="en" />);

    fireEvent.click(await screen.findByText("Agent 1"));
    expect([...screen.getByLabelText("Agent").querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Codex", "Claude Code", "Trae CLI"]);
  });

  it("treats a locally runnable capability-limited Agent as selectable", async () => {
    const user = userEvent.setup();
    const api = graphApi();
    const localAgents: AgentSettingsView[] = [
      { id: "codex", name: "Codex", status: "not_installed", executablePath: "codex", enabled: true, catalog: { models: [], permissionModes: [] } },
      { id: "claude", name: "Claude Code", status: "capability_limited", executablePath: "claude", enabled: true, catalog: { models: ["sonnet"], permissionModes: ["request_approval"] } },
    ];
    render(<GraphCanvas api={api} graphId="g1" agents={localAgents} language="en" />);

    await screen.findByText("Agent 1");
    fireEvent.click(screen.getByText("Agent 1"));
    expect(screen.getByLabelText("Agent")).toHaveValue("codex");
    expect(screen.getByRole("option", { name: /Codex/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close node inspector" }));
    await user.click(screen.getByRole("button", { name: "Add Agent" }));
    fireEvent.click(await screen.findByText("Agent 2"));
    expect(screen.getByLabelText("Agent")).toHaveValue("claude");
    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalled(), { timeout: 1_500 });
    const saved = vi.mocked(api.saveGraph).mock.calls.at(-1)?.[0] as GraphProject;
    expect(saved.definition.nodes.filter((node) => node.type === "agent").at(-1)).toMatchObject({
      config: { agentProductId: "claude", modelId: "sonnet", permissionMode: "request_approval" },
    });
  });

  it("deletes a node and its connected edges from the saved definition", async () => {
    const user = userEvent.setup();
    const api = graphApi();
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    fireEvent.click(within(await screen.findByTestId("rf__node-loop-1")).getByText("Loop Counter 1"));
    await user.click(screen.getByRole("button", { name: "Delete node" }));
    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({
        nodes: expect.not.arrayContaining([expect.objectContaining({ id: "loop-1" })]),
        edges: [expect.objectContaining({ id: "input-agent" })],
      }),
    })), { timeout: 1_500 });
  });

  it("shows semantic latest-run data without a mechanical Graph event log", async () => {
    const api = graphApi({ running: true, withDetails: true });
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    const agentNode = (await screen.findByTestId("rf__node-agent-1")).querySelector(".graph-node");
    await vi.waitFor(() => expect(agentNode).toHaveAttribute("data-status", "completed"));
    expect(screen.queryByRole("log", { name: "Run events" })).toBeNull();
    fireEvent.click(within(await screen.findByTestId("rf__node-loop-1")).getByText("Loop Counter 1"));
    expect(screen.getAllByRole("heading", { name: "Content" })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Input" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Output" })).toBeNull();
  });

  it("shows Loop progress until the whole Graph run completes", async () => {
    const api = graphApi({ running: true, withDetails: true });
    const detail = await api.getGraphRun("r1");
    detail.nodeRuns = [{ id: "loop-run", runId: "r1", nodeId: "loop-1", iteration: 1, status: "completed", input: "draft", output: "draft", error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt }];
    api.getGraphRun = vi.fn(async () => detail);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    const loop = (await screen.findByTestId("rf__node-loop-1")).querySelector(".graph-node");
    await vi.waitFor(() => expect(loop).toHaveAttribute("data-status", "running"));
    expect(loop).toHaveTextContent("Iteration 1/3");
  });

  it("shows the current iteration while the Loop node itself is running", async () => {
    const api = graphApi({ running: true, withDetails: true });
    const detail = await api.getGraphRun("r1");
    detail.nodeRuns = [{ id: "loop-run", runId: "r1", nodeId: "loop-1", iteration: 2, status: "running", input: "draft", output: null, error: null, createdAt: detail.run.createdAt, updatedAt: detail.run.updatedAt }];
    api.getGraphRun = vi.fn(async () => detail);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    const loop = (await screen.findByTestId("rf__node-loop-1")).querySelector(".graph-node");
    await vi.waitFor(() => expect(loop).toHaveAttribute("data-status", "running"));
    expect(loop).toHaveTextContent("Iteration 2/3");
  });

  it("uses one reusable node header geometry", async () => {
    const { container } = render(<GraphCanvas api={graphApi()} graphId="g1" agents={agents} language="en" />);
    await screen.findByText("Agent 1");

    expect(container.querySelectorAll(".graph-node > header")).toHaveLength(4);
    expect(getComputedStyle(container.querySelector(".graph-node > header")!).height).toBe("56px");
  });

  it("uses the canonical Agent label on graph nodes", async () => {
    const api = graphApi();
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    const agentNode = await screen.findByTestId("rf__node-agent-1");
    expect(agentNode).toHaveTextContent("Codex");
    expect(agentNode).not.toHaveTextContent(/codex/);
  });

  it("loads the explicitly selected graph without rendering another graph picker", async () => {
    const api = graphApi({ withDetails: true, multipleGraphs: true });
    render(<GraphCanvas api={api} graphId="g2" agents={agents} language="en" />);

    await vi.waitFor(() => expect(api.getGraph).toHaveBeenCalledWith("g2"));
    expect(await screen.findByText("Agent 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Second graph/ })).not.toBeInTheDocument();
  });

  it("clears the previous Graph while switching and ignores its late save response", async () => {
    const first = deferred<GraphProject>();
    const second = deferred<{ graph: GraphProject; latestRun: null }>();
    const api = graphApi();
    api.saveGraph = vi.fn(async () => first.promise);
    api.getGraph = vi.fn(async (id: string) => id === "g1"
      ? { graph: graphFixture("g1", "First graph"), latestRun: null }
      : second.promise);
    const onGraphSaved = vi.fn();
    const view = render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" onGraphSaved={onGraphSaved} />);

    await screen.findByRole("button", { name: "Add Agent" });
    await userEvent.click(screen.getByRole("button", { name: "Add Agent" }));
    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalled(), { timeout: 1_500 });
    view.rerender(<GraphCanvas api={api} graphId="g2" agents={agents} language="en" onGraphSaved={onGraphSaved} />);

    first.resolve(graphFixture("g1", "Saved first graph"));
    await vi.waitFor(() => expect(onGraphSaved).not.toHaveBeenCalled());
    second.resolve({ graph: graphFixture("g2", "Second graph"), latestRun: null });
    await vi.waitFor(() => expect(api.getGraph).toHaveBeenCalledWith("g2"));
    expect(await screen.findByRole("button", { name: "Add Agent" })).toBeEnabled();
  });

  it("does not let an in-flight save for one Graph suppress the same edit on another Graph", async () => {
    const firstSave = deferred<GraphProject>();
    const api = graphApi();
    api.getGraph = vi.fn(async (id: string) => ({ graph: graphFixture(id, "Same graph"), latestRun: null }));
    api.saveGraph = vi.fn(async (value: GraphProject) => value.id === "g1" ? firstSave.promise : value);
    const view = render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    fireEvent.change(await screen.findByLabelText("Description"), { target: { value: "Shared edit" } });
    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalledTimes(1), { timeout: 1_500 });
    view.rerender(<GraphCanvas api={api} graphId="g2" agents={agents} language="en" />);
    fireEvent.change(await screen.findByLabelText("Description"), { target: { value: "Shared edit" } });

    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalledTimes(2), { timeout: 1_500 });
    expect(api.saveGraph).toHaveBeenLastCalledWith(expect.objectContaining({ id: "g2", description: "Shared edit" }));
    firstSave.resolve(graphFixture("g1", "Same graph"));
  });

  it("auto-saves draft edits even while the topology is incomplete", async () => {
    const user = userEvent.setup();
    const api = graphApi();
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);
    await screen.findByText("Agent 1");

    await user.click(screen.getByRole("button", { name: "Add Agent" }));

    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ type: "agent" })]) }),
    })), { timeout: 1_500 });
    expect(screen.queryByRole("button", { name: "Save graph" })).not.toBeInTheDocument();
  });

  it("auto-saves while its parent keeps rendering", async () => {
    const user = userEvent.setup();
    const api = graphApi();
    function RerenderingParent() {
      const [, setTick] = useState(0);
      useEffect(() => { const timer = setInterval(() => setTick((value) => value + 1), 50); return () => clearInterval(timer); }, []);
      return <GraphCanvas api={api} graphId="g1" agents={agents} language="en" onGraphSaved={() => undefined} />;
    }
    render(<RerenderingParent />);
    await screen.findByText("Agent 1");

    await user.click(screen.getByRole("button", { name: "Add Agent" }));

    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalled(), { timeout: 1_500 });
  });

  it("does not turn React Flow measurements into persistent graph edits", async () => {
    const api = graphApi();
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);
    await screen.findByText("Agent 1");
    const pane = screen.getByTestId("graph-flow").querySelector(".react-flow");
    expect(pane).not.toBeNull();

    fireEvent.resize(window);
    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(api.saveGraph).not.toHaveBeenCalled();
  });

  it("does not fit a Graph before its canvas has measurable dimensions", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<GraphCanvas api={graphApi()} graphId="g1" agents={agents} language="en" />);

    fireEvent.click(await screen.findByText("Agent 1"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.click(screen.getByRole("button", { name: "Insert Task parameter" }));
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(error.mock.calls.flat().map(String).join(" ")).not.toContain("Received NaN");
    error.mockRestore();
  });

  it("clears nodes only after an in-app confirmation", async () => {
    const user = userEvent.setup();
    const api = graphApi();
    const view = render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" clearRequest={0} />);
    await screen.findByText("Agent 1");
    view.rerender(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" clearRequest={1} />);

    await user.click(screen.getByRole("button", { name: "Clear" }));
    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalledWith(expect.objectContaining({
      definition: { nodes: [], edges: [], start: [], end: [] },
    })), { timeout: 1_500 });
  });

  it("edits, validates, auto-layouts, and saves portable Graph configuration", async () => {
    const user = userEvent.setup();
    const api = graphApi();
    const onGraphSaved = vi.fn();
    const view = render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" configRequest={0} onGraphSaved={onGraphSaved} />);
    await screen.findByText("Agent 1");
    view.rerender(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" configRequest={1} onGraphSaved={onGraphSaved} />);

    const dialog = screen.getByRole("dialog", { name: "Graph configuration" });
    const editor = within(dialog).getByLabelText("Graph configuration JSON");
    expect((editor as HTMLTextAreaElement).value).toContain('"formatVersion": 1');
    expect((editor as HTMLTextAreaElement).value).not.toContain('"projectId"');

    fireEvent.change(editor, { target: { value: "{" } });
    await user.click(within(dialog).getByRole("button", { name: "Save configuration" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("JSON");
    expect(api.saveGraph).not.toHaveBeenCalled();

    const source = await api.getGraph("g1");
    const portable = { formatVersion: 1, name: "Configured graph", description: "From JSON", definition: source.graph.definition };
    fireEvent.change(editor, { target: { value: JSON.stringify(portable) } });
    await user.click(within(dialog).getByRole("button", { name: "Auto layout" }));
    expect((editor as HTMLTextAreaElement).value).toContain('"positions"');
    await user.click(within(dialog).getByRole("button", { name: "Save configuration" }));

    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalledWith(expect.objectContaining({ name: "Configured graph", description: "From JSON" })));
    expect(screen.queryByRole("dialog", { name: "Graph configuration" })).toBeNull();
    expect(onGraphSaved).toHaveBeenCalledWith(expect.objectContaining({ name: "Configured graph" }));
  });

  it("includes manual route points when calculating the fit bounds", () => {
    const graph = graphFixture("g1", "Routed");
    graph.definition.nodes = [
      { id: "a", type: "input", name: "A", config: { fields: [{ id: "out", name: "Out", description: "", multiline: true }] } },
      { id: "b", type: "output", name: "B", config: { fields: [{ id: "in", name: "In" }] } },
    ];
    graph.definition.edges = [{ id: "route", source: "a", sourcePort: "out", target: "b", targetPort: "in", route: { x: 400, y: -300 } }];
    graph.positions = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } };
    const graphBounds = (graphCanvasModule as unknown as { graphBounds(value: GraphProject): { x: number; y: number; width: number; height: number } }).graphBounds;

    expect(graphBounds(graph)).toEqual({ x: 0, y: -300, width: 400, height: 384 });
  });

  it("includes the automatic return route when fitting a Graph", () => {
    const graph = graphFixture("g1", "Return route");
    graph.definition.edges = [{ id: "return", source: "b", target: "a" }];
    graph.definition.nodes = [
      { id: "a", type: "input", name: "A", config: { fields: [{ id: "out", name: "Out", description: "", multiline: true }] } },
      { id: "b", type: "output", name: "B", config: { fields: [{ id: "in", name: "In" }] } },
    ];
    graph.positions = { a: { x: 0, y: 0 }, b: { x: 240, y: 0 } };
    const graphBounds = (graphCanvasModule as unknown as { graphBounds(value: GraphProject): { x: number; y: number; width: number; height: number } }).graphBounds;

    expect(graphBounds(graph).height).toBeGreaterThan(100);
  });

  it("switches between select and pan canvas modes beside the native controls", async () => {
    const user = userEvent.setup();
    render(<GraphCanvas api={graphApi()} graphId="g1" agents={agents} language="en" />);
    await screen.findByText("Agent 1");
    expect(screen.getByRole("button", { name: "Fit View" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Zoom in" })).toHaveAttribute("data-tooltip", "Zoom in");
    expect(screen.getByRole("button", { name: "Zoom out" })).toHaveAttribute("data-tooltip", "Zoom out");
    expect(screen.getByRole("button", { name: "Fit View" })).toHaveAttribute("data-tooltip", "Fit View");
    const mode = screen.getByRole("button", { name: "Switch to pan mode" });
    expect(mode).toHaveAttribute("data-tooltip", "Switch to pan mode");
    expect(screen.getByRole("button", { name: "Optimize graph" })).toHaveAttribute("data-tooltip", "Optimize graph");
    expect(mode.closest(".react-flow__controls")).not.toBeNull();
    expect(document.querySelector(".graph-canvas-controls")).toBeNull();
    await user.click(mode);
    expect(screen.getByRole("button", { name: "Switch to select mode" })).toBeVisible();
  });

  it("optimizes node placement and clears manual connection routing", async () => {
    const user = userEvent.setup();
    const api = graphApi();
    const source = await api.getGraph("g1");
    source.graph.definition.edges[0]!.route = { x: 900, y: -200 };
    source.graph.positions = Object.fromEntries(source.graph.definition.nodes.map((node) => [node.id, { x: 10, y: 10 }]));
    api.getGraph = vi.fn(async () => source);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" />);

    await user.click(await screen.findByRole("button", { name: "Optimize graph" }));

    await vi.waitFor(() => expect(api.saveGraph).toHaveBeenCalled(), { timeout: 1_500 });
    const saved = vi.mocked(api.saveGraph).mock.calls.at(-1)?.[0] as GraphProject;
    expect(saved.definition.edges.every((edge) => edge.route === undefined)).toBe(true);
    expect(new Set(Object.values(saved.positions).map((position) => position.x)).size).toBeGreaterThan(1);
  });

  it("does not show a model that belongs to another Agent catalog", async () => {
    const api = graphApi();
    const claudeGraph = graphFixture("g1", "Claude graph");
    claudeGraph.definition = { nodes: [{ id: "agent-1", type: "agent", name: "Agent 1", config: { agentProductId: "claude", modelId: "gpt-5.6-sol", permissionMode: "request_approval", prompt: "{{input}}" } }], edges: [], start: ["agent-1"], end: ["agent-1"] };
    api.getGraph = vi.fn(async () => ({ graph: claudeGraph, latestRun: null }));
    render(<GraphCanvas api={api} graphId="g1" agents={[...agents, { id: "claude", name: "Claude Code", status: "available", executablePath: "claude", enabled: true, catalog: { models: [], permissionModes: ["request_approval"] } }]} language="en" />);

    fireEvent.click(await screen.findByText("Agent 1"));
    expect(screen.getByLabelText("Model")).toHaveValue("");
    expect(screen.queryByRole("option", { name: "gpt-5.6-sol" })).not.toBeInTheDocument();
    expect([...screen.getByLabelText("Agent").querySelectorAll("option")].map((option) => option.textContent)).toEqual(["Codex", "Claude Code"]);
  });

  it("presents Graph trajectory as ordered node steps and Loop iterations", async () => {
    const api = graphApi({ withDetails: true });
    const detail = await api.getGraphRun("r1");
    detail.nodeRuns = [
      { id: "node-input", runId: "r1", nodeId: "input-1", iteration: 1, status: "completed", input: "review this", inputValues: { task: "review this" }, output: "review this", outputValues: { task: "review this" }, error: null, createdAt: "2026-08-27T08:00:00.000Z", updatedAt: "2026-08-27T08:00:00.100Z" },
      { id: "node-agent-1", runId: "r1", nodeId: "agent-1", iteration: 1, status: "completed", input: "review this", inputValues: { task: "review this" }, output: "draft", outputValues: { result: "draft" }, error: null, createdAt: "2026-08-27T08:00:00.100Z", updatedAt: "2026-08-27T08:00:02.000Z" },
      { id: "node-loop-1", runId: "r1", nodeId: "loop-1", iteration: 1, status: "completed", input: "draft", inputValues: { input: "draft" }, output: "draft", outputValues: { loop: "draft" }, error: null, createdAt: "2026-08-27T08:00:02.000Z", updatedAt: "2026-08-27T08:00:02.050Z" },
      { id: "node-agent-2", runId: "r1", nodeId: "agent-1", iteration: 2, status: "completed", input: "draft", inputValues: { feedback: "draft" }, output: "final", outputValues: { result: "final" }, error: null, createdAt: "2026-08-27T08:00:02.050Z", updatedAt: "2026-08-27T08:00:03.000Z" },
    ];
    detail.events = [{ id: "private-event-uuid", runId: "r1", sequence: 1, type: "agent_reasoning", nodeId: "agent-1", payload: { summary: "Inspect files" }, createdAt: "2026-08-27T08:00:01.000Z" }];
    api.getGraphRun = vi.fn(async () => detail);
    api.listGraphRuns = vi.fn(async () => [detail.run]);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" view="runs" />);

    await userEvent.click(await screen.findByRole("tab", { name: "Trajectory" }));
    const trajectory = screen.getByLabelText("Graph trajectory");
    expect(trajectory).toHaveTextContent("4 steps");
    expect(trajectory).toHaveTextContent("2 Agent runs");
    expect(trajectory).toHaveTextContent("1 Loop decision");
    expect(within(trajectory).getAllByText("Agent 1")).toHaveLength(2);
    expect(trajectory).toHaveTextContent("#2");
    expect(trajectory).not.toHaveTextContent("private-event-uuid");
    expect(trajectory).not.toHaveTextContent("agent_reasoning");
    expect(within(trajectory).queryByText("TOOL")).toBeNull();
    expect(within(trajectory).queryByText("STATUS")).toBeNull();
    expect(trajectory.querySelectorAll(".graph-trajectory__steps .graph-trajectory__iteration")).toHaveLength(1);
    fireEvent.click(trajectory.querySelectorAll<HTMLButtonElement>(".graph-trajectory__steps li > button")[1]!);
    const details = screen.getByLabelText("Node step details");
    expect(within(details).getByText("Task")).toBeVisible();
    expect(within(details).queryByText("task")).toBeNull();
  });

  it("shows readable non-Agent Content fields without repeating a single internal key", async () => {
    const api = graphApi({ withDetails: true });
    const detail = await api.getGraphRun("r1");
    const input = detail.run.graphSnapshot?.definition.nodes.find((node) => node.id === "input-1");
    if (input?.type === "input") input.config.fields = [
      { id: "task_id", name: "Task brief", description: "", required: true, multiline: true },
      { id: "context_id", name: "Context notes", description: "", required: false, multiline: true },
    ];
    detail.nodeRuns = [
      { id: "input-run", runId: "r1", nodeId: "input-1", iteration: 1, status: "completed", input: "review", inputValues: { task_id: "review", context_id: "src" }, output: "review", outputValues: { task_id: "review", context_id: "src" }, error: null, createdAt: "2026-08-27T08:00:00.000Z", updatedAt: "2026-08-27T08:00:00.100Z" },
      { id: "loop-run", runId: "r1", nodeId: "loop-1", iteration: 1, status: "completed", input: "draft", inputValues: { input: "draft" }, output: "draft", outputValues: { loop: "draft" }, error: null, createdAt: "2026-08-27T08:00:00.100Z", updatedAt: "2026-08-27T08:00:00.200Z" },
    ];
    api.getGraphRun = vi.fn(async () => detail);
    api.listGraphRuns = vi.fn(async () => [detail.run]);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" view="runs" />);

    await userEvent.click(await screen.findByRole("tab", { name: "Trajectory" }));
    const steps = screen.getByLabelText("Graph trajectory").querySelectorAll<HTMLButtonElement>(".graph-trajectory__steps li > button");
    fireEvent.click(steps[0]!);
    expect(screen.getByLabelText("Node step details")).toHaveTextContent("Task brief");
    expect(screen.getByLabelText("Node step details")).toHaveTextContent("Context notes");
    expect(screen.getByLabelText("Node step details")).not.toHaveTextContent("task_id");
    expect(screen.getByLabelText("Node step details")).not.toHaveTextContent("context_id");
    fireEvent.click(steps[1]!);
    expect(screen.getByLabelText("Node step details").querySelector(".graph-values strong")).toBeNull();
  });

  it("preserves the server execution order when Graph steps share a timestamp", async () => {
    const api = graphApi({ withDetails: true });
    const detail = await api.getGraphRun("r1");
    const createdAt = "2026-08-27T08:00:00.000Z";
    detail.nodeRuns = [
      { id: "loop-2", runId: "r1", nodeId: "loop-1", iteration: 2, status: "completed", input: "draft", output: "final", error: null, createdAt, updatedAt: createdAt },
      { id: "output-1", runId: "r1", nodeId: "output-1", iteration: 1, status: "completed", input: "final", output: "final", error: null, createdAt, updatedAt: createdAt },
    ];
    api.getGraphRun = vi.fn(async () => detail);
    api.listGraphRuns = vi.fn(async () => [detail.run]);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" view="runs" />);

    await userEvent.click(await screen.findByRole("tab", { name: "Trajectory" }));
    expect([...screen.getByLabelText("Graph trajectory").querySelectorAll(".graph-trajectory__name")].map((item) => item.childNodes[0]?.textContent)).toEqual([
      "Loop Counter 1",
      "Output",
    ]);
  });

  it("keeps same-millisecond Agent activity with its matching Loop iteration", async () => {
    const api = graphApi({ withDetails: true });
    const detail = await api.getGraphRun("r1");
    const createdAt = "2026-08-27T08:00:00.000Z";
    detail.nodeRuns = [
      { id: "agent-1-iteration-1", runId: "r1", nodeId: "agent-1", iteration: 1, status: "completed", input: "first", output: "draft", error: null, createdAt, updatedAt: createdAt },
      { id: "agent-1-iteration-2", runId: "r1", nodeId: "agent-1", iteration: 2, status: "completed", input: "second", output: "final", error: null, createdAt, updatedAt: createdAt },
    ];
    detail.events = [
      { id: "start-1", runId: "r1", sequence: 1, type: "node_started", nodeId: "agent-1", payload: { iteration: 1 }, createdAt },
      { id: "reasoning-1", runId: "r1", sequence: 2, type: "agent_reasoning", nodeId: "agent-1", payload: { summary: "First reasoning" }, createdAt },
      { id: "end-1", runId: "r1", sequence: 3, type: "node_completed", nodeId: "agent-1", payload: { iteration: 1 }, createdAt },
      { id: "start-2", runId: "r1", sequence: 4, type: "node_started", nodeId: "agent-1", payload: { iteration: 2 }, createdAt },
      { id: "reasoning-2", runId: "r1", sequence: 5, type: "agent_reasoning", nodeId: "agent-1", payload: { summary: "Second reasoning" }, createdAt },
      { id: "end-2", runId: "r1", sequence: 6, type: "node_completed", nodeId: "agent-1", payload: { iteration: 2 }, createdAt },
    ];
    api.getGraphRun = vi.fn(async () => detail);
    api.listGraphRuns = vi.fn(async () => [detail.run]);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" view="runs" />);

    await userEvent.click(await screen.findByRole("tab", { name: "Trajectory" }));
    const steps = screen.getByLabelText("Graph trajectory").querySelectorAll<HTMLButtonElement>(".graph-trajectory__steps li > button");
    fireEvent.click(steps[0]!);
    expect(screen.getByLabelText("Node step details")).toHaveTextContent("First reasoning");
    expect(screen.getByLabelText("Node step details")).not.toHaveTextContent("Second reasoning");
    fireEvent.click(steps[1]!);
    expect(screen.getByLabelText("Node step details")).toHaveTextContent("Second reasoning");
    expect(screen.getByLabelText("Node step details")).not.toHaveTextContent("First reasoning");
  });

  it("shows failed tools as errors and keeps warning diagnostics", async () => {
    const api = graphApi({ withDetails: true });
    const detail = await api.getGraphRun("r1");
    const createdAt = "2026-08-27T08:00:00.000Z";
    detail.nodeRuns = [{ id: "agent-run", runId: "r1", nodeId: "agent-1", iteration: 1, status: "failed", input: "task", output: null, error: { code: "tool_failed", message: "Command failed" }, createdAt, updatedAt: createdAt }];
    detail.events = [
      { id: "start", runId: "r1", sequence: 1, type: "node_started", nodeId: "agent-1", payload: { iteration: 1 }, createdAt },
      { id: "tool", runId: "r1", sequence: 2, type: "agent_tool", nodeId: "agent-1", payload: { name: "shell", status: "failed", error: { message: "Permission denied" } }, createdAt },
      { id: "warning", runId: "r1", sequence: 3, type: "agent_warning", nodeId: "agent-1", payload: { code: "malformed_json", line: "bad payload" }, createdAt },
      { id: "end", runId: "r1", sequence: 4, type: "node_failed", nodeId: "agent-1", payload: { iteration: 1 }, createdAt },
    ];
    api.getGraphRun = vi.fn(async () => detail);
    api.listGraphRuns = vi.fn(async () => [detail.run]);
    render(<GraphCanvas api={api} graphId="g1" agents={agents} language="en" view="runs" />);

    await userEvent.click(await screen.findByRole("tab", { name: "Trajectory" }));
    fireEvent.click(screen.getByLabelText("Graph trajectory").querySelector<HTMLButtonElement>(".graph-trajectory__steps li > button")!);
    const activities = screen.getByLabelText("Node step details").querySelector(".graph-trajectory__activity")!;
    expect(activities.querySelector('[data-kind="error"]')).toHaveTextContent("Permission denied");
    expect(activities.querySelector('[data-kind="warning"]')).toHaveTextContent("bad payload");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function graphFixture(id: string, name: string): GraphProject {
  const now = new Date().toISOString();
  return { id, projectId: "p1", name, description: "", definition: { nodes: [], edges: [], start: [], end: [] }, viewport: { x: 0, y: 0, zoom: 1 }, positions: {}, createdAt: now, updatedAt: now };
}

const agents: AgentSettingsView[] = [{ id: "codex", name: "Codex", status: "available", executablePath: "codex", enabled: true, catalog: { models: ["gpt-5"], permissionModes: ["request_approval"] } }];

function graphApi(input: { running?: boolean; withDetails?: boolean; multipleGraphs?: boolean } = {}) {
  const now = new Date().toISOString();
  const graph: GraphProject = {
    id: "g1", projectId: "p1", name: "Untitled graph", description: "",
    definition: {
      nodes: [
        { id: "input-1", type: "input", name: "User Input", config: { fields: [{ id: "task", name: "Task", description: "Describe this run", required: true, multiline: true }] } },
        { id: "agent-1", type: "agent", name: "Agent 1", config: { agentProductId: "codex", modelId: "gpt-5", permissionMode: "request_approval", instruction: "Complete the task.", inputs: [{ id: "task", name: "Task", required: true }, { id: "feedback", name: "Feedback", kind: "feedback" }], outputs: [{ id: "result", name: "Result" }] } },
        { id: "loop-1", type: "loop_counter", name: "Loop Counter 1", config: { maxIterations: 3 } },
        { id: "output-1", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
      ],
      edges: [
        { id: "input-agent", source: "input-1", sourcePort: "task", target: "agent-1", targetPort: "task" },
        { id: "agent-loop", source: "agent-1", sourcePort: "result", target: "loop-1", targetPort: "input" },
        { id: "loop-agent", source: "loop-1", sourcePort: "loop", target: "agent-1", targetPort: "feedback", condition: { branch: "loop" } },
        { id: "loop-output", source: "loop-1", sourcePort: "done", target: "output-1", targetPort: "result", condition: { branch: "done" } },
      ],
      start: ["input-1"], end: ["output-1"],
    },
    viewport: { x: 0, y: 0, zoom: 1 }, positions: { "input-1": { x: 0, y: 180 }, "agent-1": { x: 220, y: 180 }, "loop-1": { x: 440, y: 180 }, "output-1": { x: 660, y: 180 } }, createdAt: now, updatedAt: now,
  };
  const snapshot = { name: graph.name, definition: graph.definition, viewport: graph.viewport, positions: graph.positions };
  const run: GraphRun = { id: "r1", graphId: "g1", status: input.running ? "running" : "completed", input: "review this", inputValues: { task: "review this" }, output: input.running ? null : "Final result", outputValues: input.running ? null : { result: "Final result" }, graphSnapshot: snapshot, error: null, createdAt: now, updatedAt: now };
  const secondGraph: GraphProject = { ...graph, id: "g2", name: "Second graph" };
  const secondRun: GraphRun = { ...run, id: "r2", graphId: "g2", output: "Second result", outputValues: { result: "Second result" }, graphSnapshot: { ...snapshot, name: secondGraph.name } };
  return {
    listGraphs: vi.fn(async () => input.multipleGraphs ? [graph, secondGraph] : []), createGraph: vi.fn(async () => graph), getGraph: vi.fn(async (id: string) => id === "g2" ? { graph: secondGraph, latestRun: secondRun } : { graph, latestRun: input.running || input.withDetails ? run : null }),
    saveGraph: vi.fn(async (value: GraphProject) => value), deleteGraph: vi.fn(async () => undefined),
    runGraph: vi.fn(async () => run), getGraphRun: vi.fn(async (id: string) => ({ run: id === "r2" ? secondRun : run, nodeRuns: input.withDetails ? [{ id: "nr1", runId: id, nodeId: "agent-1", iteration: 1, status: "completed", input: "review this", output: "draft", error: null, createdAt: now, updatedAt: now }, { id: "nr2", runId: id, nodeId: "loop-1", iteration: 1, status: "completed", input: "draft", output: "draft", error: null, createdAt: now, updatedAt: now }] : [], events: input.withDetails ? [{ id: "e1", runId: id, sequence: 1, type: "node_completed", nodeId: "agent-1", payload: { iteration: 1 }, createdAt: now }] : [] })), cancelGraphRun: vi.fn(async () => true), deleteGraphRun: vi.fn(async () => undefined),
  } as unknown as AinOneApi & { [key: string]: ReturnType<typeof vi.fn> };
}
