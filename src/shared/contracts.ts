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

export type ActiveTurnStatus = "starting" | "running" | "cancelling";

export type TerminalTurnStatus = Exclude<TurnStatus, ActiveTurnStatus>;

export interface NormalizedError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ConnectorEvent {
  type: NormalizedEventType;
  payload: Record<string, unknown>;
}

export interface PluginVersion {
  pluginId: string;
  versionId: string;
}

export interface TurnSnapshot {
  modelId: string | null;
  permissionMode: PermissionMode;
  pluginVersions: PluginVersion[];
  autoQueue?: boolean;
}

export interface Conversation {
  id: string;
  projectId: string;
  title?: string | null;
  agentProductId: AgentProductId;
  modelId: string | null;
  permissionMode: PermissionMode;
  queuePaused: boolean;
  autoQueue?: boolean;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  path: string;
  name: string;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeSessionRecord {
  id: string;
  conversationId: string;
  nativeSessionId: string | null;
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
  status: "pending" | "staged" | "uncertain";
  deliveryId: string | null;
  createdAt: string;
}

export interface ContinuationInput {
  messageId: string;
  deliveryId: string;
  content: string;
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
  | "queue_status"
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
  error?: string;
}

export interface SessionInput {
  projectPath: string;
  conversationId: string;
  nativeSessionId: string | null;
  onEvent?: (event: ConnectorEvent) => Promise<void> | void;
  onNativeSessionId?: (nativeSessionId: string | null) => Promise<void> | void;
}

export interface LiveSession {
  id: string;
  nativeSessionId: string | null;
}

export interface StartTurnInput {
  content: string;
  snapshot: TurnSnapshot;
  turnId?: string;
  mcpConfigPath?: string | null;
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
  continueTurn?(session: LiveSession, input: ContinuationInput): Promise<boolean>;
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
  autoQueue?: boolean;
}

export interface CreateConversationInput extends CreateConversationRequest {
  permissionMode?: PermissionMode;
}

export interface ConversationSettingsInput {
  modelId: string | null;
  permissionMode: PermissionMode;
  autoQueue?: boolean;
}

export interface AgentSettingsInput {
  executablePath?: string | null;
  enabled?: boolean;
}

export interface PluginEnablementsInput {
  pluginVersions: PluginVersion[];
}

export interface QueueMessageRequest {
  content: string;
}

export interface GraphPort { id: string; name: string; required?: boolean; kind?: "input" | "feedback"; }
export interface GraphInputField extends GraphPort { description: string; multiline: boolean; }
export type GraphValues = Record<string, string>;

export type GraphNode =
  | { id: string; type: "input"; name: string; config: { fields: GraphInputField[] } }
  | { id: string; type: "agent"; name: string; config: { agentProductId: AgentProductId; modelId: string | null; permissionMode: PermissionMode; prompt?: string; instruction?: string; inputs?: GraphPort[]; outputs?: GraphPort[] } }
  | { id: string; type: "output"; name: string; config: { fields: GraphPort[] } }
  | { id: string; type: "loop_counter"; name: string; config: { maxIterations: number } }
  | { id: string; type: "literal"; name: string; config: { value: string } }
  | { id: string; type: "template"; name: string; config: { template: string } }
  | { id: string; type: "passthrough"; name: string; config: Record<string, never> };

export interface GraphEdge {
  id: string;
  source: string;
  sourcePort?: string;
  target: string;
  targetPort?: string;
  condition?: { branch: "loop" | "done" };
  route?: { x: number; y: number };
}

export interface GraphDefinition {
  nodes: GraphNode[];
  edges: GraphEdge[];
  start: string[];
  end: string[];
}

export interface GraphViewport { x: number; y: number; zoom: number; }
export interface GraphNodePosition { x: number; y: number; }

export interface GraphProject {
  id: string;
  projectId: string;
  name: string;
  description: string;
  definition: GraphDefinition;
  viewport: GraphViewport;
  positions: Record<string, GraphNodePosition>;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GraphRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type GraphNodeRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface GraphRun {
  id: string;
  graphId: string;
  status: GraphRunStatus;
  input: string;
  inputValues?: GraphValues;
  output: string | null;
  outputValues?: GraphValues | null;
  graphSnapshot?: Pick<GraphProject, "name" | "definition" | "viewport" | "positions"> | null;
  error: NormalizedError | null;
  createdAt: string;
  updatedAt: string;
}

export interface GraphNodeRun {
  id: string;
  runId: string;
  nodeId: string;
  iteration: number;
  status: GraphNodeRunStatus;
  input: string;
  inputValues?: GraphValues;
  output: string | null;
  outputValues?: GraphValues | null;
  error: NormalizedError | null;
  createdAt: string;
  updatedAt: string;
}

export interface GraphRunEvent {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  nodeId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}
