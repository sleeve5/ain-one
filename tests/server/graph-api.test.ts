import { describe, expect, it } from "vitest";
import { createApiServer } from "../../src/server/api.js";
import { createDatabase } from "../../src/server/db.js";
import { createGraphRepository } from "../../src/server/graph-repository.js";
import { createRepositories } from "../../src/server/repositories.js";
import type { GraphDefinition, GraphRun } from "../../src/shared/contracts.js";

const TOKEN = "graph-api-token";
const definition: GraphDefinition = {
  nodes: [
    { id: "input", type: "input", name: "Input", config: { fields: [{ id: "input", name: "Input", description: "", required: true, multiline: true }] } },
    { id: "agent", type: "agent", name: "Agent", config: { agentProductId: "codex", modelId: null, permissionMode: "request_approval", instruction: "Work", inputs: [{ id: "input", name: "Input", required: true }, { id: "feedback", name: "Feedback", kind: "feedback" }], outputs: [{ id: "result", name: "Result" }] } },
    { id: "loop", type: "loop_counter", name: "Loop", config: { maxIterations: 2 } },
    { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
  ],
  edges: [
    { id: "input-agent", source: "input", sourcePort: "input", target: "agent", targetPort: "input" },
    { id: "agent-loop", source: "agent", sourcePort: "result", target: "loop", targetPort: "input" },
    { id: "loop-agent", source: "loop", sourcePort: "loop", target: "agent", targetPort: "feedback", condition: { branch: "loop" } },
    { id: "done", source: "loop", sourcePort: "done", target: "output", targetPort: "result", condition: { branch: "done" } },
  ],
  start: ["input"], end: ["output"],
};

describe("graph API", () => {
  it("rejects archiving a Project while one of its Graph Runs is active", async () => {
    const database = createDatabase(":memory:");
    const repositories = createRepositories(database);
    const project = repositories.createProject("/tmp/p1", "P1");
    const graphs = createGraphRepository(database);
    const graph = graphs.createGraph({ projectId: project.id, name: "Loop", description: "", definition, viewport: { x: 0, y: 0, zoom: 1 }, positions: {} });
    graphs.createRun(graph.id, "draft");
    const api = createApiServer({
      host: "127.0.0.1", port: 0, token: TOKEN, repositories,
      turnCoordinator: stubCoordinator(), graphRepository: graphs,
    });
    await api.start();
    try {
      const response = await fetch(`${api.url}/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "graph_run_active" } });
      expect(repositories.getProject(project.id)?.archivedAt).toBeNull();
      expect(graphs.getRun(graphs.getLatestRun(graph.id)!.id)?.status).toBe("running");
    } finally { await api.stop(); database.close(); }
  });

  it("rejects deleting an archived Project while one of its Graph Runs is active", async () => {
    const database = createDatabase(":memory:");
    const repositories = createRepositories(database);
    const project = repositories.createProject("/tmp/p1", "P1");
    const graphs = createGraphRepository(database);
    const graph = graphs.createGraph({ projectId: project.id, name: "Loop", description: "", definition, viewport: { x: 0, y: 0, zoom: 1 }, positions: {} });
    const run = graphs.createRun(graph.id, "draft");
    database.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), project.id);
    const api = createApiServer({
      host: "127.0.0.1", port: 0, token: TOKEN, repositories,
      turnCoordinator: stubCoordinator(), graphRepository: graphs,
    });
    await api.start();
    try {
      const response = await fetch(`${api.url}/api/projects/${project.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "graph_run_active" } });
      expect(repositories.getProject(project.id)).not.toBeNull();
      expect(graphs.getGraph(graph.id)).not.toBeNull();
      expect(graphs.getRun(run.id)?.status).toBe("running");
    } finally { await api.stop(); database.close(); }
  });

  it("provides scoped CRUD, validates saves, and starts and cancels runs", async () => {
    const database = createDatabase(":memory:");
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)").run("p1", "/tmp/p1", "P1", "now", "now");
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)").run("p2", "/tmp/p2", "P2", "now", "now");
    const graphs = createGraphRepository(database);
    const calls: string[] = [];
    const api = createApiServer({
      host: "127.0.0.1", port: 0, token: TOKEN, repositories: stubRepositories() as never,
      turnCoordinator: stubCoordinator(), graphRepository: graphs,
      graphRuntime: {
        start: (graphId, input) => {
          calls.push(`run:${graphId}:${input}`);
          const run = graphs.createRun(graphId, input, graphs.getGraph(graphId)!);
          return { run, completion: Promise.resolve(run) };
        },
        cancel: async (runId) => { calls.push(`cancel:${runId}`); return true; },
      },
      ssePollMs: 5, sseHeartbeatMs: 50,
    });
    await api.start();
    const request = (path: string, init: RequestInit = {}) => fetch(`${api.url}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers } });
    try {
      const createdResponse = await request("/api/projects/p1/graphs", { method: "POST", body: JSON.stringify({ name: "Loop", description: "Review", definition, viewport: { x: 1, y: 2, zoom: 0.8 }, positions: { loop: { x: 10, y: 20 } } }) });
      expect(createdResponse.status).toBe(201);
      const graph = (await createdResponse.json() as { graph: { id: string } }).graph;
      expect(await (await request("/api/projects/p1/graphs")).json()).toMatchObject({ graphs: [{ id: graph.id }] });
      expect(await (await request("/api/projects/p2/graphs")).json()).toEqual({ graphs: [] });

      const draft = await request(`/api/graphs/${graph.id}`, { method: "PUT", body: JSON.stringify({ definition: { ...definition, start: [] } }) });
      expect(draft.status).toBe(200);
      expect(graphs.getGraph(graph.id)?.definition.start).toEqual([]);
      const unavailableRun = await request(`/api/graphs/${graph.id}/runs`, { method: "POST", body: JSON.stringify({ input: "draft" }) });
      expect(unavailableRun.status).toBe(400);
      await request(`/api/graphs/${graph.id}`, { method: "PUT", body: JSON.stringify({ definition }) });
      const malformed = await request(`/api/graphs/${graph.id}`, { method: "PUT", body: JSON.stringify({ definition: {} }) });
      expect(malformed.status).toBe(400);
      const invalidViewport = await request(`/api/graphs/${graph.id}`, { method: "PUT", body: JSON.stringify({ viewport: { x: "left", y: 0, zoom: 1 } }) });
      expect(invalidViewport.status).toBe(400);

      const runResponse = await request(`/api/graphs/${graph.id}/runs`, { method: "POST", body: JSON.stringify({ input: "draft" }) });
      expect(runResponse.status).toBe(202);
      const run = (await runResponse.json() as { run: { id: string } }).run;
      expect(await (await request(`/api/graphs/${graph.id}/runs`)).json()).toMatchObject({ runs: [{ id: run.id, graphSnapshot: { name: "Loop" } }] });
      expect((await request(`/api/graphs/${graph.id}`, { method: "DELETE" })).status).toBe(409);
      await request(`/api/graph-runs/${run.id}/cancel`, { method: "POST", body: "{}" });
      expect(calls).toEqual([`run:${graph.id}:draft`, `cancel:${run.id}`]);
      graphs.finishRun(run.id, "cancelled");
      expect((await request(`/api/graph-runs/${run.id}`, { method: "DELETE" })).status).toBe(204);
      expect(graphs.getRun(run.id)).toBeNull();
      expect((await request(`/api/graphs/${graph.id}`, { method: "DELETE" })).status).toBe(409);
      expect((await request(`/api/graphs/${graph.id}`, { method: "PUT", body: JSON.stringify({ archived: true }) })).status).toBe(200);
      expect((await request(`/api/graphs/${graph.id}`, { method: "DELETE" })).status).toBe(204);
    } finally { await api.stop(); database.close(); }
  });

  it("renames, archives, lists, and forks Graphs through the API", async () => {
    const database = createDatabase(":memory:");
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)").run("p1", "/tmp/p1", "P1", "now", "now");
    const graphs = createGraphRepository(database);
    const original = graphs.createGraph({ projectId: "p1", name: "Loop", description: "", definition, viewport: { x: 0, y: 0, zoom: 1 }, positions: {} });
    const api = createApiServer({ host: "127.0.0.1", port: 0, token: TOKEN, repositories: stubRepositories() as never, turnCoordinator: stubCoordinator(), graphRepository: graphs });
    await api.start();
    const request = (path: string, init: RequestInit = {}) => fetch(`${api.url}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...init.headers } });
    try {
      const renamed = await request(`/api/graphs/${original.id}`, { method: "PUT", body: JSON.stringify({ name: "Pipeline" }) });
      expect(await renamed.json()).toMatchObject({ graph: { name: "Pipeline" } });
      const forked = await request(`/api/graphs/${original.id}/fork`, { method: "POST", body: "{}" });
      expect(await forked.json()).toMatchObject({ graph: { name: "Pipeline (branch)" } });
      const archived = await request(`/api/graphs/${original.id}`, { method: "PUT", body: JSON.stringify({ archived: true }) });
      expect(await archived.json()).toMatchObject({ graph: { id: original.id, archivedAt: expect.any(String) } });
      const rejected = await request(`/api/graphs/${original.id}`, { method: "PUT", body: JSON.stringify({ archived: false, name: "" }) });
      expect(rejected.status).toBe(400);
      expect(graphs.getGraph(original.id)?.archivedAt).toEqual(expect.any(String));
      expect(await (await request("/api/projects/p1/graphs")).json()).toMatchObject({ graphs: [{ name: "Pipeline (branch)" }] });
      expect(await (await request("/api/projects/p1/graphs?archived=true")).json()).toMatchObject({ graphs: [{ id: original.id }] });
    } finally { await api.stop(); database.close(); }
  });

  it("returns not found when deleting a Graph that does not exist", async () => {
    const database = createDatabase(":memory:");
    const api = createApiServer({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      repositories: stubRepositories() as never,
      turnCoordinator: stubCoordinator(),
      graphRepository: createGraphRepository(database),
    });
    await api.start();
    try {
      const response = await fetch(`${api.url}/api/graphs/missing`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "graph_not_found" },
      });
    } finally {
      await api.stop();
      database.close();
    }
  });

  it("replays persisted run events over SSE", async () => {
    const database = createDatabase(":memory:");
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)").run("p1", "/tmp/p1", "P1", "now", "now");
    const graphs = createGraphRepository(database);
    const graph = graphs.createGraph({ projectId: "p1", name: "Loop", description: "", definition, viewport: { x: 0, y: 0, zoom: 1 }, positions: {} });
    const run = graphs.createRun(graph.id, "draft");
    graphs.appendRunEvent(run.id, "node_started", "loop", { iteration: 1 });
    const api = createApiServer({ host: "127.0.0.1", port: 0, token: TOKEN, repositories: stubRepositories() as never, turnCoordinator: stubCoordinator(), graphRepository: graphs, graphRuntime: { start: () => ({ run, completion: Promise.resolve(run) }), cancel: async () => false }, ssePollMs: 5 });
    await api.start();
    try {
      const response = await fetch(`${api.url}/api/graph-runs/${run.id}/events?after=0`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const chunk = await reader.read();
      expect(new TextDecoder().decode(chunk.value)).toContain('"type":"node_started"');
      await reader.cancel();
    } finally { await api.stop(); database.close(); }
  });

  it("does not return an older run when a new run fails before creation", async () => {
    const database = createDatabase(":memory:");
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)").run("p1", "/tmp/p1", "P1", "now", "now");
    const graphs = createGraphRepository(database);
    const graph = graphs.createGraph({ projectId: "p1", name: "Loop", description: "", definition, viewport: { x: 0, y: 0, zoom: 1 }, positions: {} });
    graphs.finishRun(graphs.createRun(graph.id, "previous").id, "completed", "done");
    const api = createApiServer({
      host: "127.0.0.1", port: 0, token: TOKEN, repositories: stubRepositories() as never,
      turnCoordinator: stubCoordinator(), graphRepository: graphs,
      graphRuntime: {
        start: () => { throw new Error("Input is required"); },
        cancel: async () => false,
      },
    });
    await api.start();
    try {
      const response = await fetch(`${api.url}/api/graphs/${graph.id}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ input: "" }),
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: "Input is required" },
      });
    } finally { await api.stop(); database.close(); }
  });

  it("returns the run created for each concurrent fast request", async () => {
    const database = createDatabase(":memory:");
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)").run("p1", "/tmp/p1", "P1", "now", "now");
    const graphs = createGraphRepository(database);
    const graph = graphs.createGraph({ projectId: "p1", name: "Loop", description: "", definition, viewport: { x: 0, y: 0, zoom: 1 }, positions: {} });
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const api = createApiServer({
      host: "127.0.0.1", port: 0, token: TOKEN, repositories: stubRepositories() as never,
      turnCoordinator: stubCoordinator(), graphRepository: graphs,
      graphRuntime: {
        start: async (graphId, input) => {
          const run = graphs.createRun(graphId, input, graphs.getGraph(graphId)!);
          graphs.finishRun(run.id, "completed", input);
          started += 1;
          if (started === 2) release();
          await bothStarted;
          const completed = graphs.getRun(run.id)!;
          return { run: completed, completion: Promise.resolve(completed) };
        },
        cancel: async () => false,
      },
    });
    await api.start();
    const request = (input: string) => fetch(`${api.url}/api/graphs/${graph.id}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });
    try {
      const [firstResponse, secondResponse] = await Promise.all([request("first"), request("second")]);
      expect(firstResponse.status).toBe(202);
      expect(secondResponse.status).toBe(202);
      const first = (await firstResponse.json() as { run: GraphRun }).run;
      const second = (await secondResponse.json() as { run: GraphRun }).run;
      expect(first).toMatchObject({ input: "first", output: "first" });
      expect(second).toMatchObject({ input: "second", output: "second" });
      expect(first.id).not.toBe(second.id);
    } finally { await api.stop(); database.close(); }
  });
});

function stubCoordinator() { return { enqueueMessage: async () => undefined, cancelActiveTurn: async () => false, continueConversation: async () => false, retryInterruptedTurn: async () => false }; }
function stubRepositories() {
  return new Proxy({}, { get: (_target, key) => {
    if (key === "getProject") return (id: string) => id === "p1" || id === "p2" ? { id, path: `/tmp/${id}` } : null;
    if (key === "eventsAfter") return () => [];
    return () => null;
  } });
}
