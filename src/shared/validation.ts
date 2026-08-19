import type {
  AgentProductId,
  CreateConversationRequest,
  PermissionDecision,
  QueueMessageRequest,
} from "./contracts.js";

const SUPPORTED_AGENT_PRODUCTS: AgentProductId[] = [
  "codex",
  "claude",
  "trae",
  "opencode",
];

function assertObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function readString(
  value: Record<string, unknown>,
  key: string,
  errorMessage: string,
): string {
  if (typeof value[key] !== "string") {
    throw new Error(errorMessage);
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
    throw new Error(errorMessage);
  }
  return raw;
}

function parseAgentProductId(value: unknown): AgentProductId {
  if (typeof value !== "string" || !SUPPORTED_AGENT_PRODUCTS.includes(value as AgentProductId)) {
    throw new Error("Unsupported Agent Product");
  }
  return value as AgentProductId;
}

export function parseCreateConversation(input: unknown): CreateConversationRequest {
  const value = assertObject(input, "Invalid create conversation payload");
  const projectId = readString(value, "projectId", "projectId must be a string").trim();
  if (projectId.length === 0) {
    throw new Error("projectId cannot be empty");
  }

  return {
    projectId,
    agentProductId: parseAgentProductId(value.agentProductId),
    modelId: readNullableString(value, "modelId", "modelId must be a string or null"),
  };
}

export function parseQueueMessage(input: unknown): QueueMessageRequest {
  const value = assertObject(input, "Invalid queue message payload");
  const content = readString(value, "content", "content must be a string").trim();
  if (content.length === 0) {
    throw new Error("Message cannot be empty");
  }

  return { content };
}

export interface CreateProjectRequest {
  path: string;
  name: string | null;
}

export function parseCreateProject(input: unknown): CreateProjectRequest {
  const value = assertObject(input, "Invalid create project payload");
  const path = readString(value, "path", "path must be a string").trim();
  if (path.length === 0) {
    throw new Error("path cannot be empty");
  }

  const name = readNullableString(value, "name", "name must be a string or null")?.trim() ?? null;
  if (name !== null && name.length === 0) {
    throw new Error("name cannot be empty");
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
    throw new Error("Unsupported decision");
  }
  return decision;
}
