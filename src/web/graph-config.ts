import type { GraphDefinition, GraphNodePosition, GraphProject, GraphViewport } from "../shared/contracts.js";
import { validateGraphDraft } from "../shared/validation.js";

export interface PortableGraphConfig {
  formatVersion: 1;
  name: string;
  description: string;
  definition: GraphDefinition;
  positions?: Record<string, GraphNodePosition>;
  viewport?: GraphViewport;
}

export function serializeGraphConfig(graph: GraphProject): string {
  const config: PortableGraphConfig = { formatVersion: 1, name: graph.name, description: graph.description, definition: graph.definition, positions: graph.positions, viewport: graph.viewport };
  return JSON.stringify(config, null, 2);
}

export function parseGraphConfig(text: string, current: GraphProject): GraphProject {
  let value: unknown;
  try { value = JSON.parse(text); } catch (cause) { throw new Error("Invalid JSON: " + (cause instanceof Error ? cause.message : String(cause))); }
  if (!isRecord(value)) throw new Error("Graph configuration must be an object");
  if (value.formatVersion !== 1) throw new Error("Unsupported Graph configuration version");
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("Graph name must be a non-empty string");
  if (typeof value.description !== "string") throw new Error("Graph description must be a string");
  const errors = validateGraphDraft(value.definition);
  if (errors.length) throw new Error(errors.join(" · "));
  const definition = structuredClone(value.definition) as GraphDefinition;
  for (const edge of definition.edges) if (edge.route && (!finite(edge.route.x) || !finite(edge.route.y) || (edge.route.targetX !== undefined && !finite(edge.route.targetX)))) throw new Error("Connection route requires finite x, y, and optional targetX");
  const automatic = layoutPositions(definition);
  const positions = value.positions === undefined ? automatic : { ...automatic, ...readPositions(value.positions, definition) };
  const viewport = value.viewport === undefined ? { x: 0, y: 0, zoom: 1 } : readViewport(value.viewport);
  return { ...current, name: value.name.trim(), description: value.description, definition, positions, viewport };
}

export function autoLayoutGraph(graph: GraphProject): GraphProject {
  return { ...graph, definition: { ...graph.definition, edges: graph.definition.edges.map(({ route: _route, ...edge }) => edge) }, positions: layoutPositions(graph.definition), viewport: { x: 0, y: 0, zoom: 1 } };
}

function layoutPositions(definition: GraphDefinition): Record<string, GraphNodePosition> {
  const order = new Map(definition.nodes.map((node, index) => [node.id, index]));
  const ranks = new Map(definition.nodes.map((node) => [node.id, 0]));
  const incoming = new Map(definition.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of definition.edges) {
    if (edge.condition?.branch === "loop" || !incoming.has(edge.target) || !outgoing.has(edge.source)) continue;
    outgoing.get(edge.source)!.push(edge.target);
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
  }
  const queue = definition.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const source = queue[cursor]!;
    for (const target of outgoing.get(source) ?? []) {
      ranks.set(target, Math.max(ranks.get(target)!, ranks.get(source)! + 1));
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  const unresolved = definition.nodes.filter((node) => (incoming.get(node.id) ?? 0) > 0).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  let fallbackRank = Math.max(0, ...ranks.values());
  for (const node of unresolved) ranks.set(node.id, ++fallbackRank);
  const columns = new Map<number, string[]>();
  for (const node of definition.nodes) { const rank = ranks.get(node.id)!; columns.set(rank, [...(columns.get(rank) ?? []), node.id]); }
  return Object.fromEntries([...columns].flatMap(([rank, ids]) => ids.map((id, row) => [id, { x: 80 + rank * 280, y: 100 + row * 150 }])));
}

function readPositions(value: unknown, definition: GraphDefinition): Record<string, GraphNodePosition> {
  if (!isRecord(value)) throw new Error("Graph positions must be an object");
  const ids = new Set(definition.nodes.map((node) => node.id));
  const positions: Record<string, GraphNodePosition> = {};
  for (const [id, position] of Object.entries(value)) {
    if (!ids.has(id)) continue;
    if (!isRecord(position) || !finite(position.x) || !finite(position.y)) throw new Error("Position for " + id + " requires finite x and y");
    positions[id] = { x: position.x as number, y: position.y as number };
  }
  return positions;
}

function readViewport(value: unknown): GraphViewport {
  if (!isRecord(value) || !finite(value.x) || !finite(value.y) || !finite(value.zoom) || (value.zoom as number) <= 0) throw new Error("Graph viewport requires finite x, y, and positive zoom");
  return { x: value.x as number, y: value.y as number, zoom: value.zoom as number };
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
