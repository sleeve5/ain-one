import type {
  ActiveTurnStatus,
  AgentCatalog,
  AgentProbe,
  AgentProductId,
  Conversation,
  ConversationSettingsInput,
  CreateConversationInput,
  NormalizedEvent,
  PermissionMode,
  PluginVersion,
  Project,
  Turn,
  GraphProject,
  GraphRun,
  GraphNodeRun,
  GraphRunEvent,
} from "../shared/contracts.js";
import { coalesceConversationEvents } from "./store.js";

type FetchFn = typeof fetch;

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  archivedAt?: string | null;
}

export interface PendingMessage {
  id: string;
  content: string;
  status?: "pending" | "staged" | "uncertain";
  deliveryId?: string | null;
  createdAt: string;
}

export interface PluginOption {
  id: string;
  pluginId: string;
  versionId: string;
  name: string;
  type: "skill" | "mcp";
  compatibleAgents: AgentProductId[];
  materializations: PluginMaterializationView[];
}

export interface PluginMaterializationView {
  agentProductId: AgentProductId;
  status: "materialized" | "not_materialized" | "conflicted" | "turn_scoped";
  repairable: boolean;
}

export interface AgentSettingsView {
  id: AgentProductId;
  name: string;
  status: AgentProbe["status"];
  version?: string;
  executablePath: string;
  executablePathOverride?: string;
  enabled?: boolean;
  diagnostic?: string;
  catalog: AgentCatalog;
  projectCatalogs?: Record<string, AgentCatalog>;
}

export interface PluginCandidateView extends PluginOption {
  candidateId: string;
  sourceAgent: AgentProductId;
}

export interface ConversationView {
  id: string;
  projectId: string;
  title: string;
  agentProductId: AgentProductId;
  agentProductLabel: string;
  modelId: string | null;
  permissionMode: PermissionMode;
  availableModels: string[];
  availablePermissionModes: PermissionMode[];
  enabledPluginIds: string[];
  availablePlugins: PluginOption[];
  activeTurnStatus: ActiveTurnStatus | null;
  latestTurnId: string | null;
  latestTurnStatus: Turn["status"] | null;
  queuePaused: boolean;
  queuedMessages: PendingMessage[];
  events: NormalizedEvent[];
  rawEvents?: NormalizedEvent[];
  archivedAt?: string | null;
}

export interface ArchivedWorkspaceState {
  projects: Project[];
  conversations: Conversation[];
}

export interface WorkspaceState {
  projects: ProjectView[];
  selectedProjectId: string | null;
  conversations: ConversationView[];
  selectedConversationId: string | null;
  conversation: ConversationView | null;
  agents: AgentSettingsView[];
  installedPlugins: PluginOption[];
  pluginCandidates: PluginCandidateView[];
  pluginError: string | null;
}

export interface AinOneApi {
  loadWorkspace(): Promise<WorkspaceState>;
  openProject(path: string): Promise<Project>;
  pickProject(): Promise<Project | null>;
  pickLocalPath?(kind: "directory" | "file"): Promise<string | null>;
  pickAgentExecutable?(agentProductId: AgentProductId): Promise<string | null>;
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  renameProject?(projectId: string, name: string): Promise<Project>;
  archiveProject?(projectId: string, archived: boolean): Promise<Project>;
  deleteArchivedProject?(projectId: string): Promise<void>;
  renameConversation?(conversationId: string, title: string): Promise<Conversation>;
  archiveConversation?(conversationId: string, archived: boolean): Promise<Conversation>;
  deleteArchivedConversation?(conversationId: string): Promise<void>;
  forkConversation?(conversationId: string): Promise<Conversation>;
  loadArchived?(): Promise<ArchivedWorkspaceState>;
  queueMessage(conversationId: string, content: string): Promise<void>;
  deletePendingMessage(conversationId: string, messageId: string): Promise<void>;
  resolveUncertainMessage(conversationId: string, messageId: string, action: "retry" | "accept"): Promise<void>;
  cancelActiveTurn(conversationId: string): Promise<void>;
  continueConversation(conversationId: string): Promise<void>;
  retryInterruptedTurn(conversationId: string, turnId: string): Promise<void>;
  respondToPermission(conversationId: string, requestId: string, decision: "allow_once" | "deny_once"): Promise<void>;
  subscribeConversationEvents(
    conversationId: string,
    afterSequence: number,
    onEvent: (event: NormalizedEvent) => void,
  ): () => void;
  updateConversationSettings(
    conversationId: string,
    settings: ConversationSettingsInput,
  ): Promise<void>;
  updateAgentExecutablePath(agentProductId: AgentProductId, executablePath: string | null): Promise<void>;
  setAgentEnabled?(agentProductId: AgentProductId, enabled: boolean): Promise<void>;
  installPlugin(path: string, type: "skill" | "mcp", compatibleAgents: AgentProductId[]): Promise<void>;
  refreshPluginImports(): Promise<void>;
  acceptPluginCandidate(candidateId: string): Promise<void>;
  repairPluginMaterialization(
    agentProductId: AgentProductId,
    plugin: PluginVersion,
  ): Promise<void>;
  getPluginEnablements(scope: PluginScope): Promise<PluginVersion[]>;
  setPluginEnablements(scope: PluginScope, pluginVersions: PluginVersion[]): Promise<void>;
  listGraphs(projectId: string): Promise<GraphProject[]>;
  createGraph(projectId: string, input: Omit<GraphProject, "id" | "projectId" | "createdAt" | "updatedAt">): Promise<GraphProject>;
  getGraph(graphId: string): Promise<{ graph: GraphProject; latestRun: GraphRun | null }>;
  saveGraph(graph: GraphProject): Promise<GraphProject>;
  deleteGraph(graphId: string): Promise<void>;
  runGraph(graphId: string, input: string): Promise<GraphRun>;
  getGraphRun(runId: string): Promise<{ run: GraphRun; nodeRuns: GraphNodeRun[]; events: GraphRunEvent[] }>;
  cancelGraphRun(runId: string): Promise<boolean>;
}

export type PluginScope =
  | { type: "global" }
  | { type: "project"; id: string }
  | { type: "conversation"; id: string };

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface HttpAinOneApiOptions {
  baseUrl?: string;
  token: string;
  fetchFn?: FetchFn;
  storage?: StorageLike;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

interface ConversationDetailResponse {
  conversation: Conversation;
  pluginVersions: PluginVersion[];
  queuedMessages: PendingMessage[];
  activeTurn: Turn | null;
  latestTurn: Turn | null;
  events: NormalizedEvent[];
}

interface PluginListResponse {
  plugins?: unknown;
  candidates?: unknown;
}

const ACTIVE_TURN_STATUS = new Set<ActiveTurnStatus>(["starting", "running", "cancelling"]);
const PHASE_ONE_AGENT_PRODUCTS = new Set<AgentProductId>(["codex", "claude", "trae"]);

export function isPhaseOneAgentProductId(value: unknown): value is AgentProductId {
  return typeof value === "string" && PHASE_ONE_AGENT_PRODUCTS.has(value as AgentProductId);
}

export function createHttpAinOneApi(options: HttpAinOneApiOptions): AinOneApi {
  const fetchFn = options.fetchFn ?? fetch;
  const storage = options.storage ?? getBrowserStorage();
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 250;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 8_000;

  const getJson = async <T>(path: string): Promise<T> => {
    const response = await fetchFn(`${baseUrl}${path}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${options.token}`,
      },
    });
    if (!response.ok) {
      throw await responseError(response, path);
    }
    return (await response.json()) as T;
  };

  const postJson = async <T = void>(path: string, body: unknown): Promise<T> => {
    const response = await fetchFn(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw await responseError(response, path);
    }
    return (await response.json()) as T;
  };

  const putJson = async <T = void>(path: string, body: unknown): Promise<T> => {
    const response = await fetchFn(`${baseUrl}${path}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw await responseError(response, path);
    }
    return (await response.json()) as T;
  };

  const patchJson = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetchFn(`${baseUrl}${path}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await responseError(response, path);
    return await response.json() as T;
  };

  return {
    async loadWorkspace(): Promise<WorkspaceState> {
      const [projectPayload, agentPayload, pluginPayload] = await Promise.all([
        getJson<{ projects: Project[] }>("/api/projects"),
        getJson<{
          agents: Array<{
            agentProductId: AgentProductId;
            executablePath: string;
            executablePathOverride: string | null;
            enabled: boolean;
            probe: AgentProbe;
          }>;
        }>("/api/agents"),
        tryLoadPlugins(getJson),
      ]);
      const projects: ProjectView[] = projectPayload.projects.map((project) => ({
        id: project.id,
        name: project.name,
        path: project.path,
        archivedAt: project.archivedAt ?? null,
      }));

      const primaryProject = projects[0] ?? null;
      const catalogPromises = new Map<string, Promise<AgentCatalog>>();
      const loadCatalog = (
        agentProductId: AgentProductId,
        projectId: string,
      ): Promise<AgentCatalog> => {
        const key = `${projectId}:${agentProductId}`;
        let promise = catalogPromises.get(key);
        if (!promise) {
          promise = tryGetCatalog(getJson, agentProductId, projectId);
          catalogPromises.set(key, promise);
        }
        return promise;
      };
      const agents = await Promise.all(
        agentPayload.agents
          .filter((agent) => isPhaseOneAgentProductId(agent.agentProductId))
          .map(async (agent): Promise<AgentSettingsView> => {
          const projectCatalogs = Object.fromEntries(
            await Promise.all(
              projects.map(async (project) => [
                project.id,
                await loadCatalog(agent.agentProductId, project.id),
              ] as const),
            ),
          );
          return {
            id: agent.agentProductId,
            name: toAgentLabel(agent.agentProductId),
            status: agent.probe.status,
            version: agent.probe.version,
            executablePath: agent.executablePath,
            executablePathOverride: agent.executablePathOverride ?? undefined,
            enabled: agent.enabled !== false,
            diagnostic: agent.probe.diagnostic,
            catalog: primaryProject
              ? projectCatalogs[primaryProject.id]
              : emptyCatalog(),
            projectCatalogs,
          };
        }),
      );

      if (!primaryProject) {
        return {
          projects,
          selectedProjectId: null,
          conversations: [],
          selectedConversationId: null,
          conversation: null,
          agents,
          installedPlugins: pluginPayload.plugins,
          pluginCandidates: pluginPayload.candidates,
          pluginError: pluginPayload.error,
        };
      }

      const projectConversations = await Promise.all(
        projects.map(async (project) => ({
          project,
          conversations: (
            await getJson<{ conversations: Conversation[] }>(
              `/api/projects/${encodeURIComponent(project.id)}/conversations`,
            )
          ).conversations,
        })),
      );
      const conversations = await Promise.all(
        projectConversations.flatMap(({ project, conversations: projectItems }) =>
          projectItems
            .filter((conversation) => isPhaseOneAgentProductId(conversation.agentProductId))
            .map(async (conversation) => {
            const [detail, catalog] = await Promise.all([
              getJson<ConversationDetailResponse>(
                `/api/conversations/${encodeURIComponent(conversation.id)}`,
              ),
              loadCatalog(conversation.agentProductId, project.id),
            ]);
            return toConversationView(
              detail.conversation,
              detail,
              catalog,
              pluginPayload.plugins.filter((plugin) =>
                plugin.compatibleAgents.includes(conversation.agentProductId),
              ),
            );
          }),
        ),
      );

      const selectedProjectId = projects[0]?.id ?? null;
      const selectedConversation =
        conversations.find((conversation) => conversation.projectId === selectedProjectId) ??
        conversations[0] ??
        null;

      return {
        projects,
        selectedProjectId,
        conversations,
        selectedConversationId: selectedConversation?.id ?? null,
        conversation: selectedConversation,
        agents,
        installedPlugins: pluginPayload.plugins,
        pluginCandidates: pluginPayload.candidates,
        pluginError: pluginPayload.error,
      };
    },

    async openProject(path): Promise<Project> {
      const payload = await postJson<{ project: Project }>("/api/projects", { path, name: null });
      return payload.project;
    },

    async pickProject(): Promise<Project | null> {
      const payload = await postJson<{ project: Project | null }>("/api/projects/pick", {});
      return payload.project;
    },

    async pickLocalPath(kind): Promise<string | null> {
      const payload = await getJson<{ path: string | null }>(
        `/api/host/pick-path?kind=${kind}&purpose=plugin`,
      );
      return payload.path;
    },

    async pickAgentExecutable(agentProductId): Promise<string | null> {
      const payload = await getJson<{ path: string | null }>(
        `/api/host/pick-path?kind=file&purpose=agent&agentProductId=${encodeURIComponent(agentProductId)}`,
      );
      return payload.path;
    },

    async createConversation(input): Promise<Conversation> {
      const payload = await postJson<{ conversation: Conversation }>("/api/conversations", input);
      return payload.conversation;
    },

    async renameProject(projectId, name): Promise<Project> {
      const payload = await patchJson<{ project: Project }>(`/api/projects/${encodeURIComponent(projectId)}`, { name });
      return payload.project;
    },

    async archiveProject(projectId, archived): Promise<Project> {
      const payload = await patchJson<{ project: Project }>(`/api/projects/${encodeURIComponent(projectId)}`, { archived });
      return payload.project;
    },

    async deleteArchivedProject(projectId): Promise<void> {
      const response = await fetchFn(`${baseUrl}/api/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${options.token}` },
      });
      if (!response.ok) throw await responseError(response, "delete archived Project");
    },

    async renameConversation(conversationId, title): Promise<Conversation> {
      const payload = await patchJson<{ conversation: Conversation }>(`/api/conversations/${encodeURIComponent(conversationId)}`, { title });
      return payload.conversation;
    },

    async archiveConversation(conversationId, archived): Promise<Conversation> {
      const payload = await patchJson<{ conversation: Conversation }>(`/api/conversations/${encodeURIComponent(conversationId)}`, { archived });
      return payload.conversation;
    },

    async deleteArchivedConversation(conversationId): Promise<void> {
      const response = await fetchFn(`${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${options.token}` },
      });
      if (!response.ok) throw await responseError(response, "delete archived Conversation");
    },

    async forkConversation(conversationId): Promise<Conversation> {
      const payload = await postJson<{ conversation: Conversation }>(`/api/conversations/${encodeURIComponent(conversationId)}/fork`, {});
      return payload.conversation;
    },

    async loadArchived(): Promise<ArchivedWorkspaceState> {
      const [active, archived] = await Promise.all([
        getJson<{ projects: Project[] }>("/api/projects"),
        getJson<{ projects: Project[] }>("/api/projects?archived=true"),
      ]);
      const projects = uniqueById(archived.projects);
      const allProjects = uniqueById([...active.projects, ...projects]);
      const conversations = uniqueById((await Promise.all(allProjects.map(async (project) =>
        (await getJson<{ conversations: Conversation[] }>(`/api/projects/${encodeURIComponent(project.id)}/conversations?archived=true`)).conversations
      ))).flat());
      return { projects, conversations };
    },

    async queueMessage(conversationId, content): Promise<void> {
      await postJson(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
        content,
      });
    },

    async deletePendingMessage(conversationId, messageId): Promise<void> {
      const response = await fetchFn(
        `${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${options.token}`,
          },
        },
      );
      if (!response.ok && response.status !== 404) {
        throw await responseError(response, "delete pending message");
      }
    },

    async resolveUncertainMessage(conversationId, messageId, action): Promise<void> {
      await postJson(
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/resolve`,
        { action },
      );
    },

    async cancelActiveTurn(conversationId): Promise<void> {
      await postJson(`/api/conversations/${encodeURIComponent(conversationId)}/cancel`, {});
    },

    async respondToPermission(conversationId, requestId, decision): Promise<void> {
      await postJson(
        `/api/conversations/${encodeURIComponent(conversationId)}/permissions/${encodeURIComponent(requestId)}`,
        { decision },
      );
    },

    async continueConversation(conversationId): Promise<void> {
      await postJson(`/api/conversations/${encodeURIComponent(conversationId)}/continue`, {});
    },

    async retryInterruptedTurn(conversationId, turnId): Promise<void> {
      await postJson(
        `/api/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/retry`,
        {},
      );
    },

    subscribeConversationEvents(conversationId, afterSequence, onEvent): () => void {
      const controller = new AbortController();
      let stopped = false;
      let lastSequence = Math.max(afterSequence, 0);

      void (async () => {
        let attempt = 0;
        while (!stopped) {
          try {
            const response = await fetchFn(
              `${baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/events?after=${lastSequence}`,
              {
                method: "GET",
                headers: {
                  authorization: `Bearer ${options.token}`,
                  accept: "text/event-stream",
                },
                signal: controller.signal,
              },
            );
            if (!response.ok || !response.body) {
              throw new Error(`SSE request failed (${response.status})`);
            }

            let receivedEvent = false;
            await consumeSse(response.body, controller.signal, (event) => {
              receivedEvent = true;
              onEvent(event);
              lastSequence = Math.max(lastSequence, event.sequence);
              storeEventSequence(storage, conversationId, event.sequence);
            });
            if (receivedEvent) {
              attempt = 0;
            }
          } catch {
            if (stopped || controller.signal.aborted) {
              break;
            }
          }

          if (stopped || controller.signal.aborted) {
            break;
          }

          const delayMs = Math.min(
            reconnectMaxDelayMs,
            reconnectBaseDelayMs * 2 ** Math.min(attempt, 6),
          );
          attempt += 1;
          await wait(delayMs, controller.signal);
        }
      })();

      return () => {
        stopped = true;
        controller.abort();
      };
    },

    async updateConversationSettings(conversationId, settings): Promise<void> {
      await putJson(`/api/conversations/${encodeURIComponent(conversationId)}/settings`, settings);
    },

    async updateAgentExecutablePath(agentProductId, executablePath): Promise<void> {
      await putJson(`/api/agents/${encodeURIComponent(agentProductId)}/settings`, {
        executablePath,
      });
    },

    async setAgentEnabled(agentProductId, enabled): Promise<void> {
      await putJson(`/api/agents/${encodeURIComponent(agentProductId)}/settings`, { enabled });
    },

    async installPlugin(path, type, compatibleAgents): Promise<void> {
      await postJson("/api/plugins/install", type === "skill"
        ? {
            path,
            compatibility: Object.fromEntries(
              compatibleAgents.map((agentProductId) => [agentProductId, { kind: "skill" }]),
            ),
          }
        : { path });
    },

    async refreshPluginImports(): Promise<void> {
      await postJson("/api/plugins/scan", {});
    },

    async acceptPluginCandidate(candidateId): Promise<void> {
      await postJson(`/api/plugins/candidates/${encodeURIComponent(candidateId)}/accept`, {});
    },

    async repairPluginMaterialization(agentProductId, plugin): Promise<void> {
      await postJson(
        `/api/plugins/${encodeURIComponent(plugin.pluginId)}/versions/${encodeURIComponent(plugin.versionId)}/materializations/${encodeURIComponent(agentProductId)}/repair`,
        {},
      );
    },

    async getPluginEnablements(scope): Promise<PluginVersion[]> {
      const payload = await getJson<{ pluginVersions: PluginVersion[] }>(pluginScopePath(scope));
      return payload.pluginVersions;
    },

    async setPluginEnablements(scope, pluginVersions): Promise<void> {
      await putJson(pluginScopePath(scope), { pluginVersions });
    },

    async listGraphs(projectId): Promise<GraphProject[]> {
      return (await getJson<{ graphs: GraphProject[] }>(`/api/projects/${encodeURIComponent(projectId)}/graphs`)).graphs;
    },
    async createGraph(projectId, input): Promise<GraphProject> {
      return (await postJson<{ graph: GraphProject }>(`/api/projects/${encodeURIComponent(projectId)}/graphs`, input)).graph;
    },
    async getGraph(graphId) {
      return getJson<{ graph: GraphProject; latestRun: GraphRun | null }>(`/api/graphs/${encodeURIComponent(graphId)}`);
    },
    async saveGraph(graph): Promise<GraphProject> {
      const { name, description, definition, viewport, positions } = graph;
      return (await putJson<{ graph: GraphProject }>(`/api/graphs/${encodeURIComponent(graph.id)}`, { name, description, definition, viewport, positions })).graph;
    },
    async deleteGraph(graphId): Promise<void> {
      const response = await fetchFn(`${baseUrl}/api/graphs/${encodeURIComponent(graphId)}`, { method: "DELETE", headers: { authorization: `Bearer ${options.token}` } });
      if (!response.ok) throw await responseError(response, "delete Graph");
    },
    async runGraph(graphId, input): Promise<GraphRun> {
      return (await postJson<{ run: GraphRun }>(`/api/graphs/${encodeURIComponent(graphId)}/runs`, { input })).run;
    },
    async getGraphRun(runId) {
      return getJson<{ run: GraphRun; nodeRuns: GraphNodeRun[]; events: GraphRunEvent[] }>(`/api/graph-runs/${encodeURIComponent(runId)}`);
    },
    async cancelGraphRun(runId): Promise<boolean> {
      return (await postJson<{ cancelled: boolean }>(`/api/graph-runs/${encodeURIComponent(runId)}/cancel`, {})).cancelled;
    },
  };
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function toConversationView(
  conversation: Conversation,
  detail: ConversationDetailResponse,
  catalog: AgentCatalog | null,
  plugins: PluginOption[],
): ConversationView {
  const availableModels = catalog?.models ?? (conversation.modelId ? [conversation.modelId] : []);
  const availablePermissionModes =
    catalog?.permissionModes && catalog.permissionModes.length > 0
      ? catalog.permissionModes
      : [conversation.permissionMode];

  const enabledPluginIds = detail.pluginVersions
    .map((version) => pluginKey(version))
    .filter((id) => plugins.some((plugin) => plugin.id === id));

  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title ?? `Conversation ${conversation.id.slice(0, 8)}`,
    agentProductId: conversation.agentProductId,
    agentProductLabel: toAgentLabel(conversation.agentProductId),
    modelId: conversation.modelId,
    permissionMode: conversation.permissionMode,
    availableModels,
    availablePermissionModes,
    enabledPluginIds,
    availablePlugins: plugins,
    activeTurnStatus: detail.activeTurn ? normalizeActiveStatus(detail.activeTurn.status) : null,
    latestTurnId: detail.latestTurn?.id ?? null,
    latestTurnStatus: detail.latestTurn?.status ?? null,
    queuePaused: conversation.queuePaused,
    queuedMessages: detail.queuedMessages,
    events: coalesceConversationEvents(detail.events ?? []),
    rawEvents: detail.events ?? [],
    archivedAt: conversation.archivedAt ?? null,
  };
}

function normalizeActiveStatus(status: Turn["status"]): ActiveTurnStatus | null {
  return ACTIVE_TURN_STATUS.has(status as ActiveTurnStatus) ? (status as ActiveTurnStatus) : null;
}

async function tryGetCatalog(
  getJson: <T>(path: string) => Promise<T>,
  agentProductId: AgentProductId,
  projectId: string,
): Promise<AgentCatalog> {
  try {
    const payload = await getJson<{ catalog: AgentCatalog }>(
      `/api/agents/${encodeURIComponent(agentProductId)}/catalog?projectId=${encodeURIComponent(projectId)}`,
    );
    return payload.catalog;
  } catch {
    return { ...emptyCatalog(), error: "Could not load Agent catalog" };
  }
}

async function tryLoadPlugins(
  getJson: <T>(path: string) => Promise<T>,
): Promise<{ plugins: PluginOption[]; candidates: PluginCandidateView[]; error: string | null }> {
  try {
    const payload = await getJson<PluginListResponse>("/api/plugins");
    return {
      plugins: Array.isArray(payload.plugins)
        ? payload.plugins.map(parseInstalledPlugin).filter(isPresent)
        : [],
      candidates: Array.isArray(payload.candidates)
        ? payload.candidates.map(parsePluginCandidate).filter(isPresent)
        : [],
      error: null,
    };
  } catch (error) {
    return {
      plugins: [],
      candidates: [],
      error: error instanceof Error ? error.message : "Could not load plugin inventory",
    };
  }
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const payload = await response.json() as { error?: { code?: unknown; message?: unknown } };
    const code = payload.error?.code;
    const message = payload.error?.message;
    if (typeof code === "string" && typeof message === "string") {
      return new Error(`${code}: ${message}`);
    }
  } catch {
    // Fall back to the HTTP status when the response is not normalized JSON.
  }
  return new Error(`Request failed (${response.status}) ${fallback}`);
}

function parseInstalledPlugin(value: unknown): PluginOption | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.pluginId !== "string" ||
    typeof record.versionId !== "string" ||
    (record.type !== "skill" && record.type !== "mcp") ||
    !Array.isArray(record.compatibleAgents)
  ) {
    return null;
  }
  const declaredAgents = record.compatibleAgents.filter(isAgentProductId);
  const compatibleAgents = declaredAgents.filter(isPhaseOneAgentProductId);
  if (declaredAgents.length > 0 && compatibleAgents.length === 0) {
    return null;
  }
  const materializations = Array.isArray(record.materializations)
    ? record.materializations.map(parseMaterialization).filter(isPresent)
    : [];
  return {
    id: pluginKey({ pluginId: record.pluginId, versionId: record.versionId }),
    pluginId: record.pluginId,
    versionId: record.versionId,
    name: `${record.pluginId} ${record.versionId.slice(0, 8)}`,
    type: record.type,
    compatibleAgents,
    materializations,
  };
}

function parseMaterialization(value: unknown): PluginMaterializationView | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !isPhaseOneAgentProductId(record.agentProductId) ||
    !isMaterializationStatus(record.status) ||
    typeof record.repairable !== "boolean"
  ) {
    return null;
  }
  return {
    agentProductId: record.agentProductId,
    status: record.status,
    repairable: record.repairable,
  };
}

function isMaterializationStatus(
  value: unknown,
): value is PluginMaterializationView["status"] {
  return value === "materialized" ||
    value === "not_materialized" ||
    value === "conflicted" ||
    value === "turn_scoped";
}

function parsePluginCandidate(value: unknown): PluginCandidateView | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const installed = parseInstalledPlugin(value);
  if (
    !installed ||
    typeof record.id !== "string" ||
    !isPhaseOneAgentProductId(record.agentProductId)
  ) {
    return null;
  }
  return {
    ...installed,
    candidateId: record.id,
    sourceAgent: record.agentProductId,
  };
}

function pluginScopePath(scope: PluginScope): string {
  return scope.type === "global"
    ? "/api/plugins/enablements/global"
    : `/api/plugins/enablements/${scope.type}/${encodeURIComponent(scope.id)}`;
}

function pluginKey(version: PluginVersion): string {
  return `${version.pluginId}@${version.versionId}`;
}

function emptyCatalog(): AgentCatalog {
  return { models: [], permissionModes: [] };
}

function isAgentProductId(value: unknown): value is AgentProductId {
  return value === "codex" || value === "claude" || value === "trae" || value === "opencode";
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function toAgentLabel(agentProductId: AgentProductId): string {
  switch (agentProductId) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude Code";
    case "trae":
      return "Trae";
    case "opencode":
      return "OpenCode";
    default:
      return agentProductId;
  }
}

async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: NormalizedEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }

      buffer += decoder.decode(chunk.value, { stream: true });

      while (true) {
        const boundary = buffer.match(/(?:\r\n|\r|\n){2}/);
        if (boundary?.index == null) {
          break;
        }
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseSseFrame(frame);
        if (event) {
          onEvent(event);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): NormalizedEvent | null {
  const lines = frame.split(/\r\n|\r|\n/);
  let data = "";
  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("data: ")) {
      data += line.slice(6);
    }
  }

  if (!data) {
    return null;
  }

  try {
    const parsed = JSON.parse(data) as Partial<NormalizedEvent>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.conversationId !== "string" ||
      typeof parsed.sequence !== "number" ||
      typeof parsed.type !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }

    return {
      id: parsed.id,
      conversationId: parsed.conversationId,
      sequence: parsed.sequence,
      type: parsed.type as NormalizedEvent["type"],
      payload: parsed.payload ?? {},
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function storeEventSequence(storage: StorageLike, conversationId: string, sequence: number): void {
  try {
    storage.setItem(eventSequenceStorageKey(conversationId), String(Math.max(sequence, 0)));
  } catch {
    // Ignore storage errors; live updates still continue in-memory.
  }
}

function eventSequenceStorageKey(conversationId: string): string {
  return `ain-one:event-sequence:${conversationId}`;
}

function getBrowserStorage(): StorageLike {
  const globalStorage = globalThis.localStorage;
  if (globalStorage) {
    return globalStorage;
  }

  const fallback = new Map<string, string>();
  return {
    getItem(key) {
      return fallback.get(key) ?? null;
    },
    setItem(key, value) {
      fallback.set(key, value);
    },
  };
}
