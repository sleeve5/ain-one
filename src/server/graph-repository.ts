import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { GraphDefinition, GraphNodePosition, GraphNodeRun, GraphNodeRunStatus, GraphProject, GraphRun, GraphRunEvent, GraphRunStatus, GraphValues, GraphViewport, NormalizedError } from "../shared/contracts.js";

export interface CreateGraphInput {
  projectId: string;
  name: string;
  description: string;
  definition: GraphDefinition;
  viewport: GraphViewport;
  positions: Record<string, GraphNodePosition>;
}

export interface GraphRepository {
  createGraph(input: CreateGraphInput): GraphProject;
  listGraphs(projectId: string, archived?: boolean): GraphProject[];
  getGraph(graphId: string): GraphProject | null;
  updateGraph(graphId: string, patch: Partial<Omit<CreateGraphInput, "projectId">>): GraphProject | null;
  archiveGraph(graphId: string, archived: boolean): "updated" | "not_found" | "run_active";
  forkGraph(graphId: string): GraphProject | null;
  deleteGraph(graphId: string): boolean;
  createRun(graphId: string, input: string | GraphValues, snapshot?: GraphProject): GraphRun;
  getRun(runId: string): GraphRun | null;
  getLatestRun(graphId: string): GraphRun | null;
  listRuns(graphId: string): GraphRun[];
  finishRun(runId: string, status: Exclude<GraphRunStatus, "running">, output?: string | GraphValues | null, error?: NormalizedError): void;
  startNodeRun(runId: string, nodeId: string, iteration: number, input: string | GraphValues): GraphNodeRun;
  finishNodeRun(nodeRunId: string, status: Exclude<GraphNodeRunStatus, "running">, output?: string | GraphValues | null, error?: NormalizedError): void;
  listNodeRuns(runId: string): GraphNodeRun[];
  appendRunEvent(runId: string, type: string, nodeId: string | null, payload: Record<string, unknown>): GraphRunEvent;
  eventsAfter(runId: string, sequence: number, limit?: number): GraphRunEvent[];
  interruptActiveRuns(): number;
}

export function createGraphRepository(db: DatabaseSync): GraphRepository {
  const one = <T>(sql: string, ...params: SQLInputValue[]): T | undefined => db.prepare(sql).get(...params) as T | undefined;
  const many = <T>(sql: string, ...params: SQLInputValue[]): T[] => db.prepare(sql).all(...params) as T[];
  return {
    createGraph(input) {
      const now = new Date().toISOString();
      const graph: GraphProject = { id: randomUUID(), ...input, archivedAt: null, createdAt: now, updatedAt: now };
      db.prepare("INSERT INTO graphs (id, project_id, name, description, definition_json, viewport_json, positions_json, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)").run(graph.id, graph.projectId, graph.name, graph.description, JSON.stringify(graph.definition), JSON.stringify(graph.viewport), JSON.stringify(graph.positions), now, now);
      return graph;
    },
    listGraphs(projectId, archived = false) {
      return many<GraphRow>(`SELECT * FROM graphs WHERE project_id = ? AND archived_at IS ${archived ? "NOT " : ""}NULL ORDER BY updated_at DESC, rowid DESC`, projectId).map(mapGraph);
    },
    getGraph(graphId) {
      const row = one<GraphRow>("SELECT * FROM graphs WHERE id = ?", graphId);
      return row ? mapGraph(row) : null;
    },
    updateGraph(graphId, patch) {
      const current = this.getGraph(graphId);
      if (!current) return null;
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      db.prepare("UPDATE graphs SET name = ?, description = ?, definition_json = ?, viewport_json = ?, positions_json = ?, updated_at = ? WHERE id = ?")
        .run(next.name, next.description, JSON.stringify(next.definition), JSON.stringify(next.viewport), JSON.stringify(next.positions), next.updatedAt, graphId);
      return next;
    },
    archiveGraph(graphId, archived) {
      if (!this.getGraph(graphId)) return "not_found";
      if (archived && this.getLatestRun(graphId)?.status === "running") return "run_active";
      db.prepare("UPDATE graphs SET archived_at = ?, updated_at = ? WHERE id = ?").run(archived ? new Date().toISOString() : null, new Date().toISOString(), graphId);
      return "updated";
    },
    forkGraph(graphId) {
      const source = this.getGraph(graphId);
      if (!source) return null;
      return this.createGraph({ projectId: source.projectId, name: `${source.name} (branch)`, description: source.description, definition: structuredClone(source.definition), viewport: { ...source.viewport }, positions: structuredClone(source.positions) });
    },
    deleteGraph(graphId) {
      return (db.prepare("DELETE FROM graphs WHERE id = ?").run(graphId) as { changes: number }).changes > 0;
    },
    createRun(graphId, input, snapshot) {
      const now = new Date().toISOString();
      const inputValues = typeof input === "string" ? undefined : input;
      const inputText = typeof input === "string" ? input : Object.values(input).filter(Boolean).join("\n");
      const graphSnapshot = snapshot ? { name: snapshot.name, definition: structuredClone(snapshot.definition), viewport: { ...snapshot.viewport }, positions: structuredClone(snapshot.positions) } : null;
      const run: GraphRun = { id: randomUUID(), graphId, status: "running", input: inputText, ...(inputValues ? { inputValues } : {}), output: null, outputValues: null, graphSnapshot, error: null, createdAt: now, updatedAt: now };
      db.prepare("INSERT INTO graph_runs (id, graph_id, status, input, output, error_json, input_values_json, output_values_json, graph_snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?)").run(run.id, graphId, run.status, inputText, inputValues ? JSON.stringify(inputValues) : null, graphSnapshot ? JSON.stringify(graphSnapshot) : null, now, now);
      return run;
    },
    getRun(runId) {
      const row = one<RunRow>("SELECT * FROM graph_runs WHERE id = ?", runId);
      return row ? mapRun(row) : null;
    },
    getLatestRun(graphId) {
      const row = one<RunRow>("SELECT * FROM graph_runs WHERE graph_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", graphId);
      return row ? mapRun(row) : null;
    },
    listRuns(graphId) {
      return many<RunRow>("SELECT * FROM graph_runs WHERE graph_id = ? ORDER BY created_at DESC, rowid DESC", graphId).map(mapRun);
    },
    finishRun(runId, status, output = null, error) {
      const outputValues = output && typeof output === "object" ? output : null;
      const outputText = typeof output === "string" ? output : outputValues ? Object.values(outputValues).filter(Boolean).join("\n") : null;
      db.prepare("UPDATE graph_runs SET status = ?, output = ?, output_values_json = ?, error_json = ?, updated_at = ? WHERE id = ?")
        .run(status, outputText, outputValues ? JSON.stringify(outputValues) : null, error ? JSON.stringify(error) : null, new Date().toISOString(), runId);
    },
    startNodeRun(runId, nodeId, iteration, input) {
      const now = new Date().toISOString();
      const inputValues = typeof input === "string" ? undefined : input;
      const inputText = typeof input === "string" ? input : Object.values(input).filter(Boolean).join("\n");
      const result: GraphNodeRun = { id: randomUUID(), runId, nodeId, iteration, status: "running", input: inputText, ...(inputValues ? { inputValues } : {}), output: null, outputValues: null, error: null, createdAt: now, updatedAt: now };
      db.prepare("INSERT INTO graph_node_runs (id, run_id, node_id, iteration, status, input, output, error_json, input_values_json, output_values_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, NULL, NULL, ?, NULL, ?, ?)").run(result.id, runId, nodeId, iteration, inputText, inputValues ? JSON.stringify(inputValues) : null, now, now);
      return result;
    },
    finishNodeRun(nodeRunId, status, output = null, error) {
      const outputValues = output && typeof output === "object" ? output : null;
      const outputText = typeof output === "string" ? output : outputValues ? Object.values(outputValues).filter(Boolean).join("\n") : null;
      db.prepare("UPDATE graph_node_runs SET status = ?, output = ?, output_values_json = ?, error_json = ?, updated_at = ? WHERE id = ?")
        .run(status, outputText, outputValues ? JSON.stringify(outputValues) : null, error ? JSON.stringify(error) : null, new Date().toISOString(), nodeRunId);
    },
    listNodeRuns(runId) {
      return many<NodeRunRow>("SELECT * FROM graph_node_runs WHERE run_id = ? ORDER BY created_at, rowid", runId).map(mapNodeRun);
    },
    appendRunEvent(runId, type, nodeId, payload) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const sequence = (one<{ sequence: number }>("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM graph_run_events WHERE run_id = ?", runId)?.sequence ?? 1);
        const event: GraphRunEvent = { id: randomUUID(), runId, sequence, type, nodeId, payload, createdAt: new Date().toISOString() };
        db.prepare("INSERT INTO graph_run_events VALUES (?, ?, ?, ?, ?, ?, ?)").run(event.id, runId, sequence, type, nodeId, JSON.stringify(payload), event.createdAt);
        db.exec("COMMIT");
        return event;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    eventsAfter(runId, sequence, limit = 100) {
      return many<EventRow>("SELECT * FROM graph_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?", runId, sequence, limit).map(mapEvent);
    },
    interruptActiveRuns() {
      return (db.prepare("UPDATE graph_runs SET status = 'interrupted', updated_at = ? WHERE status = 'running'").run(new Date().toISOString()) as { changes: number }).changes;
    },
  };
}

interface GraphRow { id: string; project_id: string; name: string; description: string; definition_json: string; viewport_json: string; positions_json: string; archived_at: string | null; created_at: string; updated_at: string; }
interface RunRow { id: string; graph_id: string; status: GraphRunStatus; input: string; output: string | null; error_json: string | null; input_values_json: string | null; output_values_json: string | null; graph_snapshot_json: string | null; created_at: string; updated_at: string; }
interface NodeRunRow { id: string; run_id: string; node_id: string; iteration: number; status: GraphNodeRunStatus; input: string; output: string | null; error_json: string | null; input_values_json: string | null; output_values_json: string | null; created_at: string; updated_at: string; }
interface EventRow { id: string; run_id: string; sequence: number; type: string; node_id: string | null; payload_json: string; created_at: string; }
function mapGraph(row: GraphRow): GraphProject { return { id: row.id, projectId: row.project_id, name: row.name, description: row.description, definition: JSON.parse(row.definition_json) as GraphDefinition, viewport: JSON.parse(row.viewport_json) as GraphViewport, positions: JSON.parse(row.positions_json) as Record<string, GraphNodePosition>, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapRun(row: RunRow): GraphRun { return { id: row.id, graphId: row.graph_id, status: row.status, input: row.input, ...(row.input_values_json ? { inputValues: JSON.parse(row.input_values_json) as GraphValues } : {}), output: row.output, outputValues: row.output_values_json ? JSON.parse(row.output_values_json) as GraphValues : null, graphSnapshot: row.graph_snapshot_json ? JSON.parse(row.graph_snapshot_json) as GraphRun["graphSnapshot"] : null, error: row.error_json ? JSON.parse(row.error_json) as NormalizedError : null, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapNodeRun(row: NodeRunRow): GraphNodeRun { return { id: row.id, runId: row.run_id, nodeId: row.node_id, iteration: row.iteration, status: row.status, input: row.input, ...(row.input_values_json ? { inputValues: JSON.parse(row.input_values_json) as GraphValues } : {}), output: row.output, outputValues: row.output_values_json ? JSON.parse(row.output_values_json) as GraphValues : null, error: row.error_json ? JSON.parse(row.error_json) as NormalizedError : null, createdAt: row.created_at, updatedAt: row.updated_at }; }
function mapEvent(row: EventRow): GraphRunEvent { return { id: row.id, runId: row.run_id, sequence: row.sequence, type: row.type, nodeId: row.node_id, payload: JSON.parse(row.payload_json) as Record<string, unknown>, createdAt: row.created_at }; }
