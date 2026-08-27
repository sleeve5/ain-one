import type { AgentConnector, AgentProductId, GraphNode, GraphRun, LiveSession, NormalizedError, TurnStatus } from "../shared/contracts.js";
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

  async run(graphId: string, input: string): Promise<GraphRun> {
    const graph = this.options.repository.getGraph(graphId);
    if (!graph) throw new Error("Graph not found");
    const errors = validateGraphDefinition(graph.definition);
    if (errors.length) throw new Error(errors.join("; "));
    if (this.options.repository.getLatestRun(graphId)?.status === "running") throw new Error("Graph is already running");

    const run = this.options.repository.createRun(graphId, input);
    let resolveDone!: () => void;
    const state: ActiveRun = { cancelled: false, active: null, sessions: new Map(), done: new Promise<void>((resolve) => { resolveDone = resolve; }), resolveDone: () => resolveDone() };
    this.active.set(run.id, state);
    this.options.repository.appendRunEvent(run.id, "run_started", null, { input });
    const counters = new Map<string, number>();
    const iterations = new Map<string, number>();
    const nodes = new Map(graph.definition.nodes.map((node) => [node.id, node]));
    let nodeId = graph.definition.start[0]!;
    let value = input;
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
    const starting = connector.startTurn(sessionState.session, {
      content: node.config.prompt.replaceAll("{{input}}", input),
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

  private cancelled(runId: string): GraphRun {
    const current = this.options.repository.getRun(runId)!;
    if (current.status === "running") {
      this.options.repository.finishRun(runId, "cancelled", null);
      this.options.repository.appendRunEvent(runId, "run_cancelled", null, {});
    }
    return this.options.repository.getRun(runId)!;
  }
}

function normalizeError(error: unknown): NormalizedError { return { code: "graph_run_failed", message: error instanceof Error ? error.message : String(error) }; }
function readErrorMessage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") return value.message;
  return null;
}
