import { describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/db.js";
import { createGraphRepository } from "../../src/server/graph-repository.js";
import type { GraphDefinition } from "../../src/shared/contracts.js";

const definition: GraphDefinition = {
  nodes: [
    { id: "input", type: "input", name: "Input", config: { fields: [{ id: "input", name: "Input", description: "", required: true, multiline: true }] } },
    { id: "agent", type: "agent", name: "Agent", config: { agentProductId: "codex", modelId: null, permissionMode: "request_approval", instruction: "Improve: {{input}}", inputs: [{ id: "input", name: "Input", required: true }, { id: "feedback", name: "Feedback", kind: "feedback" }], outputs: [{ id: "result", name: "Result" }] } },
    { id: "loop", type: "loop_counter", name: "Loop", config: { maxIterations: 3 } },
    { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
  ],
  edges: [
    { id: "input-agent", source: "input", sourcePort: "input", target: "agent", targetPort: "input" },
    { id: "agent-loop", source: "agent", sourcePort: "result", target: "loop", targetPort: "input" },
    { id: "loop-agent", source: "loop", sourcePort: "loop", target: "agent", targetPort: "feedback", condition: { branch: "loop" } },
    { id: "loop-output", source: "loop", sourcePort: "done", target: "output", targetPort: "result", condition: { branch: "done" } },
  ],
  start: ["input"],
  end: ["output"],
};

describe("graph repository", () => {
  it("persists project-scoped graphs, viewport, and definitions across restart", () => {
    const database = createDatabase(":memory:");
    const projectId = "project-1";
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)").run(projectId, "/tmp/project", "Project", "now", "now");
    const graphs = createGraphRepository(database);
    const created = graphs.createGraph({ projectId, name: "Review loop", description: "Iterative review", definition, viewport: { x: 120, y: 48, zoom: 0.9 }, positions: { agent: { x: 80, y: 120 } } });

    expect(graphs.listGraphs(projectId)).toEqual([expect.objectContaining({ id: created.id, name: "Review loop" })]);
    expect(createGraphRepository(database).getGraph(created.id)).toMatchObject({
      description: "Iterative review",
      definition,
      viewport: { x: 120, y: 48, zoom: 0.9 },
      positions: { agent: { x: 80, y: 120 } },
    });

    const updated = graphs.updateGraph(created.id, { name: "Review loop v2", viewport: { x: 0, y: 0, zoom: 1 } });
    expect(updated?.name).toBe("Review loop v2");
    expect(graphs.deleteGraph(created.id)).toBe(true);
    expect(graphs.getGraph(created.id)).toBeNull();
    database.close();
  });

  it("archives and forks graphs without copying run history", () => {
    const database = createDatabase(":memory:");
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)").run("project-1", "/tmp/project", "Project", "now", "now");
    const graphs = createGraphRepository(database);
    const original = graphs.createGraph({ projectId: "project-1", name: "Review", description: "", definition, viewport: { x: 0, y: 0, zoom: 1 }, positions: {} });
    const run = graphs.createRun(original.id, "draft");
    graphs.finishRun(run.id, "completed", "done");

    const fork = graphs.forkGraph(original.id);
    expect(fork).toMatchObject({ projectId: "project-1", name: "Review (branch)", definition, archivedAt: null });
    expect(graphs.getLatestRun(fork!.id)).toBeNull();
    expect(graphs.archiveGraph(original.id, true)).toBe("updated");
    expect(graphs.listGraphs("project-1")).toEqual([expect.objectContaining({ id: fork!.id })]);
    expect(graphs.listGraphs("project-1", true)).toEqual([expect.objectContaining({ id: original.id, archivedAt: expect.any(String) })]);
    database.close();
  });

  it("persists graph runs, node runs, ordered events, and restart interruption", () => {
    const database = createDatabase(":memory:");
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)").run("project-1", "/tmp/project", "Project", "now", "now");
    const graphs = createGraphRepository(database);
    const graph = graphs.createGraph({ projectId: "project-1", name: "Loop", description: "", definition, viewport: { x: 0, y: 0, zoom: 1 }, positions: {} });
    const run = graphs.createRun(graph.id, "Draft");
    graphs.appendRunEvent(run.id, "run_started", null, { input: "Draft" });
    const nodeRun = graphs.startNodeRun(run.id, "agent", 1, "Draft");
    graphs.finishNodeRun(nodeRun.id, "completed", "Reviewed");
    graphs.appendRunEvent(run.id, "node_completed", "agent", { output: "Reviewed" });

    expect(graphs.getRun(run.id)).toMatchObject({ status: "running", input: "Draft" });
    expect(graphs.listNodeRuns(run.id)).toEqual([
      expect.objectContaining({ nodeId: "agent", iteration: 1, status: "completed", output: "Reviewed" }),
    ]);
    expect(graphs.eventsAfter(run.id, 0).map((event) => event.sequence)).toEqual([1, 2]);
    expect(graphs.interruptActiveRuns()).toBe(1);
    expect(graphs.getRun(run.id)?.status).toBe("interrupted");
    database.close();
  });

  it("freezes the graph snapshot and structured node values for each run", () => {
    const database = createDatabase(":memory:");
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)").run("project-1", "/tmp/project", "Project", "now", "now");
    const graphs = createGraphRepository(database);
    const graph = graphs.createGraph({ projectId: "project-1", name: "Snapshot", description: "", definition, viewport: { x: 4, y: 8, zoom: 0.8 }, positions: { agent: { x: 10, y: 20 } } });
    const run = (graphs.createRun as (...args: unknown[]) => ReturnType<typeof graphs.createRun>)(graph.id, { task: "Draft" }, graph);
    const nodeRun = (graphs.startNodeRun as (...args: unknown[]) => ReturnType<typeof graphs.startNodeRun>)(run.id, "agent", 1, { brief: "Draft" });
    (graphs.finishNodeRun as (...args: unknown[]) => void)(nodeRun.id, "completed", { plan: "Reviewed" });
    graphs.updateGraph(graph.id, { name: "Changed", positions: { agent: { x: 999, y: 999 } } });

    expect(graphs.getRun(run.id)).toMatchObject({ inputValues: { task: "Draft" }, graphSnapshot: { name: "Snapshot", positions: { agent: { x: 10, y: 20 } } } });
    expect(graphs.listNodeRuns(run.id)).toEqual([expect.objectContaining({ inputValues: { brief: "Draft" }, outputValues: { plan: "Reviewed" } })]);
    expect((graphs as unknown as { listRuns(id: string): unknown[] }).listRuns(graph.id)).toHaveLength(1);
    database.close();
  });

  it("deletes a finished run and its node history but refuses an active run", () => {
    const database = createDatabase(":memory:");
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)").run("project-1", "/tmp/project", "Project", "now", "now");
    const graphs = createGraphRepository(database);
    const graph = graphs.createGraph({ projectId: "project-1", name: "History", description: "", definition, viewport: { x: 0, y: 0, zoom: 1 }, positions: {} });
    const run = graphs.createRun(graph.id, { task: "Draft" }, graph);
    graphs.startNodeRun(run.id, "agent", 1, { task: "Draft" });
    graphs.appendRunEvent(run.id, "node_started", "agent", { iteration: 1 });

    expect(graphs.deleteRun(run.id)).toBe("run_active");
    graphs.finishRun(run.id, "completed", { result: "Done" });
    expect(graphs.deleteRun(run.id)).toBe("deleted");
    expect(graphs.getRun(run.id)).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM graph_node_runs WHERE run_id = ?").get(run.id)).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM graph_run_events WHERE run_id = ?").get(run.id)).toEqual({ count: 0 });
    expect(graphs.deleteRun(run.id)).toBe("not_found");
    database.close();
  });
});
