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
  return parsed;
}

export function parseConversationSettings(input: unknown): ConversationSettingsInput {
  const value = assertObject(input, "Invalid conversation settings payload");

  return {
    modelId: readNullableString(value, "modelId", "modelId must be a string or null"),
    permissionMode: parsePermissionMode(value.permissionMode),
  };
}

export function parseAgentSettings(input: unknown): AgentSettingsInput {
  const value = assertObject(input, "Invalid Agent settings payload");
  const executablePath = readNullableString(
    value,
    "executablePath",
    "executablePath must be a string or null",
  );
  if (executablePath !== null && executablePath.trim().length === 0) {
    throw new ValidationError("executablePath cannot be empty");
  }
  return { executablePath: executablePath?.trim() ?? null };
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

export interface CreateProjectRequest {
  path: string;
  name: string | null;
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
