export type AgentProductId = "codex" | "claude" | "trae" | "opencode";

export type PermissionMode =
  | "request_approval"
  | "help_me_approve"
  | "full_access";

export type TurnStatus =
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "start_failed"
  | "failed"
  | "interrupted"
  | "cancel_failed";

export interface PluginVersion {
  pluginId: string;
  versionId: string;
}

export interface TurnSnapshot {
  modelId: string | null;
  permissionMode: PermissionMode;
  pluginVersions: PluginVersion[];
}

export interface Conversation {
  id: string;
  projectId: string;
  agentProductId: AgentProductId;
  modelId: string | null;
  permissionMode: PermissionMode;
  createdAt: string;
  updatedAt: string;
}

export interface Turn {
  id: string;
  conversationId: string;
  status: TurnStatus;
  messageId: string;
  nativeTurnId: string | null;
  snapshot: TurnSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface QueuedMessage {
  id: string;
  conversationId: string;
  content: string;
  createdAt: string;
}

export type NormalizedEventType =
  | "assistant_message"
  | "user_message"
  | "reasoning"
  | "tool"
  | "shell"
  | "file"
  | "permission"
  | "usage"
  | "warning"
  | "turn_status";

export interface NormalizedEvent {
  id: string;
  conversationId: string;
  sequence: number;
  type: NormalizedEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AgentProbe {
  status:
    | "not_installed"
    | "authentication_required"
    | "available"
    | "runtime_error"
    | "version_unsupported"
    | "capability_limited";
  version?: string;
  diagnostic?: string;
}

export interface AgentCatalog {
  models: string[];
  permissionModes: PermissionMode[];
}

export interface SessionInput {
  projectPath: string;
  conversationId: string;
  nativeSessionId: string | null;
}

export interface LiveSession {
  id: string;
  nativeSessionId: string | null;
}

export interface StartTurnInput {
  content: string;
  snapshot: TurnSnapshot;
}

export interface NativeTurn {
  nativeTurnId: string | null;
}

export type PermissionDecision = "allow_once" | "deny_once";

export interface CancelResult {
  confirmed: boolean;
}

export interface NativePluginCandidate {
  pluginId: string;
  name: string;
  versionId: string;
}

export interface MaterializeInput {
  projectPath: string;
  plugins: PluginVersion[];
}

export interface MaterializeResult {
  applied: PluginVersion[];
}

export interface AgentConnector {
  readonly id: AgentProductId;
  probe(): Promise<AgentProbe>;
  fetchCatalog(projectPath: string): Promise<AgentCatalog>;
  createOrResumeSession(input: SessionInput): Promise<LiveSession>;
  startTurn(session: LiveSession, input: StartTurnInput): Promise<NativeTurn>;
  respondToPermission(
    session: LiveSession,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;
  cancelTurn(
    session: LiveSession,
    nativeTurnId: string | null,
  ): Promise<CancelResult>;
  closeSession(session: LiveSession): Promise<void>;
  discoverPlugins(): Promise<NativePluginCandidate[]>;
  materializePlugins(input: MaterializeInput): Promise<MaterializeResult>;
}

export interface CreateConversationRequest {
  projectId: string;
  agentProductId: AgentProductId;
  modelId: string | null;
}

export interface QueueMessageRequest {
  content: string;
}
