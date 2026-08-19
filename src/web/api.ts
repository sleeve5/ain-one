import type {
  ActiveTurnStatus,
  AgentCatalog,
  AgentProductId,
  Conversation,
  NormalizedEvent,
  PermissionMode,
  Project,
  Turn,
} from "../shared/contracts.js";

type FetchFn = typeof fetch;

export interface ProjectView {
  id: string;
  name: string;
  path: string;
}

export interface PendingMessage {
  id: string;
  content: string;
  createdAt: string;
}

export interface PluginOption {
  id: string;
  name: string;
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
  latestTurnStatus: Turn["status"] | null;
  queuePaused: boolean;
  queuedMessages: PendingMessage[];
  events: NormalizedEvent[];
}

export interface InspectorFileEntry {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
}

export interface InspectorState {
  currentPath: string;
  selectedPath: string | null;
  files: InspectorFileEntry[];
  preview: {
    path: string | null;
    language: string;
    content: string;
  };
  gitStatus: {
    branch: string;
    entries: Array<{ path: string; status: string }>;
  };
  gitDiff: {
    path: string | null;
    content: string;
  };
}

export interface InspectorSelection {
  path: string;
  type: InspectorFileEntry["type"];
}

export interface WorkspaceState {
  projects: ProjectView[];
  selectedProjectId: string | null;
  conversations: ConversationView[];
  selectedConversationId: string | null;
  conversation: ConversationView | null;
  inspector: InspectorState;
}

export interface ConversationDraftSettings {
  modelId: string | null;
  permissionMode: PermissionMode;
  enabledPluginIds: string[];
}

export interface AinOneApi {
  loadWorkspace(): Promise<WorkspaceState>;
  queueMessage(conversationId: string, content: string): Promise<void>;
  deletePendingMessage(conversationId: string, messageId: string): Promise<void>;
  cancelActiveTurn(conversationId: string): Promise<void>;
  subscribeConversationEvents(
    conversationId: string,
    afterSequence: number,
    onEvent: (event: NormalizedEvent) => void,
  ): () => void;
  updateConversationDraftSettings(
    conversationId: string,
    settings: ConversationDraftSettings,
  ): Promise<void>;
  listProjectFiles(
    projectId: string,
    selection?: InspectorSelection | null,
  ): Promise<InspectorState>;
}

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
  queuedMessages: PendingMessage[];
  activeTurn: Turn | null;
  latestTurn: Turn | null;
}

interface FileTreeResponse {
  path: string;
  entries: Array<{
    path: string;
    type: "file" | "directory" | "symlink" | "other";
  }>;
}

interface FilePreviewResponse {
  path: string;
  content: string | null;
  isBinary: boolean;
  truncated: boolean;
}

interface GitCommandResponse {
  output: string;
}

interface PluginListResponse {
  plugins?: unknown;
}

const FALLBACK_PERMISSION_MODES: PermissionMode[] = [
  "request_approval",
  "help_me_approve",
  "full_access",
];

const ACTIVE_TURN_STATUS = new Set<ActiveTurnStatus>(["starting", "running", "cancelling"]);

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
      throw new Error(`Request failed (${response.status}) ${path}`);
    }
    return (await response.json()) as T;
  };

  const postJson = async (path: string, body: unknown): Promise<void> => {
    const response = await fetchFn(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status}) ${path}`);
    }
  };

  return {
    async loadWorkspace(): Promise<WorkspaceState> {
      const projectPayload = await getJson<{ projects: Project[] }>("/api/projects");
      const projects: ProjectView[] = projectPayload.projects.map((project) => ({
        id: project.id,
        name: project.name,
        path: project.path,
      }));

      if (projects.length === 0) {
        return {
          projects,
          selectedProjectId: null,
          conversations: [],
          selectedConversationId: null,
          conversation: null,
          inspector: emptyInspectorState(),
        };
      }

      const availablePluginsPromise = tryListPlugins(getJson);
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
      const availablePlugins = await availablePluginsPromise;
      const catalogPromises = new Map<string, Promise<AgentCatalog | null>>();
      const conversations = await Promise.all(
        projectConversations.flatMap(({ project, conversations: projectItems }) =>
          projectItems.map(async (conversation) => {
            const catalogKey = `${project.id}:${conversation.agentProductId}`;
            let catalogPromise = catalogPromises.get(catalogKey);
            if (!catalogPromise) {
              catalogPromise = tryGetCatalog(
                getJson,
                conversation.agentProductId,
                project.id,
              );
              catalogPromises.set(catalogKey, catalogPromise);
            }
            const [detail, catalog] = await Promise.all([
              getJson<ConversationDetailResponse>(
                `/api/conversations/${encodeURIComponent(conversation.id)}`,
              ),
              catalogPromise,
            ]);
            return toConversationView(
              detail.conversation,
              detail,
              catalog,
              availablePlugins,
              readConversationDraftSettings(storage, conversation.id),
            );
          }),
        ),
      );

      const selectedProjectId = projects[0]?.id ?? null;
      const selectedConversation =
        conversations.find((conversation) => conversation.projectId === selectedProjectId) ??
        conversations[0] ??
        null;

      const inspector = selectedProjectId
        ? await this.listProjectFiles(selectedProjectId)
        : emptyInspectorState();

      return {
        projects,
        selectedProjectId,
        conversations,
        selectedConversationId: selectedConversation?.id ?? null,
        conversation: selectedConversation,
        inspector,
      };
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
        throw new Error(`Request failed (${response.status}) delete pending message`);
      }
    },

    async cancelActiveTurn(conversationId): Promise<void> {
      await postJson(`/api/conversations/${encodeURIComponent(conversationId)}/cancel`, {});
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

            attempt = 0;
            await consumeSse(response.body, controller.signal, (event) => {
              onEvent(event);
              lastSequence = Math.max(lastSequence, event.sequence);
              storeEventSequence(storage, conversationId, event.sequence);
            });
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

    async updateConversationDraftSettings(conversationId, settings): Promise<void> {
      writeConversationDraftSettings(storage, conversationId, settings);
    },

    async listProjectFiles(projectId, selection = null): Promise<InspectorState> {
      const requestedDirectory =
        selection?.type === "directory"
          ? selection.path
          : selection?.type === "file"
            ? parentPath(selection.path)
            : ".";
      const treePath = requestedDirectory === "."
        ? ""
        : `?path=${encodeURIComponent(requestedDirectory)}`;
      const [tree, gitStatusResponse] = await Promise.all([
        getJson<FileTreeResponse>(
          `/api/projects/${encodeURIComponent(projectId)}/files${treePath}`,
        ),
        getJson<GitCommandResponse>(
          `/api/projects/${encodeURIComponent(projectId)}/git/status`,
        ),
      ]);

      const selected =
        selection?.type === "file"
          ? selection.path
          : selection?.type === "directory"
            ? null
            : tree.entries.find((entry) => entry.type === "file")?.path ?? null;

      let previewPath: string | null = null;
      let previewContent = "Select a file to preview.";
      let previewLanguage = "text";

      if (selected) {
        try {
          const preview = await getJson<FilePreviewResponse>(
            `/api/projects/${encodeURIComponent(projectId)}/preview?path=${encodeURIComponent(selected)}`,
          );
          previewPath = preview.path;
          previewLanguage = detectLanguage(preview.path);
          previewContent =
            preview.content ?? (preview.isBinary ? "Binary file preview is unavailable." : "");
          if (preview.truncated) {
            previewContent += "\n\n[truncated]";
          }
        } catch {
          previewPath = selected;
          previewContent = "Preview is unavailable for this file.";
        }
      }

      const gitStatus = parseGitStatus(gitStatusResponse.output);
      const gitDiffResponse = selected
        ? await getJson<GitCommandResponse>(
            `/api/projects/${encodeURIComponent(projectId)}/git/diff?path=${encodeURIComponent(selected)}`,
          )
        : { output: "" };

      return {
        currentPath: tree.path,
        selectedPath: selected,
        files: tree.entries.map((entry) => ({
          path: entry.path,
          type: entry.type,
        })),
        preview: {
          path: previewPath,
          language: previewLanguage,
          content: previewContent,
        },
        gitStatus,
        gitDiff: {
          path: selected,
          content: gitDiffResponse.output,
        },
      };
    },
  };
}

function toConversationView(
  conversation: Conversation,
  detail: ConversationDetailResponse,
  catalog: AgentCatalog | null,
  plugins: PluginOption[],
  storedSettings: ConversationDraftSettings | null,
): ConversationView {
  const availableModels = catalog?.models ?? (conversation.modelId ? [conversation.modelId] : []);
  const availablePermissionModes =
    catalog?.permissionModes && catalog.permissionModes.length > 0
      ? catalog.permissionModes
      : FALLBACK_PERMISSION_MODES;

  const modelId =
    storedSettings?.modelId && availableModels.includes(storedSettings.modelId)
      ? storedSettings.modelId
      : conversation.modelId;

  const permissionMode =
    storedSettings?.permissionMode && availablePermissionModes.includes(storedSettings.permissionMode)
      ? storedSettings.permissionMode
      : conversation.permissionMode;

  const enabledPluginIds =
    storedSettings?.enabledPluginIds?.filter((pluginId) =>
      plugins.some((plugin) => plugin.id === pluginId),
    ) ?? [];

  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: `Conversation ${conversation.id.slice(0, 8)}`,
    agentProductId: conversation.agentProductId,
    agentProductLabel: toAgentLabel(conversation.agentProductId),
    modelId,
    permissionMode,
    availableModels,
    availablePermissionModes,
    enabledPluginIds,
    availablePlugins: plugins,
    activeTurnStatus: detail.activeTurn ? normalizeActiveStatus(detail.activeTurn.status) : null,
    latestTurnStatus: detail.latestTurn?.status ?? null,
    queuePaused: conversation.queuePaused,
    queuedMessages: detail.queuedMessages,
    events: [],
  };
}

function normalizeActiveStatus(status: Turn["status"]): ActiveTurnStatus | null {
  return ACTIVE_TURN_STATUS.has(status as ActiveTurnStatus) ? (status as ActiveTurnStatus) : null;
}

function parseGitStatus(output: string): InspectorState["gitStatus"] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  let branch = "unknown";
  const entries: Array<{ path: string; status: string }> = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = line.slice(3).split("...")[0].trim();
      continue;
    }

    const status = line.slice(0, 2).trim() || "?";
    const path = line.slice(3).trim();
    if (!path) {
      continue;
    }
    entries.push({
      path,
      status,
    });
  }

  return {
    branch,
    entries,
  };
}

function detectLanguage(path: string): string {
  const extension = path.split(".").pop();
  switch (extension) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "css":
      return "css";
    case "md":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    default:
      return "text";
  }
}

function emptyInspectorState(): InspectorState {
  return {
    currentPath: ".",
    selectedPath: null,
    files: [],
    preview: {
      path: null,
      language: "text",
      content: "Open a project to inspect files.",
    },
    gitStatus: {
      branch: "unknown",
      entries: [],
    },
    gitDiff: {
      path: null,
      content: "",
    },
  };
}

async function tryGetCatalog(
  getJson: <T>(path: string) => Promise<T>,
  agentProductId: AgentProductId,
  projectId: string,
): Promise<AgentCatalog | null> {
  try {
    const payload = await getJson<{ catalog: AgentCatalog }>(
      `/api/agents/${encodeURIComponent(agentProductId)}/catalog?projectId=${encodeURIComponent(projectId)}`,
    );
    return payload.catalog;
  } catch {
    return null;
  }
}

async function tryListPlugins(
  getJson: <T>(path: string) => Promise<T>,
): Promise<PluginOption[]> {
  try {
    const payload = await getJson<PluginListResponse>("/api/plugins");
    if (!Array.isArray(payload.plugins)) {
      return [];
    }

    return payload.plugins
      .map((plugin) => {
        if (!plugin || typeof plugin !== "object") {
          return null;
        }
        const record = plugin as Record<string, unknown>;
        const id =
          (typeof record.pluginId === "string" && record.pluginId) ||
          (typeof record.id === "string" && record.id) ||
          null;
        if (!id) {
          return null;
        }
        const name =
          (typeof record.name === "string" && record.name) ||
          (typeof record.displayName === "string" && record.displayName) ||
          id;
        return {
          id,
          name,
        };
      })
      .filter((plugin): plugin is PluginOption => Boolean(plugin));
  } catch {
    return [];
  }
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
        const frameIndex = buffer.indexOf("\n\n");
        if (frameIndex === -1) {
          break;
        }
        const frame = buffer.slice(0, frameIndex);
        buffer = buffer.slice(frameIndex + 2);
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
  const lines = frame.split("\n");
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

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "." : path.slice(0, separator) || ".";
}

function readConversationDraftSettings(
  storage: StorageLike,
  conversationId: string,
): ConversationDraftSettings | null {
  try {
    const raw = storage.getItem(draftSettingsStorageKey(conversationId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<ConversationDraftSettings>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (
      !Array.isArray(parsed.enabledPluginIds) ||
      !parsed.enabledPluginIds.every((value) => typeof value === "string")
    ) {
      return null;
    }
    if (typeof parsed.permissionMode !== "string") {
      return null;
    }
    if (parsed.modelId !== null && typeof parsed.modelId !== "string") {
      return null;
    }

    return {
      modelId: parsed.modelId,
      permissionMode: parsed.permissionMode as PermissionMode,
      enabledPluginIds: parsed.enabledPluginIds,
    };
  } catch {
    return null;
  }
}

function writeConversationDraftSettings(
  storage: StorageLike,
  conversationId: string,
  settings: ConversationDraftSettings,
): void {
  try {
    storage.setItem(draftSettingsStorageKey(conversationId), JSON.stringify(settings));
  } catch {
    // Ignore storage errors so UI controls still work within this session.
  }
}

function draftSettingsStorageKey(conversationId: string): string {
  return `ain-one:draft-settings:${conversationId}`;
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
