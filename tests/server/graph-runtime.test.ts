import { describe, expect, it } from "vitest";
import type { AgentConnector, GraphDefinition, LiveSession, SessionInput } from "../../src/shared/contracts.js";
import { createDatabase } from "../../src/server/db.js";
import { createGraphRepository } from "../../src/server/graph-repository.js";
import { GraphRuntime } from "../../src/server/graph-runtime.js";

function definition(maxIterations = 3): GraphDefinition {
  return {
    nodes: [
      { id: "input", type: "input", name: "Input", config: { fields: [{ id: "input", name: "Input", description: "", required: true, multiline: true }] } },
      { id: "agent", type: "agent", name: "Agent", config: { agentProductId: "codex", modelId: "gpt-test", permissionMode: "request_approval", instruction: "Improve: {{input}}", inputs: [{ id: "input", name: "Input", required: true }, { id: "feedback", name: "Feedback", kind: "feedback" }], outputs: [{ id: "result", name: "Result" }] } },
      { id: "loop", type: "loop_counter", name: "Loop", config: { maxIterations } },
      { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
    ],
    edges: [
      { id: "i-a", source: "input", sourcePort: "input", target: "agent", targetPort: "input" },
      { id: "a-l", source: "agent", sourcePort: "result", target: "loop", targetPort: "input" },
      { id: "l-a", source: "loop", sourcePort: "loop", target: "agent", targetPort: "feedback", condition: { branch: "loop" } },
      { id: "l-o", source: "loop", sourcePort: "done", target: "output", targetPort: "result", condition: { branch: "done" } },
    ],
    start: ["input"], end: ["output"],
  };
}

describe("graph runtime", () => {
  it("returns the created run before its execution completes", async () => {
    const fixture = createFixture(definition(1));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new GraphRuntime({
      repository: fixture.repository,
      connectors: { codex: fakeConnector(async () => { await gate; return "done"; }) },
      projectPath: () => "/tmp/project",
    });

    const started = runtime.start(fixture.graphId, "draft");

    expect(started.run).toMatchObject({ graphId: fixture.graphId, status: "running", input: "draft" });
    expect(fixture.repository.getRun(started.run.id)?.id).toBe(started.run.id);
    release();
    await expect(started.completion).resolves.toMatchObject({ id: started.run.id, status: "completed" });
    fixture.database.close();
  });

  it("rejects missing required user input before creating a run", async () => {
    const fixture = createFixture(dataflowDefinition());
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: {}, projectPath: () => "/tmp/project" });

    await expect(runtime.run(fixture.graphId, { task: "   " })).rejects.toThrow("Task");
    expect(fixture.repository.getLatestRun(fixture.graphId)).toBeNull();
    fixture.database.close();
  });

  it("passes named Input values into an Agent and collects named Output values", async () => {
    const fixture = createFixture({
      nodes: [
        { id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }, { id: "context", name: "Context", description: "", required: false, multiline: true }] } },
        { id: "agent", type: "agent", name: "Planner", config: { agentProductId: "codex", modelId: "gpt-test", permissionMode: "request_approval", instruction: "Create a plan", inputs: [{ id: "brief", name: "Brief", required: true }, { id: "context", name: "Context", required: false }], outputs: [{ id: "plan", name: "Plan" }] } },
        { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
      ],
      edges: [
        { id: "task", source: "input", sourcePort: "task", target: "agent", targetPort: "brief" },
        { id: "context", source: "input", sourcePort: "context", target: "agent", targetPort: "context" },
        { id: "result", source: "agent", sourcePort: "plan", target: "output", targetPort: "result" },
      ],
      start: ["input"], end: ["output"],
    } as GraphDefinition);
    let received = "";
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: { codex: fakeConnector((content) => { received = content; return "A concise plan"; }) }, projectPath: () => "/tmp/project" });

    const run = await (runtime.run as (...args: unknown[]) => Promise<ReturnType<typeof fixture.repository.getRun>>)(fixture.graphId, { task: "Build it", context: "Existing app" });

    expect(received).toContain("Create a plan");
    expect(received).toContain("Brief:\nBuild it");
    expect(received).toContain("Context:\nExisting app");
    expect(run).toMatchObject({ status: "completed", outputValues: { result: "A concise plan" } });
    expect(fixture.repository.listNodeRuns(run!.id).find((item) => item.nodeId === "agent")).toMatchObject({ inputValues: { brief: "Build it", context: "Existing app" }, outputValues: { plan: "A concise plan" } });
    fixture.database.close();
  });

  it("waits for connected fan-in values and fans one output out to multiple targets", async () => {
    const fixture = createFixture({
      nodes: [
        { id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }, { id: "context", name: "Context", description: "", required: false, multiline: true }] } },
        { id: "writer", type: "agent", name: "Writer", config: { agentProductId: "codex", modelId: "gpt-test", permissionMode: "request_approval", instruction: "Write", inputs: [{ id: "task", name: "Task", required: true }, { id: "context", name: "Context", required: false }], outputs: [{ id: "draft", name: "Draft" }] } },
        { id: "reviewer", type: "agent", name: "Reviewer", config: { agentProductId: "codex", modelId: "gpt-test", permissionMode: "request_approval", instruction: "Review", inputs: [{ id: "draft", name: "Draft", required: true }], outputs: [{ id: "result", name: "Result" }] } },
        { id: "output", type: "output", name: "Output", config: { fields: [{ id: "draft", name: "Draft" }, { id: "review", name: "Review" }] } },
      ],
      edges: [
        { id: "task", source: "input", sourcePort: "task", target: "writer", targetPort: "task" },
        { id: "context", source: "input", sourcePort: "context", target: "writer", targetPort: "context" },
        { id: "review", source: "writer", sourcePort: "draft", target: "reviewer", targetPort: "draft" },
        { id: "draft-output", source: "writer", sourcePort: "draft", target: "output", targetPort: "draft" },
        { id: "review-output", source: "reviewer", sourcePort: "result", target: "output", targetPort: "review" },
      ],
      start: ["input"], end: ["output"],
    });
    const prompts: string[] = [];
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: { codex: fakeConnector((content, iteration) => { prompts.push(content); return iteration === 1 ? "draft text" : "approved"; }) }, projectPath: () => "/tmp/project" });

    const run = await runtime.run(fixture.graphId, { task: "Build", context: "Use TypeScript" });

    expect(prompts[0]).toContain("Context:\nUse TypeScript");
    expect(run.outputValues).toEqual({ draft: "draft text", review: "approved" });
    fixture.database.close();
  });

  it("parses named Agent outputs from JSON", async () => {
    const graph = dataflowDefinition();
    const agent = graph.nodes.find((node) => node.type === "agent")!;
    if (agent.type !== "agent") throw new Error("expected Agent");
    agent.config.outputs = [{ id: "summary", name: "Summary" }, { id: "details", name: "Details" }];
    graph.edges = [
      graph.edges[0]!,
      { id: "summary", source: "agent", sourcePort: "summary", target: "output", targetPort: "result" },
    ];
    const fixture = createFixture(graph);
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: { codex: fakeConnector(() => '{"summary":"short","details":"long"}') }, projectPath: () => "/tmp/project" });

    const run = await runtime.run(fixture.graphId, { task: "Summarize" });

    expect(fixture.repository.listNodeRuns(run.id).find((item) => item.nodeId === "agent")?.outputValues).toEqual({ summary: "short", details: "long" });
    expect(run.outputValues).toEqual({ result: "short" });
    fixture.database.close();
  });

  it("consumes each Loop feedback value once while retaining regular Agent inputs", async () => {
    const graph = dataflowDefinition();
    const agent = graph.nodes.find((node) => node.type === "agent")!;
    if (agent.type !== "agent") throw new Error("expected Agent");
    agent.config.inputs = [{ id: "task", name: "Task", required: true }, { id: "feedback", name: "循环输入", kind: "feedback" }];
    graph.nodes.splice(2, 0, { id: "loop", type: "loop_counter", name: "Loop", config: { maxIterations: 3 } });
    graph.edges = [
      graph.edges[0]!,
      { id: "agent-loop", source: "agent", sourcePort: "result", target: "loop", targetPort: "input" },
      { id: "loop-agent", source: "loop", sourcePort: "loop", target: "agent", targetPort: "feedback", condition: { branch: "loop" } },
      { id: "loop-output", source: "loop", sourcePort: "done", target: "output", targetPort: "result", condition: { branch: "done" } },
    ];
    const fixture = createFixture(graph);
    const prompts: string[] = [];
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: { codex: fakeConnector((content, iteration) => { prompts.push(content); return `version ${iteration}`; }) }, projectPath: () => "/tmp/project" });

    const run = await runtime.run(fixture.graphId, { task: "Improve this" });

    expect(run).toMatchObject({ status: "completed", outputValues: { result: "version 3" } });
    expect(prompts).toHaveLength(3);
    expect(prompts.every((prompt) => prompt.includes("Task:\nImprove this"))).toBe(true);
    expect(prompts[1]).toContain("循环输入:\nversion 1");
    expect(prompts[2]).toContain("循环输入:\nversion 2");
    fixture.database.close();
  });

  it("renders named Agent input references without duplicating the parameter block", async () => {
    const graph = dataflowDefinition();
    const agent = graph.nodes.find((node) => node.type === "agent")!;
    if (agent.type !== "agent") throw new Error("expected Agent");
    agent.config.instruction = "Theme: {{task}}\nReference: {{feedback}}";
    agent.config.inputs = [{ id: "task", name: "Theme", required: true }, { id: "feedback", name: "Reference", kind: "feedback" }];
    graph.nodes.splice(2, 0, { id: "loop", type: "loop_counter", name: "Loop", config: { maxIterations: 2 } });
    graph.edges = [
      graph.edges[0]!,
      { id: "agent-loop", source: "agent", sourcePort: "result", target: "loop", targetPort: "input" },
      { id: "loop-agent", source: "loop", sourcePort: "loop", target: "agent", targetPort: "feedback", condition: { branch: "loop" } },
      { id: "loop-output", source: "loop", sourcePort: "done", target: "output", targetPort: "result", condition: { branch: "done" } },
    ];
    const fixture = createFixture(graph);
    const prompts: string[] = [];
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: { codex: fakeConnector((content, iteration) => { prompts.push(content); return `version ${iteration}`; }) }, projectPath: () => "/tmp/project" });

    const run = await runtime.run(fixture.graphId, { task: "Write a poem" });

    expect(run.status).toBe("completed");
    expect(prompts).toEqual([
      "Theme: Write a poem\nReference: ",
      "Theme: Write a poem\nReference: version 1",
    ]);
    fixture.database.close();
  });

  it("renders an input port reference exactly once when its stable id is input", async () => {
    const graph = dataflowDefinition();
    const input = graph.nodes.find((node) => node.type === "input")!;
    const agent = graph.nodes.find((node) => node.type === "agent")!;
    if (input.type !== "input" || agent.type !== "agent") throw new Error("expected dataflow nodes");
    input.config.fields = [{ id: "input", name: "Topic", description: "", required: true, multiline: true }];
    agent.config.inputs = [{ id: "input", name: "Topic", required: true }];
    agent.config.instruction = "Write about {{input}}";
    graph.edges[0] = { ...graph.edges[0]!, sourcePort: "input", targetPort: "input" };
    const fixture = createFixture(graph);
    let prompt = "";
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: { codex: fakeConnector((content) => { prompt = content; return "done"; }) }, projectPath: () => "/tmp/project" });

    await runtime.run(fixture.graphId, { input: "Shanghai" });

    expect(prompt).toBe("Write about Shanghai");
    fixture.database.close();
  });

  it("executes a Connector-backed Agent loop three times and persists output", async () => {
    const fixture = createFixture(definition());
    const turnIds: string[] = [];
    const connector = fakeConnector((content, iteration, turnId) => { turnIds.push(turnId); return `reply ${iteration}: ${content}`; });
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: { codex: connector }, projectPath: () => "/tmp/project" });

    const run = await runtime.run(fixture.graphId, "draft");

    expect(run.status).toBe("completed");
    expect(run.outputValues?.result).toContain("reply 3");
    expect(fixture.repository.listNodeRuns(run.id).filter((item) => item.nodeId === "agent")).toHaveLength(3);
    expect(new Set(turnIds)).toHaveProperty("size", 3);
    expect(turnIds).toEqual([
      `graph:${run.id}:agent:1`,
      `graph:${run.id}:agent:2`,
      `graph:${run.id}:agent:3`,
    ]);
    expect(fixture.repository.eventsAfter(run.id, 0).map((event) => event.type)).toContain("run_completed");
    fixture.database.close();
  });

  it("fails invalid graphs before creating a run", async () => {
    const fixture = createFixture({ ...definition(), start: [] });
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: {}, projectPath: () => "/tmp/project" });
    await expect(runtime.run(fixture.graphId, "draft")).rejects.toThrow("start");
    expect(fixture.repository.getLatestRun(fixture.graphId)).toBeNull();
    fixture.database.close();
  });

  it("persists connector failure and supports cancellation", async () => {
    const failed = createFixture(definition(1));
    const failing = fakeConnector(() => { throw new Error("agent exploded"); });
    const failureRuntime = new GraphRuntime({ repository: failed.repository, connectors: { codex: failing }, projectPath: () => "/tmp/project" });
    expect((await failureRuntime.run(failed.graphId, "draft")).status).toBe("failed");
    expect(failed.repository.getLatestRun(failed.graphId)?.error?.message).toContain("agent exploded");
    failed.database.close();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = createFixture(definition(1));
    const connector = fakeConnector(async () => { await gate; return "late"; });
    const runtime = new GraphRuntime({ repository: pending.repository, connectors: { codex: connector }, projectPath: () => "/tmp/project" });
    const running = runtime.run(pending.graphId, "draft");
    await until(() => pending.repository.getLatestRun(pending.graphId)?.status === "running");
    expect(await runtime.cancel(pending.repository.getLatestRun(pending.graphId)!.id)).toBe(true);
    release();
    expect((await running).status).toBe("cancelled");
    pending.database.close();
  });

  it("finishes cancellation when the Connector confirms without emitting a terminal event", async () => {
    const fixture = createFixture(definition(1));
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const connector = fakeConnector(async () => { started(); return await new Promise<string>(() => undefined); });
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: { codex: connector }, projectPath: () => "/tmp/project" });
    const running = runtime.run(fixture.graphId, "draft");
    await startedPromise;
    const runId = fixture.repository.getLatestRun(fixture.graphId)!.id;
    await runtime.cancel(runId);
    expect(fixture.repository.getRun(runId)?.status).toBe("cancelled");
    await expect(Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timed out")), 100))]))
      .resolves.toMatchObject({ status: "cancelled" });
    fixture.database.close();
  });

  it("finishes local cancellation when the Connector cancellation request fails", async () => {
    const fixture = createFixture(definition(1));
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const connector = fakeConnector(async () => { started(); return await new Promise<string>(() => undefined); });
    connector.cancelTurn = async () => { throw new Error("native cancel unavailable"); };
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: { codex: connector }, projectPath: () => "/tmp/project" });
    const running = runtime.run(fixture.graphId, "draft");
    await startedPromise;
    const runId = fixture.repository.getLatestRun(fixture.graphId)!.id;

    await expect(runtime.cancel(runId)).resolves.toBe(true);
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    expect(fixture.repository.getRun(runId)?.status).toBe("cancelled");
    fixture.database.close();
  });

  it("finishes local cancellation when the Connector cancellation request hangs", async () => {
    const fixture = createFixture(definition(1));
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const connector = fakeConnector(async () => { started(); return await new Promise<string>(() => undefined); });
    connector.cancelTurn = async () => await new Promise(() => undefined);
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: { codex: connector }, projectPath: () => "/tmp/project" });
    const running = runtime.run(fixture.graphId, "draft");
    await startedPromise;
    const runId = fixture.repository.getLatestRun(fixture.graphId)!.id;

    await expect(Promise.race([
      runtime.cancel(runId),
      new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timed out")), 100)),
    ])).resolves.toBe(true);
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    fixture.database.close();
  });

  it("does not start an Agent Turn after cancellation during session creation", async () => {
    const fixture = createFixture(definition(1));
    let releaseSession!: () => void;
    const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
    let startTurnCalls = 0;
    const connector = fakeConnector(async () => "late");
    connector.createOrResumeSession = async () => {
      await sessionGate;
      return { id: "session", nativeSessionId: null };
    };
    connector.startTurn = async () => {
      startTurnCalls += 1;
      return { nativeTurnId: "native" };
    };
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: { codex: connector }, projectPath: () => "/tmp/project" });
    const running = runtime.run(fixture.graphId, "draft");
    await until(() => fixture.repository.getLatestRun(fixture.graphId)?.status === "running");
    const runId = fixture.repository.getLatestRun(fixture.graphId)!.id;

    const cancelling = runtime.cancel(runId);
    releaseSession();

    await expect(cancelling).resolves.toBe(true);
    await expect(running).resolves.toMatchObject({ status: "cancelled" });
    expect(startTurnCalls).toBe(0);
    fixture.database.close();
  });

  it("cancels active runs during shutdown", async () => {
    const fixture = createFixture(definition(1));
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const runtime = new GraphRuntime({ repository: fixture.repository, connectors: { codex: fakeConnector(async () => { started(); return await new Promise<string>(() => undefined); }) }, projectPath: () => "/tmp/project" });
    void runtime.run(fixture.graphId, "draft");
    await startedPromise;
    await runtime.shutdown();
    expect(fixture.repository.getLatestRun(fixture.graphId)?.status).toBe("cancelled");
    fixture.database.close();
  });
});

function dataflowDefinition(): GraphDefinition {
  return {
    nodes: [
      { id: "input", type: "input", name: "Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } },
      { id: "agent", type: "agent", name: "Agent", config: { agentProductId: "codex", modelId: "gpt-test", permissionMode: "request_approval", instruction: "Work", inputs: [{ id: "task", name: "Task", required: true }], outputs: [{ id: "result", name: "Result" }] } },
      { id: "output", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
    ],
    edges: [
      { id: "input-agent", source: "input", sourcePort: "task", target: "agent", targetPort: "task" },
      { id: "agent-output", source: "agent", sourcePort: "result", target: "output", targetPort: "result" },
    ],
    start: ["input"], end: ["output"],
  };
}

function createFixture(graphDefinition: GraphDefinition) {
  const database = createDatabase(":memory:");
  database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)").run("project-1", "/tmp/project", "Project", "now", "now");
  const repository = createGraphRepository(database);
  const graphId = repository.createGraph({ projectId: "project-1", name: "Loop", description: "", definition: graphDefinition, viewport: { x: 0, y: 0, zoom: 1 }, positions: {} }).id;
  return { database, repository, graphId };
}

function fakeConnector(respond: (content: string, iteration: number, turnId: string) => string | Promise<string>): AgentConnector {
  let iteration = 0;
  const sessions = new Map<string, SessionInput>();
  return {
    id: "codex", probe: async () => ({ status: "available" }), fetchCatalog: async () => ({ models: ["gpt-test"], permissionModes: ["request_approval"] }),
    createOrResumeSession: async (input) => { sessions.set(input.conversationId, input); return { id: input.conversationId, nativeSessionId: null }; },
    startTurn: async (session, input) => {
      const target = sessions.get(session.id)!;
      try {
        const text = await respond(input.content, ++iteration, input.turnId ?? "");
        await target.onEvent?.({ type: "assistant_message", payload: { text } });
        await target.onEvent?.({ type: "turn_status", payload: { status: "completed" } });
      } catch (error) {
        await target.onEvent?.({ type: "turn_status", payload: { status: "failed", error: { message: error instanceof Error ? error.message : String(error) } } });
      }
      return { nativeTurnId: `native-${iteration}` };
    },
    respondToPermission: async () => undefined,
    cancelTurn: async () => ({ confirmed: true }), closeSession: async (_session: LiveSession) => undefined,
    materializePlugins: async ({ plugins }) => ({ applied: plugins }),
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 1)); }
  throw new Error("condition timed out");
}
