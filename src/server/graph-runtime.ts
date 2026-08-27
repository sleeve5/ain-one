import type { AgentConnector, AgentProductId, GraphNode, GraphProject, GraphRun, GraphValues, LiveSession, NormalizedError, TurnStatus } from "../shared/contracts.js";
import { validateGraphDefinition } from "../shared/validation.js";
import type { GraphRepository } from "./graph-repository.js";

interface GraphRuntimeOptions {
  repository: GraphRepository;
  connectors: Partial<Record<AgentProductId, AgentConnector>>;
  projectPath(graphId: string): string;
  stepLimit?: number;
}

interface ActiveRun {
  cancelled: boolean;
  done: Promise<void>;
  resolveDone(): void;
  active: { connector: AgentConnector; session: LiveSession; nativeTurnId: string | null; cancel(): void } | null;
  sessions: Map<string, { connector: AgentConnector; session: LiveSession; eventHandler: { current(event: { type: string; payload: Record<string, unknown> }): Promise<void> } }>;
}

export class GraphRuntime {
  private readonly active = new Map<string, ActiveRun>();
  constructor(private readonly options: GraphRuntimeOptions) {}

  async run(graphId: string, input: string | GraphValues): Promise<GraphRun> {
    const graph = this.options.repository.getGraph(graphId);
    if (!graph) throw new Error("Graph not found");
    const errors = validateGraphDefinition(graph.definition);
    if (errors.length) throw new Error(errors.join("; "));
    if (this.options.repository.getLatestRun(graphId)?.status === "running") throw new Error("Graph is already running");
    const inputNode = graph.definition.nodes.find((node) => node.type === "input");
    if (inputNode?.type === "input") {
      const values = typeof input === "string" ? { input } : input;
      const missing = inputNode.config.fields.find((field) => field.required !== false && !values[field.id]?.trim());
      if (missing) throw new Error(`${missing.name} is required`);
    }

    const run = this.options.repository.createRun(graphId, input, graph);
    let resolveDone!: () => void;
    const state: ActiveRun = { cancelled: false, active: null, sessions: new Map(), done: new Promise<void>((resolve) => { resolveDone = resolve; }), resolveDone: () => resolveDone() };
    this.active.set(run.id, state);
    this.options.repository.appendRunEvent(run.id, "run_started", null, { input });
    if (graph.definition.nodes.some((node) => node.type === "input")) return this.runDataflow(graph, run, typeof input === "string" ? { input } : input, state);
    const counters = new Map<string, number>();
    const iterations = new Map<string, number>();
    const nodes = new Map(graph.definition.nodes.map((node) => [node.id, node]));
    let nodeId = graph.definition.start[0]!;
    let value = input as string;
    try {
      for (let step = 0; step < (this.options.stepLimit ?? 1_000); step += 1) {
        if (state.cancelled) return this.cancelled(run.id);
        const node = nodes.get(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);
        const iteration = (iterations.get(nodeId) ?? 0) + 1;
        iterations.set(nodeId, iteration);
        const nodeRun = this.options.repository.startNodeRun(run.id, nodeId, iteration, value);
        this.options.repository.appendRunEvent(run.id, "node_started", nodeId, { iteration, input: value });
        try {
          if (node.type === "agent") value = await this.executeAgent(run.id, node, iteration, value, state);
          if (node.type === "literal") value = node.config.value;
          if (node.type === "template") value = node.config.template.replaceAll("{{input}}", value);
          if (state.cancelled) {
            this.options.repository.finishNodeRun(nodeRun.id, "cancelled", value);
            return this.cancelled(run.id);
          }
          this.options.repository.finishNodeRun(nodeRun.id, "completed", value);
          this.options.repository.appendRunEvent(run.id, "node_completed", nodeId, { iteration, output: value });
        } catch (error) {
          const normalized = normalizeError(error);
          this.options.repository.finishNodeRun(nodeRun.id, "failed", null, normalized);
          throw error;
        }

        if (graph.definition.end.includes(nodeId)) {
          this.options.repository.finishRun(run.id, "completed", value);
          this.options.repository.appendRunEvent(run.id, "run_completed", nodeId, { output: value });
          return this.options.repository.getRun(run.id)!;
        }
        const branch = node.type === "loop_counter"
          ? this.loopBranch(node, counters)
          : null;
        const edge = graph.definition.edges.find((candidate) =>
          candidate.source === nodeId && (branch === null || candidate.condition?.branch === branch));
        if (!edge) throw new Error(`No ${branch ?? "next"} edge from node ${nodeId}`);
        nodeId = edge.target;
      }
      throw new Error("Graph step limit exceeded");
    } catch (error) {
      if (state.cancelled) return this.cancelled(run.id);
      const normalized = normalizeError(error);
      this.options.repository.finishRun(run.id, "failed", null, normalized);
      this.options.repository.appendRunEvent(run.id, "run_failed", nodeId, { error: normalized });
      return this.options.repository.getRun(run.id)!;
    } finally {
      this.active.delete(run.id);
      await Promise.all([...state.sessions.values()].map(({ connector, session }) => connector.closeSession(session).catch(() => undefined)));
      state.resolveDone();
    }
  }

  private async runDataflow(graph: GraphProject, run: GraphRun, input: GraphValues, state: ActiveRun): Promise<GraphRun> {
    const nodes = new Map(graph.definition.nodes.map((node) => [node.id, node]));
    const values = new Map<string, GraphValues>();
    const iterations = new Map<string, number>();
    const counters = new Map<string, number>();
    const pending = [graph.definition.start[0]!];
    const queued = new Set(pending);
    try {
      for (let step = 0; pending.length && step < (this.options.stepLimit ?? 1_000); step += 1) {
        if (state.cancelled) return this.cancelled(run.id);
        const nodeId = pending.shift()!; queued.delete(nodeId);
        const node = nodes.get(nodeId);
        if (!node) throw new Error(`Node not found: ${nodeId}`);
        const nodeInput = values.get(nodeId) ?? {};
        if (!isReady(node, nodeInput, graph.definition.edges, iterations.get(nodeId) ?? 0)) continue;
        const iteration = (iterations.get(nodeId) ?? 0) + 1; iterations.set(nodeId, iteration);
        const recordedInput = node.type === "input" ? input : nodeInput;
        const nodeRun = this.options.repository.startNodeRun(run.id, nodeId, iteration, recordedInput);
        this.options.repository.appendRunEvent(run.id, "node_started", nodeId, { iteration, input: recordedInput });
        let output: GraphValues;
        try {
          if (node.type === "input") output = Object.fromEntries(node.config.fields.map((field) => [field.id, input[field.id] ?? ""]));
          else if (node.type === "agent") {
            output = await this.executeDataflowAgent(run.id, node, iteration, nodeInput, state);
            const retained = { ...nodeInput };
            for (const port of node.config.inputs ?? []) if (port.kind === "feedback") delete retained[port.id];
            values.set(node.id, retained);
          }
          else if (node.type === "loop_counter") { const branch = this.loopBranch(node, counters); output = { [branch]: nodeInput.input ?? Object.values(nodeInput)[0] ?? "" }; }
          else if (node.type === "output") output = Object.fromEntries(node.config.fields.map((field) => [field.id, nodeInput[field.id] ?? ""]));
          else throw new Error(`Unsupported dataflow node: ${node.type}`);
          if (state.cancelled) { this.options.repository.finishNodeRun(nodeRun.id, "cancelled", output); return this.cancelled(run.id); }
          this.options.repository.finishNodeRun(nodeRun.id, "completed", output);
          this.options.repository.appendRunEvent(run.id, "node_completed", nodeId, { iteration, output });
        } catch (error) {
          const normalized = normalizeError(error);
          this.options.repository.finishNodeRun(nodeRun.id, "failed", null, normalized);
          throw error;
        }
        if (node.type === "output") {
          this.options.repository.finishRun(run.id, "completed", output);
          this.options.repository.appendRunEvent(run.id, "run_completed", nodeId, { output });
          return this.options.repository.getRun(run.id)!;
        }
        for (const edge of graph.definition.edges.filter((candidate) => candidate.source === nodeId)) {
          const sourcePort = edge.sourcePort ?? (node.type === "loop_counter" ? edge.condition?.branch : "output");
          const targetPort = edge.targetPort ?? "input";
          if (!sourcePort || output[sourcePort] === undefined) continue;
          values.set(edge.target, { ...(values.get(edge.target) ?? {}), [targetPort]: output[sourcePort] });
          if (!queued.has(edge.target)) { pending.push(edge.target); queued.add(edge.target); }
        }
      }
      throw new Error(pending.length ? "Graph step limit exceeded" : "Graph execution ended before Output");
    } catch (error) {
      if (state.cancelled) return this.cancelled(run.id);
      const normalized = normalizeError(error);
      this.options.repository.finishRun(run.id, "failed", null, normalized);
      this.options.repository.appendRunEvent(run.id, "run_failed", null, { error: normalized });
      return this.options.repository.getRun(run.id)!;
    } finally {
      this.active.delete(run.id);
      await Promise.all([...state.sessions.values()].map(({ connector, session }) => connector.closeSession(session).catch(() => undefined)));
      state.resolveDone();
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const state = this.active.get(runId);
    if (!state) return false;
    state.cancelled = true;
    const active = state.active;
    if (active) {
      active.cancel();
      await active.connector.cancelTurn(active.session, active.nativeTurnId);
    }
    await state.done;
    return true;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.active.keys()].map((runId) => this.cancel(runId)));
  }

  private loopBranch(node: Extract<GraphNode, { type: "loop_counter" }>, counters: Map<string, number>): "loop" | "done" {
    const count = (counters.get(node.id) ?? 0) + 1;
    counters.set(node.id, count);
    return count < node.config.maxIterations ? "loop" : "done";
  }

  private async executeAgent(runId: string, node: Extract<GraphNode, { type: "agent" }>, iteration: number, input: string, state: ActiveRun): Promise<string> {
    const connector = this.options.connectors[node.config.agentProductId];
    if (!connector) throw new Error(`Agent is unavailable: ${node.config.agentProductId}`);
    let sessionState = state.sessions.get(node.id);
    let terminalResolve!: (status: TurnStatus) => void;
    let terminalReject!: (error: Error) => void;
    let output = "";
    const terminal = new Promise<TurnStatus>((resolve, reject) => { terminalResolve = resolve; terminalReject = reject; });
    const onEvent = async (event: { type: string; payload: Record<string, unknown> }) => {
      this.options.repository.appendRunEvent(runId, `agent_${event.type}`, node.id, event.payload);
      if (event.type === "assistant_message" && typeof event.payload.text === "string") {
        output = event.payload.delta === true ? output + event.payload.text : event.payload.text;
      }
      if (event.type === "turn_status" && typeof event.payload.status === "string") {
        const status = event.payload.status as TurnStatus;
        if (["completed", "cancelled", "start_failed", "failed", "interrupted", "cancel_failed"].includes(status)) {
          const message = readErrorMessage(event.payload.error);
          if (status === "completed") terminalResolve(status);
          else if (status === "cancelled") terminalResolve(status);
          else terminalReject(new Error(message ?? `Agent Turn ${status}`));
        }
      }
    };
    if (!sessionState) {
      const eventHandler = { current: onEvent };
      const graphId = this.options.repository.getRun(runId)!.graphId;
      const session = await connector.createOrResumeSession({ projectPath: this.options.projectPath(graphId), conversationId: `graph:${runId}:${node.id}`, nativeSessionId: null, onEvent: (event) => eventHandler.current(event) });
      sessionState = { connector, session, eventHandler };
      state.sessions.set(node.id, sessionState);
    } else {
      sessionState.eventHandler.current = onEvent;
    }
    state.active = { ...sessionState, nativeTurnId: null, cancel: () => terminalResolve("cancelled") };
    const template = node.config.prompt ?? node.config.instruction ?? "";
    const starting = connector.startTurn(sessionState.session, {
      content: template.includes("{{input}}") ? template.replaceAll("{{input}}", input) : input,
      snapshot: { modelId: node.config.modelId, permissionMode: node.config.permissionMode, pluginVersions: [] },
      turnId: `graph:${runId}:${node.id}:${iteration}`,
    });
    const started = await Promise.race([
      starting.then((native) => ({ native })),
      terminal.then((status) => ({ status })),
    ]);
    if ("native" in started) state.active.nativeTurnId = started.native.nativeTurnId;
    const status = "status" in started ? started.status : await terminal;
    state.active = null;
    if (status === "cancelled") state.cancelled = true;
    return output;
  }

  private async executeDataflowAgent(runId: string, node: Extract<GraphNode, { type: "agent" }>, iteration: number, input: GraphValues, state: ActiveRun): Promise<GraphValues> {
    const labels = new Map((node.config.inputs ?? [{ id: "input", name: "Input" }]).map((port) => [port.id, port.name]));
    const parameters = Object.entries(input).map(([id, value]) => `${labels.get(id) ?? id}:\n${value}`).join("\n\n");
    const outputs = node.config.outputs ?? [{ id: "output", name: "Output" }];
    const format = outputs.length > 1 ? `\n\nReturn a JSON object with these keys only: ${outputs.map((port) => port.id).join(", ")}.` : "";
    const text = await this.executeAgent(runId, node, iteration, `${node.config.instruction ?? node.config.prompt ?? ""}\n\nInput parameters:\n${parameters}${format}`, state);
    if (outputs.length === 1) return { [outputs[0]!.id]: text };
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const result: GraphValues = {};
    for (const port of outputs) { const value = parsed[port.id]; if (typeof value !== "string") throw new Error(`Agent output is missing string field: ${port.id}`); result[port.id] = value; }
    return result;
  }

  private cancelled(runId: string): GraphRun {
    const current = this.options.repository.getRun(runId)!;
    if (current.status === "running") {
      this.options.repository.finishRun(runId, "cancelled", null);
      this.options.repository.appendRunEvent(runId, "run_cancelled", null, {});
    }
    return this.options.repository.getRun(runId)!;
  }
}

function isReady(node: GraphNode, values: GraphValues, edges: GraphProject["definition"]["edges"], iteration: number): boolean {
  if (node.type === "input") return iteration === 0;
  if (node.type === "agent") {
    const ports = node.config.inputs ?? [{ id: "input", name: "Input", required: true }];
    const regular = ports.filter((port) => port.kind !== "feedback" && edges.some((edge) => edge.target === node.id && (edge.targetPort ?? "input") === port.id));
    if (regular.some((port) => values[port.id] === undefined)) return false;
    return iteration === 0 || ports.some((port) => port.kind === "feedback" && values[port.id] !== undefined);
  }
  if (node.type === "loop_counter") return Object.keys(values).length > 0;
  if (node.type === "output") return node.config.fields.every((field) => field.required === false || values[field.id] !== undefined);
  return false;
}

function normalizeError(error: unknown): NormalizedError { return { code: "graph_run_failed", message: error instanceof Error ? error.message : String(error) }; }
function readErrorMessage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") return value.message;
  return null;
}
