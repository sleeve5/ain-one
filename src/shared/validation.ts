import type {
  AgentSettingsInput,
  AgentProductId,
  ConversationSettingsInput,
  CreateConversationInput,
  CreateConversationRequest,
  PermissionDecision,
  PermissionMode,
  PluginEnablementsInput,
  PluginVersion,
  QueueMessageRequest,
  GraphDefinition,
} from "./contracts.js";

const SUPPORTED_AGENT_PRODUCTS: AgentProductId[] = [
  "codex",
  "claude",
  "trae",
  "opencode",
];

export class ValidationError extends Error {}

function assertObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(message);
  }
  return value as Record<string, unknown>;
}

function readString(
  value: Record<string, unknown>,
  key: string,
  errorMessage: string,
): string {
  if (typeof value[key] !== "string") {
    throw new ValidationError(errorMessage);
  }
  return value[key] as string;
}

function readNullableString(
  value: Record<string, unknown>,
  key: string,
  errorMessage: string,
): string | null {
  const raw = value[key];
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string") {
    throw new ValidationError(errorMessage);
  }
  return raw;
}

function parseAgentProductId(value: unknown): AgentProductId {
  if (typeof value !== "string" || !SUPPORTED_AGENT_PRODUCTS.includes(value as AgentProductId)) {
    throw new ValidationError("Unsupported Agent Product");
  }
  return value as AgentProductId;
}

function parsePermissionMode(value: unknown): PermissionMode {
  if (
    value !== "request_approval" &&
    value !== "help_me_approve" &&
    value !== "full_access"
  ) {
    throw new ValidationError("Unsupported permission mode");
  }
  return value;
}

function parsePluginVersions(value: unknown): PluginVersion[] {
  if (!Array.isArray(value)) {
    throw new ValidationError("pluginVersions must be an array");
  }

  const seen = new Set<string>();
  return value.map((item) => {
    const plugin = assertObject(item, "Invalid plugin version");
    const pluginId = readString(plugin, "pluginId", "pluginId must be a string").trim();
    const versionId = readString(plugin, "versionId", "versionId must be a string").trim();
    if (!pluginId || !versionId) {
      throw new ValidationError("pluginId and versionId cannot be empty");
    }
    if (seen.has(pluginId)) {
      throw new ValidationError("pluginId must be unique");
    }
    seen.add(pluginId);
    return { pluginId, versionId };
  });
}

export function parseCreateConversation(input: unknown): CreateConversationInput {
  const value = assertObject(input, "Invalid create conversation payload");
  const projectId = readString(value, "projectId", "projectId must be a string").trim();
  if (projectId.length === 0) {
    throw new ValidationError("projectId cannot be empty");
  }

  const parsed: CreateConversationInput = {
    projectId,
    agentProductId: parseAgentProductId(value.agentProductId),
    modelId: readNullableString(value, "modelId", "modelId must be a string or null"),
  };
  if (value.permissionMode !== undefined) {
    parsed.permissionMode = parsePermissionMode(value.permissionMode);
  }
  if (value.autoQueue !== undefined) {
    if (typeof value.autoQueue !== "boolean") throw new ValidationError("autoQueue must be a boolean");
    parsed.autoQueue = value.autoQueue;
  }
  return parsed;
}

export function parseConversationSettings(input: unknown): ConversationSettingsInput {
  const value = assertObject(input, "Invalid conversation settings payload");
  if (value.autoQueue !== undefined && typeof value.autoQueue !== "boolean") {
    throw new ValidationError("autoQueue must be a boolean");
  }

  return {
    modelId: readNullableString(value, "modelId", "modelId must be a string or null"),
    permissionMode: parsePermissionMode(value.permissionMode),
    ...(typeof value.autoQueue === "boolean" ? { autoQueue: value.autoQueue } : {}),
  };
}

export function parseAgentSettings(input: unknown): AgentSettingsInput {
  const value = assertObject(input, "Invalid Agent settings payload");
  const executablePath = value.executablePath === undefined ? undefined : readNullableString(value, "executablePath", "executablePath must be a string or null");
  if (typeof executablePath === "string" && executablePath.trim().length === 0) {
    throw new ValidationError("executablePath cannot be empty");
  }
  const enabled = value.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new ValidationError("enabled must be a boolean");
  }
  if (executablePath === undefined && enabled === undefined) {
    throw new ValidationError("Agent settings cannot be empty");
  }
  return {
    ...(executablePath !== undefined ? { executablePath: executablePath?.trim() ?? null } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
}

export function parsePluginEnablements(input: unknown): PluginEnablementsInput {
  const value = assertObject(input, "Invalid plugin enablements payload");
  return { pluginVersions: parsePluginVersions(value.pluginVersions) };
}

export function parseQueueMessage(input: unknown): QueueMessageRequest {
  const value = assertObject(input, "Invalid queue message payload");
  const content = readString(value, "content", "content must be a string").trim();
  if (content.length === 0) {
    throw new ValidationError("Message cannot be empty");
  }

  return { content };
}

export function parseUncertainMessageResolution(input: unknown): "retry" | "accept" {
  const value = assertObject(input, "Invalid uncertain message resolution");
  if (value.action !== "retry" && value.action !== "accept") {
    throw new ValidationError("action must be retry or accept");
  }
  return value.action;
}

export interface CreateProjectRequest {
  path: string;
  name: string | null;
}

export interface ProjectManagementPatch {
  name?: string;
  archived?: boolean;
}

export interface ConversationManagementPatch {
  title?: string;
  archived?: boolean;
}

function parseManagementPatch(
  input: unknown,
  textField: "name" | "title",
): ProjectManagementPatch | ConversationManagementPatch {
  const value = assertObject(input, "Invalid workspace management payload");
  const patch: Record<string, string | boolean> = {};
  if (textField in value) {
    const text = readString(value, textField, `${textField} must be a string`).trim();
    if (!text) throw new ValidationError(`${textField} cannot be empty`);
    patch[textField] = text;
  }
  if ("archived" in value) {
    if (typeof value.archived !== "boolean") {
      throw new ValidationError("archived must be a boolean");
    }
    patch.archived = value.archived;
  }
  if (!(textField in patch) && !("archived" in patch)) {
    throw new ValidationError("Workspace management patch is empty");
  }
  return patch;
}

export function parseProjectManagementPatch(input: unknown): ProjectManagementPatch {
  return parseManagementPatch(input, "name");
}

export function parseConversationManagementPatch(input: unknown): ConversationManagementPatch {
  return parseManagementPatch(input, "title");
}

export function parseCreateProject(input: unknown): CreateProjectRequest {
  const value = assertObject(input, "Invalid create project payload");
  const path = readString(value, "path", "path must be a string").trim();
  if (path.length === 0) {
    throw new ValidationError("path cannot be empty");
  }

  const name = readNullableString(value, "name", "name must be a string or null")?.trim() ?? null;
  if (name !== null && name.length === 0) {
    throw new ValidationError("name cannot be empty");
  }

  return {
    path,
    name,
  };
}

export function parsePermissionDecision(input: unknown): PermissionDecision {
  const value = assertObject(input, "Invalid permission response payload");
  const decision = readString(value, "decision", "decision must be a string");
  if (decision !== "allow_once" && decision !== "deny_once") {
    throw new ValidationError("Unsupported decision");
  }
  return decision;
}

export function validateGraphDraft(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["Graph definition must be an object"];
  const graph = value as { nodes?: unknown; edges?: unknown; start?: unknown; end?: unknown };
  if (!Array.isArray(graph.nodes)) errors.push("Graph nodes must be an array");
  if (!Array.isArray(graph.edges)) errors.push("Graph edges must be an array");
  if (!Array.isArray(graph.start)) errors.push("Graph start must be an array");
  if (!Array.isArray(graph.end)) errors.push("Graph end must be an array");
  if (errors.length) return errors;
  const ids = new Set<string>();
  const nodes = graph.nodes as unknown[];
  const edges = graph.edges as unknown[];
  const start = graph.start as unknown[];
  const end = graph.end as unknown[];
  for (const rawNode of nodes) {
    if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) { errors.push("Every node must be an object"); continue; }
    const node = rawNode as Record<string, unknown>;
    if (typeof node.id !== "string" || !node.id || typeof node.name !== "string") { errors.push("Every node requires a string id and name"); continue; }
    if (ids.has(node.id)) errors.push(`Node IDs must be unique: ${node.id}`);
    ids.add(node.id);
    if (node.type !== "input" && node.type !== "agent" && node.type !== "output" && node.type !== "loop_counter" && node.type !== "literal" && node.type !== "template" && node.type !== "passthrough") errors.push(`Unsupported node type: ${String(node.type)}`);
    if (!node.config || typeof node.config !== "object" || Array.isArray(node.config)) { errors.push(`Node ${node.id} config must be an object`); continue; }
    const config = node.config as Record<string, unknown>;
    if (node.type === "agent" && (!SUPPORTED_AGENT_PRODUCTS.includes(config.agentProductId as AgentProductId) || (config.modelId !== null && typeof config.modelId !== "string") || !["request_approval", "help_me_approve", "full_access"].includes(String(config.permissionMode)) || (typeof config.prompt !== "string" && typeof config.instruction !== "string") || !validPorts(config.inputs, false) || !validPorts(config.outputs, false))) errors.push(`Agent node ${node.id} has invalid config`);
    if (node.type === "input" && !validPorts(config.fields, true)) errors.push(`Input node ${node.id} has invalid fields`);
    if (node.type === "output" && !validPorts(config.fields, false)) errors.push(`Output node ${node.id} has invalid fields`);
    if (node.type === "loop_counter" && (!Number.isInteger(config.maxIterations) || (config.maxIterations as number) < 1)) {
      errors.push(`Loop Counter ${node.id} maxIterations must be >= 1`);
    }
    if (node.type === "literal" && typeof config.value !== "string") errors.push(`Literal node ${node.id} requires a string value`);
    if (node.type === "template" && typeof config.template !== "string") errors.push(`Template node ${node.id} requires a string template`);
  }
  for (const id of start) if (typeof id !== "string" || !ids.has(id)) errors.push(`Start references unknown node: ${String(id)}`);
  for (const id of end) if (typeof id !== "string" || !ids.has(id)) errors.push(`End references unknown node: ${String(id)}`);
  const edgeIds = new Set<string>();
  const parsedEdges: Array<{ id: string; source: string; sourcePort?: string; target: string; targetPort?: string; condition?: { branch?: unknown } }> = [];
  for (const rawEdge of edges) {
    if (!rawEdge || typeof rawEdge !== "object" || Array.isArray(rawEdge)) { errors.push("Every edge must be an object"); continue; }
    const edge = rawEdge as Record<string, unknown>;
    if (typeof edge.id !== "string" || !edge.id || typeof edge.source !== "string" || typeof edge.target !== "string") { errors.push("Every edge requires string id, source, and target"); continue; }
    const condition = edge.condition && typeof edge.condition === "object" && !Array.isArray(edge.condition) ? edge.condition as { branch?: unknown } : undefined;
    parsedEdges.push({ id: edge.id, source: edge.source, ...(typeof edge.sourcePort === "string" ? { sourcePort: edge.sourcePort } : {}), target: edge.target, ...(typeof edge.targetPort === "string" ? { targetPort: edge.targetPort } : {}), ...(condition ? { condition } : {}) });
    if (edgeIds.has(edge.id)) errors.push(`Edge IDs must be unique: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.source)) errors.push(`Edge ${edge.id} has unknown source: ${edge.source}`);
    if (!ids.has(edge.target)) errors.push(`Edge ${edge.id} has unknown target: ${edge.target}`);
    if (edge.condition !== undefined && (!condition || (condition.branch !== "loop" && condition.branch !== "done"))) errors.push(`Edge ${edge.id} has invalid branch`);
  }
  const nodeMap = new Map(nodes.filter((node): node is Record<string, unknown> => Boolean(node && typeof node === "object" && !Array.isArray(node) && typeof (node as Record<string, unknown>).id === "string")).map((node) => [String(node.id), node]));
  const incomingPorts = new Set<string>();
  for (const edge of parsedEdges) {
    if (nodeMap.get(edge.target)?.type === "input") errors.push("Input node cannot receive edges");
    if (nodeMap.get(edge.source)?.type === "output") errors.push("Output node cannot send edges");
    if (edge.sourcePort !== undefined || edge.targetPort !== undefined) {
      const sourcePorts = outputPortIds(nodeMap.get(edge.source));
      const targetPorts = inputPortIds(nodeMap.get(edge.target));
      if (!edge.sourcePort || !sourcePorts.has(edge.sourcePort)) errors.push(`Edge ${edge.id} has unknown source port: ${String(edge.sourcePort)}`);
      if (!edge.targetPort || !targetPorts.has(edge.targetPort)) errors.push(`Edge ${edge.id} has unknown target port: ${String(edge.targetPort)}`);
      const key = `${edge.target}:${edge.targetPort}`;
      if (incomingPorts.has(key)) errors.push(`Input port ${key} allows only one incoming edge`);
      incomingPorts.add(key);
    }
  }
  return errors;
}

export function validateGraphDefinition(value: unknown): string[] {
  const errors = validateGraphDraft(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return errors;
  const graph = value as { nodes?: unknown; edges?: unknown; start?: unknown; end?: unknown };
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.start) || !Array.isArray(graph.end)) return errors;
  const nodes = graph.nodes as Array<Record<string, unknown>>;
  const parsedEdges = graph.edges as Array<{ id: string; source: string; sourcePort?: string; target: string; targetPort?: string; condition?: { branch?: unknown } }>;
  const start = graph.start as unknown[];
  const end = graph.end as unknown[];
  const inputNodes = nodes.filter((node) => node?.type === "input");
  const outputNodes = nodes.filter((node) => node?.type === "output");
  const isDataflow = inputNodes.length > 0 || outputNodes.length > 0;
  if (start.length !== 1) errors.push("Graph requires exactly one start node");
  if (end.length !== 1) errors.push("Graph requires exactly one end node");
  if (isDataflow && inputNodes.length !== 1) errors.push("Dataflow Graph requires exactly one Input node");
  if (isDataflow && outputNodes.length !== 1) errors.push("Dataflow Graph requires exactly one Output node");
  if (isDataflow && start.length === 1 && start[0] !== inputNodes[0]?.id) errors.push("Graph start must be the Input node");
  if (isDataflow && end.length === 1 && end[0] !== outputNodes[0]?.id) errors.push("Graph end must be the Output node");
  if (errors.length) return errors;
  if (isDataflow) {
    for (const node of nodes) {
      if (node?.type !== "agent") continue;
      const config = node.config as { inputs?: Array<{ id: string; name: string; required?: boolean; kind?: "input" | "feedback" }> };
      for (const port of config.inputs ?? []) {
        const incoming = parsedEdges.filter((edge) => edge.target === node.id && edge.targetPort === port.id);
        if (port.kind === "feedback" && incoming.some((edge) => nodes.find((candidate) => candidate.id === edge.source)?.type !== "loop_counter" || edge.condition?.branch !== "loop")) {
          errors.push(`Agent feedback port ${String(node.id)}:${port.id} must receive a Loop branch`);
        }
        if (port.kind !== "feedback" && port.required !== false && incoming.length === 0) {
          errors.push(`Agent required input port ${String(node.id)}:${port.id} is not connected`);
        }
      }
    }
    for (const node of outputNodes) {
      const config = node.config as { fields?: Array<{ id: string; required?: boolean }> };
      for (const port of config.fields ?? []) {
        if (port.required !== false && !parsedEdges.some((edge) => edge.target === node.id && edge.targetPort === port.id)) {
          errors.push(`Output required input port ${String(node.id)}:${port.id} is not connected`);
        }
      }
    }
  }
  for (const rawNode of nodes) {
    if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) continue;
    const node = rawNode as Record<string, unknown>;
    if (typeof node.id !== "string") continue;
    const outgoing = parsedEdges.filter((edge) => edge.source === node.id);
    const branches = outgoing.map((edge) => edge.condition?.branch);
    if (node.type === "loop_counter") {
      const loopCount = branches.filter((branch) => branch === "loop").length;
      const doneCount = branches.filter((branch) => branch === "done").length;
      if (loopCount === 0) errors.push(`Loop Counter ${node.id} requires a Loop branch`);
      if (doneCount === 0) errors.push(`Loop Counter ${node.id} requires a Done branch`);
      if (loopCount > 1) errors.push(`Loop Counter ${node.id} allows only one Loop branch`);
      if (doneCount > 1) errors.push(`Loop Counter ${node.id} allows only one Done branch`);
      if (branches.some((branch) => branch === undefined)) errors.push(`Loop Counter ${node.id} outgoing edges require Loop or Done branches`);
    } else if (!outgoing.some((edge) => edge.sourcePort !== undefined)) {
      if (outgoing.length > 1) errors.push(`Serial node ${node.id} allows only one outgoing edge`);
      if (branches.some((branch) => branch !== undefined)) errors.push(`Node ${node.id} cannot use loop branches`);
    }
  }
  if (start.length === 1 && end.length === 1) {
    const outgoing = new Map<string, string[]>();
    const incoming = new Map<string, string[]>();
    for (const edge of parsedEdges) {
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
      incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
    }
    const fromStart = reachable(String(start[0]), outgoing);
    const toEnd = reachable(String(end[0]), incoming);
    for (const node of nodes) {
      if (typeof node.id !== "string" || typeof node.name !== "string") continue;
      if (!fromStart.has(node.id)) errors.push(`Node ${node.name} is not reachable from Start`);
      else if (!toEnd.has(node.id)) errors.push(`Node ${node.name} cannot reach End`);
    }
  }
  return errors;
}

function validPorts(value: unknown, inputFields: boolean): boolean {
  if (value === undefined) return !inputFields;
  if (!Array.isArray(value) || value.length === 0) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const port = item as Record<string, unknown>;
    if (typeof port.id !== "string" || !port.id || typeof port.name !== "string" || !port.name || ids.has(port.id)) return false;
    if (port.required !== undefined && typeof port.required !== "boolean") return false;
    if (inputFields && (typeof port.description !== "string" || typeof port.multiline !== "boolean")) return false;
    ids.add(port.id);
  }
  return true;
}
function inputPortIds(node: Record<string, unknown> | undefined): Set<string> {
  const config = node?.config as Record<string, unknown> | undefined;
  const ports = node?.type === "agent" ? config?.inputs : node?.type === "output" ? config?.fields : node?.type === "loop_counter" ? [{ id: "input" }] : [];
  return new Set(Array.isArray(ports) ? ports.flatMap((port) => port && typeof port === "object" && typeof (port as { id?: unknown }).id === "string" ? [(port as { id: string }).id] : []) : []);
}
function outputPortIds(node: Record<string, unknown> | undefined): Set<string> {
  const config = node?.config as Record<string, unknown> | undefined;
  const ports = node?.type === "agent" ? config?.outputs : node?.type === "input" ? config?.fields : node?.type === "loop_counter" ? [{ id: "loop" }, { id: "done" }] : [];
  return new Set(Array.isArray(ports) ? ports.flatMap((port) => port && typeof port === "object" && typeof (port as { id?: unknown }).id === "string" ? [(port as { id: string }).id] : []) : []);
}

function reachable(start: string, adjacency: Map<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(adjacency.get(id) ?? []));
  }
  return visited;
}
