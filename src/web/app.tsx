import { startTransition, useEffect, useRef, useState } from "react";
import type { AgentProductId, CreateConversationInput, PluginVersion } from "../shared/contracts.js";
import { validateGraphDefinition } from "../shared/validation.js";
import type {
  AinOneApi,
  AgentSettingsView,
  ConversationView,
  ArchivedWorkspaceState,
  PluginScope,
} from "./api.js";
import { isPhaseOneAgentProductId } from "./api.js";
import { CanvasSwitch } from "./components/canvas-switch.js";
import { AppSettings, type SettingsSection } from "./components/app-settings.js";
import { ConversationCanvas, type NewConversationDraft } from "./components/conversation-canvas.js";
import { defaultGraph, GraphCanvas } from "./components/graph-canvas.js";
import { GeneralSettings } from "./components/general-settings.js";
import { ArchivedSettings } from "./components/archived-settings.js";
import { AgentBadge } from "./components/agent-badge.js";
import {
  PluginSettings,
  type PluginScope as PluginScopeKind,
} from "./components/plugin-settings.js";
import { ProjectSidebar } from "./components/project-sidebar.js";
import { Settings } from "./components/settings.js";
import { TrajectoryCanvas } from "./components/trajectory-canvas.js";
import { readPreferences, writePreferences } from "./preferences.js";
import {
  applyConversationEvent,
  createInitialWorkspaceUiState,
  type CanvasKind,
  type WorkspaceUiState,
} from "./store.js";

interface AppProps {
  api: AinOneApi;
}

type ConfigurationWriteKey = string;
interface WorkspaceSelection {
  projectId?: string;
  conversationId?: string;
}

export function App(props: AppProps) {
  const [state, setState] = useState<WorkspaceUiState>(() => createInitialWorkspaceUiState());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [preferences, setPreferences] = useState(readPreferences);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pluginScope, setPluginScope] = useState<PluginScopeKind>("global");
  const [enabledPluginVersions, setEnabledPluginVersions] = useState<PluginVersion[]>([]);
  const [pluginEnablementsLoading, setPluginEnablementsLoading] = useState(false);
  const [archived, setArchived] = useState<ArchivedWorkspaceState>({ projects: [], conversations: [], graphs: [] });
  const [newConversation, setNewConversation] = useState<NewConversationDraft | null>(null);
  const [graphMode, setGraphMode] = useState<"editor" | "runs">("editor");
  const [clearGraphRequest, setClearGraphRequest] = useState(0);
  const [graphValidation, setGraphValidation] = useState<string[] | null>(null);
  const [unreadConversationIds, setUnreadConversationIds] = useState<Set<string>>(() => new Set());
  const selectedConversationIdRef = useRef<string | null>(null);
  const workspaceRequest = useRef(0);
  const workspaceGeneration = useRef(0);
  const locallyArchivedProjects = useRef(new Set<string>());
  const locallyArchivedConversations = useRef(new Set<string>());
  const locallyArchivedGraphs = useRef(new Set<string>());
  const pendingWorkspaceSelection = useRef<WorkspaceSelection | null>(null);
  const pluginRequest = useRef(0);
  const pluginScopeRef = useRef<PluginScopeKind>("global");
  const configurationWriteQueue = useRef<Promise<void> | null>(null);
  const configurationFailures = useRef<Record<ConfigurationWriteKey, string>>({});
  const agentExecutableWrites = useRef(new Map<AgentProductId, Promise<void>>());
  const enabledPluginVersionsRef = useRef<PluginVersion[]>([]);
  const creatingGraph = useRef(false);
  const resourceSelection = useRef(0);
  const [narrowScreen, setNarrowScreen] = useState(
    () => globalThis.matchMedia?.("(max-width: 960px)").matches ?? false,
  );

  const loadWorkspace = async (selection?: WorkspaceSelection): Promise<boolean> => {
    if (selection) {
      pendingWorkspaceSelection.current = selection;
    }
    const requestedSelection = selection ?? pendingWorkspaceSelection.current ?? undefined;
    const request = ++workspaceRequest.current;
    const generation = workspaceGeneration.current;
    try {
      const loadedWorkspace = await props.api.loadWorkspace();
      if (request !== workspaceRequest.current || generation !== workspaceGeneration.current) {
        return false;
      }
      setState((current) => {
        const workspace = {
          ...loadedWorkspace,
          graphs: (loadedWorkspace.graphError ? current.workspace.graphs ?? [] : loadedWorkspace.graphs ?? []).filter((graph) => !locallyArchivedProjects.current.has(graph.projectId) && !locallyArchivedGraphs.current.has(graph.id)),
          projects: loadedWorkspace.projects.filter((project) => !locallyArchivedProjects.current.has(project.id)),
          agents: loadedWorkspace.agents.filter((agent) => isPhaseOneAgentProductId(agent.id)),
          conversations: loadedWorkspace.conversations.filter((conversation) =>
            isPhaseOneAgentProductId(conversation.agentProductId) &&
            !locallyArchivedProjects.current.has(conversation.projectId) &&
            !locallyArchivedConversations.current.has(conversation.id)
          ),
          pluginCandidates: loadedWorkspace.pluginCandidates.filter((candidate) =>
            isPhaseOneAgentProductId(candidate.sourceAgent)
          ),
        };
        const conversations = workspace.conversations.map((conversation) => ({
          ...conversation,
          events:
            current.workspace.conversations.find((item) => item.id === conversation.id)?.events ??
            conversation.events,
          rawEvents:
            current.workspace.conversations.find((item) => item.id === conversation.id)?.rawEvents ??
            conversation.rawEvents,
        }));
        let selectedConversation: ConversationView | null;
        let selectedProjectId: string | null;
        if (requestedSelection?.conversationId) {
          selectedConversation =
            conversations.find((item) => item.id === requestedSelection.conversationId) ?? null;
          selectedProjectId = selectedConversation?.projectId ?? requestedSelection.projectId ?? null;
        } else if (requestedSelection?.projectId) {
          selectedProjectId = workspace.projects.some((item) => item.id === requestedSelection.projectId)
            ? requestedSelection.projectId
            : workspace.selectedProjectId;
          selectedConversation =
            conversations.find(
              (item) =>
                item.id === current.workspace.selectedConversationId &&
                item.projectId === selectedProjectId,
            ) ??
            conversations.find((item) => item.projectId === selectedProjectId) ??
            null;
        } else if (current.selectedGraphId) {
          const graph = workspace.graphs.find((item) => item.id === current.selectedGraphId);
          selectedProjectId = graph?.projectId ?? current.workspace.selectedProjectId;
          selectedConversation = null;
        } else {
          selectedConversation =
            conversations.find((item) => item.id === current.workspace.selectedConversationId) ??
            conversations.find((item) => item.id === workspace.selectedConversationId) ??
            null;
          selectedProjectId = selectedConversation?.projectId ??
            (workspace.projects.some((item) => item.id === current.workspace.selectedProjectId)
              ? current.workspace.selectedProjectId
              : workspace.selectedProjectId);
        }
        const selectedGraphId = selectedConversation
          ? null
          : current.selectedGraphId && workspace.graphs.some((item) => item.id === current.selectedGraphId)
            ? current.selectedGraphId
            : workspace.graphs.find((item) => item.projectId === selectedProjectId)?.id ?? null;
        return {
          ...current,
          status: "ready",
          errorMessage: null,
          workspace: {
            ...workspace,
            conversations,
            selectedProjectId,
            selectedConversationId: selectedConversation?.id ?? null,
            conversation: selectedConversation,
          },
          selectedGraphId,
        };
      });
      const pendingSelection = pendingWorkspaceSelection.current;
      if (
        requestedSelection &&
        pendingSelection?.projectId === requestedSelection.projectId &&
        pendingSelection?.conversationId === requestedSelection.conversationId
      ) {
        pendingWorkspaceSelection.current = null;
      }
      return true;
    } catch (error) {
      if (request !== workspaceRequest.current) {
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      setState((current) =>
        current.status === "loading"
          ? { ...current, status: "error", errorMessage: message }
          : { ...current, actionError: `Could not refresh workspace: ${message}` },
      );
      return false;
    }
  };

  useEffect(() => {
    void loadWorkspace();
  }, []);

  useEffect(() => {
    document.documentElement.lang = preferences.language === "zh" ? "zh-CN" : "en";
    document.documentElement.dataset.theme = preferences.appearance;
    writePreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    const media = globalThis.matchMedia?.("(max-width: 960px)");
    if (!media) {
      return;
    }
    const update = (): void => setNarrowScreen(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const selectedConversation = state.workspace.conversation;
  const selectedProjectId = state.workspace.selectedProjectId;
  const selectedGraph = state.workspace.graphs?.find((graph) => graph.id === state.selectedGraphId) ?? null;
  selectedConversationIdRef.current = state.workspace.selectedConversationId;
  useEffect(() => {
    if (state.status !== "ready" || newConversation || selectedConversation || selectedGraph || !selectedProjectId) return;
    if (state.workspace.conversations.some((item) => item.projectId === selectedProjectId)) return;
    const agent = preferredAgent(state.workspace.agents);
    if (agent) setNewConversation(createNewConversationDraft(agent, selectedProjectId, preferences.defaultPermissionMode));
  }, [state.status, state.workspace.agents, state.workspace.conversations, selectedConversation, selectedGraph, selectedProjectId, newConversation, preferences.defaultPermissionMode]);
  const resolvePluginScope = (scope: PluginScopeKind): PluginScope | null => {
    if (scope === "global") {
      return { type: "global" };
    }
    if (scope === "project") {
      return selectedProjectId ? { type: "project", id: selectedProjectId } : null;
    }
    return selectedConversation ? { type: "conversation", id: selectedConversation.id } : null;
  };

  const loadPluginEnablements = async (scope: PluginScopeKind): Promise<void> => {
    if (scope !== pluginScopeRef.current) {
      return;
    }
    const resolvedScope = resolvePluginScope(scope);
    const request = ++pluginRequest.current;
    enabledPluginVersionsRef.current = [];
    setEnabledPluginVersions([]);
    setPluginEnablementsLoading(true);
    if (!resolvedScope) {
      setPluginEnablementsLoading(false);
      return;
    }
    try {
      const versions = await props.api.getPluginEnablements(resolvedScope);
      if (request === pluginRequest.current && scope === pluginScopeRef.current) {
        enabledPluginVersionsRef.current = versions;
        setEnabledPluginVersions(versions);
        setPluginEnablementsLoading(false);
      }
    } catch (error) {
      if (request === pluginRequest.current && scope === pluginScopeRef.current) {
        showActionError(actionError(error, "Could not load plugin enablements"));
      }
    }
  };

  useEffect(() => {
    if (settingsOpen && settingsSection === "plugins") {
      void loadPluginEnablements(pluginScope);
    }
    if (settingsOpen && settingsSection === "archived" && props.api.loadArchived) {
      void props.api.loadArchived().then(setArchived, () => showActionError("Could not load archived items"));
    }
  }, [settingsOpen, settingsSection, pluginScope, selectedProjectId, selectedConversation?.id]);

  const conversationIds = state.workspace.conversations.map((item) => item.id).join("\0");

  useEffect(() => {
    const unsubscribe = state.workspace.conversations.map((conversation) => {
      const replaySequence = conversation.events.reduce(
        (sequence, event) => Math.max(sequence, event.sequence),
        0,
      );
      return props.api.subscribeConversationEvents(conversation.id, replaySequence, (event) => {
        if (selectedConversationIdRef.current !== conversation.id && (event.type === "assistant_message" || isTerminalTurnEvent(event))) {
          setUnreadConversationIds((current) => new Set(current).add(conversation.id));
        }
        if (event.type === "turn_status") {
          workspaceGeneration.current += 1;
        }
        startTransition(() => {
          setState((current) => {
            const existing = current.workspace.conversations.find(
              (item) => item.id === conversation.id,
            );
            if (!existing) {
              return current;
            }

            const nextConversation = applyConversationEvent(existing, event);
            return {
              ...current,
              workspace: {
                ...current.workspace,
                conversation:
                  current.workspace.selectedConversationId === nextConversation.id
                    ? nextConversation
                    : current.workspace.conversation,
                conversations: current.workspace.conversations.map((item) =>
                  item.id === nextConversation.id ? nextConversation : item,
                ),
              },
            };
          });
        });
        if (isTerminalTurnEvent(event) || isQueueAcknowledgement(event)) {
          void loadWorkspace();
        }
      });
    });

    return () => {
      for (const stop of unsubscribe) {
        stop();
      }
    };
  }, [props.api, conversationIds]);

  const showActionError = (message: string): void => {
    setState((current) => ({ ...current, actionError: message }));
  };

  const clearActionError = (): void => {
    setState((current) => ({ ...current, actionError: null }));
  };

  const selectConversation = (conversationId: string): void => {
    const conversation = state.workspace.conversations.find((item) => item.id === conversationId);
    if (!conversation) {
      return;
    }
    pendingWorkspaceSelection.current = null;
    resourceSelection.current += 1;
    setUnreadConversationIds((current) => { const next = new Set(current); next.delete(conversationId); return next; });
    setNewConversation(null);
    setGraphMode("editor"); setGraphValidation(null);
    workspaceGeneration.current += 1;
    setState((current) => ({
      ...current,
      actionError: null,
      workspace: {
        ...current.workspace,
        selectedProjectId: conversation.projectId,
        selectedConversationId: conversationId,
        conversation,
      },
      selectedGraphId: null,
      activeCanvas: "conversation",
    }));
  };

  const selectGraph = (graphId: string): void => {
    const graph = state.workspace.graphs?.find((item) => item.id === graphId);
    if (!graph) return;
    resourceSelection.current += 1;
    setNewConversation(null);
    setGraphMode("editor"); setGraphValidation(validateGraphDefinition(graph.definition));
    setState((current) => ({ ...current, actionError: null, activeCanvas: "conversation", selectedGraphId: graphId, workspace: { ...current.workspace, selectedProjectId: graph.projectId, selectedConversationId: null, conversation: null } }));
  };

  const selectProject = (projectId: string): void => {
    const conversation =
      state.workspace.conversations.find((item) => item.projectId === projectId) ?? null;
    const graph = conversation ? null : state.workspace.graphs?.find((item) => item.projectId === projectId) ?? null;

    pendingWorkspaceSelection.current = null;
    resourceSelection.current += 1;
    setNewConversation(null);
    workspaceGeneration.current += 1;
    setState((current) => ({
      ...current,
      actionError: null,
      workspace: {
        ...current.workspace,
        selectedProjectId: projectId,
        selectedConversationId: conversation?.id ?? null,
        conversation,
      },
      selectedGraphId: graph?.id ?? null,
      activeCanvas: "conversation",
    }));
  };

  const patchConversation = (
    patch: (current: ConversationView) => ConversationView,
    conversationId = state.workspace.selectedConversationId,
  ): void => {
    if (!conversationId) {
      return;
    }
    workspaceGeneration.current += 1;
    setState((current) => {
      const target = current.workspace.conversations.find((item) => item.id === conversationId);
      if (!target) {
        return current;
      }

      const nextConversation = patch(target);
      return {
        ...current,
        workspace: {
          ...current.workspace,
          conversation:
            current.workspace.selectedConversationId === conversationId
              ? nextConversation
              : current.workspace.conversation,
          conversations: current.workspace.conversations.map((item) =>
            item.id === nextConversation.id ? nextConversation : item,
          ),
        },
      };
    });
  };

  const enqueueConfigurationWrite = (
    key: ConfigurationWriteKey,
    write: () => Promise<void>,
    errorMessage: string,
  ): Promise<void> => {
    const previous = configurationWriteQueue.current;
    const operation = previous ? previous.catch(() => undefined).then(write) : write();
    configurationWriteQueue.current = operation;
    void operation.then(
      () => {
        const previousError = configurationFailures.current[key];
        delete configurationFailures.current[key];
        if (configurationWriteQueue.current === operation) {
          configurationWriteQueue.current = null;
        }
        setState((current) =>
          current.actionError === previousError
            ? {
                ...current,
                actionError: Object.values(configurationFailures.current)[0] ?? null,
              }
            : current,
        );
      },
      (error) => {
        const message = actionError(error, errorMessage);
        configurationFailures.current[key] = message;
        if (configurationWriteQueue.current === operation) {
          configurationWriteQueue.current = null;
        }
        showActionError(message);
      },
    );
    return operation;
  };

  const persistConversationSettings = (conversation: ConversationView): void => {
    void enqueueConfigurationWrite(
      `conversation:${conversation.id}`,
      () =>
        props.api.updateConversationSettings(conversation.id, {
          modelId: conversation.modelId,
          permissionMode: conversation.permissionMode,
        }),
      "Could not update conversation settings",
    );
  };

  const changeCanvas = (activeCanvas: CanvasKind): void => {
    setState((current) => ({
      ...current,
      activeCanvas,
    }));
  };

  const reloadAfter = async (action: () => Promise<void>, errorMessage: string): Promise<void> => {
    try {
      await action();
      if (await loadWorkspace()) {
        clearActionError();
      }
    } catch (error) {
      const message = actionError(error, errorMessage);
      showActionError(message);
      throw new Error(message);
    }
  };

  const runSidebarAction = async (
    action: () => Promise<void>,
    errorMessage: string,
  ): Promise<void> => {
    clearActionError();
    try {
      await action();
    } catch (error) {
      showActionError(actionError(error, errorMessage));
    }
  };

  const updateAgentExecutablePath = async (
    agentProductId: AgentProductId,
    executablePath: string | null,
  ): Promise<void> => {
    const previous = agentExecutableWrites.current.get(agentProductId);
    const operation = (async () => {
      await previous?.catch(() => undefined);
      await reloadAfter(
        () => props.api.updateAgentExecutablePath(agentProductId, executablePath),
        "Could not update Agent Product settings",
      );
    })();
    agentExecutableWrites.current.set(agentProductId, operation);
    try {
      await operation;
    } finally {
      if (agentExecutableWrites.current.get(agentProductId) === operation) {
        agentExecutableWrites.current.delete(agentProductId);
      }
    }
  };

  const removeArchivedConversation = (conversationId: string): void => {
    workspaceGeneration.current += 1;
    setState((current) => {
      const conversations = current.workspace.conversations.filter((item) => item.id !== conversationId);
      if (conversations.length === current.workspace.conversations.length) return current;
      const selected = current.workspace.selectedConversationId === conversationId
        ? conversations.find((item) => item.projectId === current.workspace.selectedProjectId) ?? conversations[0] ?? null
        : current.workspace.conversation;
      return { ...current, workspace: { ...current.workspace, conversations, selectedConversationId: selected?.id ?? null, selectedProjectId: selected?.projectId ?? current.workspace.selectedProjectId, conversation: selected } };
    });
  };

  const removeArchivedProject = (projectId: string): void => {
    workspaceGeneration.current += 1;
    setState((current) => {
      const projects = current.workspace.projects.filter((item) => item.id !== projectId);
      const conversations = current.workspace.conversations.filter((item) => item.projectId !== projectId);
      const selectedProjectId = current.workspace.selectedProjectId === projectId ? projects[0]?.id ?? null : current.workspace.selectedProjectId;
      const selected = conversations.find((item) => item.projectId === selectedProjectId) ?? null;
      return { ...current, workspace: { ...current.workspace, projects, conversations, selectedProjectId, selectedConversationId: selected?.id ?? null, conversation: selected } };
    });
  };

  const startNewConversation = (): void => {
    if (!selectedProjectId) return;
    const agent = preferredAgent(state.workspace.agents);
    if (!agent) return;
    resourceSelection.current += 1;
    setNewConversation(createNewConversationDraft(agent, selectedProjectId, preferences.defaultPermissionMode));
    workspaceGeneration.current += 1;
    setState((current) => ({
      ...current,
      actionError: null,
      selectedGraphId: null, activeCanvas: "conversation", workspace: { ...current.workspace, selectedConversationId: null, conversation: null },
    }));
  };

  const startNewGraph = async (): Promise<void> => {
    if (!selectedProjectId || creatingGraph.current) return;
    creatingGraph.current = true;
    const selection = ++resourceSelection.current;
    workspaceGeneration.current += 1;
    try {
      const graph = await props.api.createGraph(selectedProjectId, defaultGraph(agentsForProject(state.workspace.agents, selectedProjectId)));
      const selectCreated = resourceSelection.current === selection;
      if (selectCreated) { setNewConversation(null); setGraphMode("editor"); }
      setState((current) => ({ ...current, actionError: null, ...(selectCreated ? { activeCanvas: "conversation" as const, selectedGraphId: graph.id } : {}), workspace: { ...current.workspace, graphs: [graph, ...(current.workspace.graphs ?? []).filter((item) => item.id !== graph.id)], ...(selectCreated ? { selectedProjectId: graph.projectId, selectedConversationId: null, conversation: null } : {}) } }));
    } catch (error) { if (resourceSelection.current === selection) showActionError(actionError(error, "Could not create Graph")); }
    finally { creatingGraph.current = false; }
  };

  const openProject = async (): Promise<void> => {
    try {
      const project = await props.api.pickProject();
      if (!project) return;
      const agent = preferredAgent(state.workspace.agents);
      resourceSelection.current += 1;
      workspaceGeneration.current += 1;
      setNewConversation(agent
        ? createNewConversationDraft(agent, project.id, preferences.defaultPermissionMode)
        : null);
      setState((current) => ({
        ...current,
        actionError: null,
        selectedGraphId: null,
        activeCanvas: "conversation",
        workspace: {
          ...current.workspace,
          projects: current.workspace.projects.some((item) => item.id === project.id)
            ? current.workspace.projects
            : [...current.workspace.projects, {
                id: project.id,
                name: project.name,
                path: project.path,
                archivedAt: project.archivedAt ?? null,
              }],
          selectedProjectId: project.id,
          selectedConversationId: null,
          conversation: null,
        },
      }));
    } catch (error) {
      showActionError(actionError(error, "Could not open Project"));
    }
  };

  const addCreatedConversation = (created: Awaited<ReturnType<AinOneApi["createConversation"]>>, activeTurnStatus: ConversationView["activeTurnStatus"] = null, events: ConversationView["events"] = []): ConversationView => {
    const agent = state.workspace.agents.find((item) => item.id === created.agentProductId);
    const catalog = agent?.projectCatalogs?.[created.projectId] ?? agent?.catalog;
    const conversationView: ConversationView = {
      id: created.id, projectId: created.projectId, title: created.title ?? `Conversation ${created.id.slice(0, 8)}`,
      agentProductId: created.agentProductId, agentProductLabel: agent?.name ?? created.agentProductId,
      modelId: created.modelId, permissionMode: created.permissionMode,
      availableModels: catalog?.models ?? (created.modelId ? [created.modelId] : []),
      availablePermissionModes: catalog?.permissionModes.length ? catalog.permissionModes : [created.permissionMode],
      enabledPluginIds: [],
      availablePlugins: state.workspace.installedPlugins.filter((plugin) => plugin.compatibleAgents.includes(created.agentProductId)),
      activeTurnStatus, latestTurnId: null, latestTurnStatus: activeTurnStatus, queuePaused: created.queuePaused,
      queuedMessages: [], events, rawEvents: events, archivedAt: created.archivedAt ?? null,
      lastTurnAt: created.createdAt,
    };
    workspaceGeneration.current += 1;
    setNewConversation(null);
    setState((current) => ({ ...current, actionError: null, workspace: {
      ...current.workspace, conversations: [conversationView, ...current.workspace.conversations.filter((item) => item.id !== conversationView.id)],
      selectedProjectId: conversationView.projectId, selectedConversationId: conversationView.id, conversation: conversationView,
    } }));
    return conversationView;
  };

  if (state.status === "loading") {
    return (
      <div className="workspace-empty">
        {preferences.language === "zh" ? "正在加载工作区…" : "Loading workspace..."}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="workspace-empty">
        {state.errorMessage ?? (preferences.language === "zh" ? "工作区加载失败。" : "Workspace failed to load.")}
      </div>
    );
  }

  const conversation = state.workspace.conversation;

  return (
    <div className="workspace">
      <header className="workspace__header">
        <div>
          <h1>Ain One</h1>
          {state.actionError ?? state.workspace.graphError ? (
            <p className="workspace__action-error" role="alert">
              {state.actionError ?? state.workspace.graphError}
            </p>
          ) : null}
        </div>
        <div className="workspace__drawer-buttons">
          <button
            type="button"
            className="workspace__drawer-button"
            aria-expanded={state.leftDrawerOpen}
            aria-controls="project-drawer"
            onClick={() =>
              setState((current) => ({
                ...current,
                leftDrawerOpen: !current.leftDrawerOpen,
              }))
            }
          >
            {preferences.language === "zh" ? "项目" : "Projects"}
          </button>
        </div>
      </header>

      <div
        className="workspace__layout"
        data-sidebar-collapsed={sidebarCollapsed}
      >
        <aside
          id="project-drawer"
          className="workspace__left"
          data-open={state.leftDrawerOpen}
          data-collapsed={sidebarCollapsed}
          inert={narrowScreen && !state.leftDrawerOpen}
          aria-hidden={narrowScreen && !state.leftDrawerOpen}
        >
          <ProjectSidebar
            projects={state.workspace.projects}
            conversations={state.workspace.conversations}
            graphs={state.workspace.graphs}
            selectedProjectId={state.workspace.selectedProjectId}
            selectedConversationId={state.workspace.selectedConversationId}
            selectedGraphId={state.selectedGraphId}
            unreadConversationIds={unreadConversationIds}
            onOpenProject={openProject}
            onRestartWorkspace={async () => {
              try {
                await props.api.restartWorkspace?.();
                if (await loadWorkspace()) clearActionError();
              } catch {
                showActionError(preferences.language === "zh" ? "无法重启工作区" : "Could not restart workspace");
              }
            }}
            onCreateConversation={startNewConversation}
            onCreateGraph={() => { void startNewGraph(); }}
            onSelectProject={(projectId) => {
              selectProject(projectId);
            }}
            onSelectConversation={selectConversation}
            onSelectGraph={selectGraph}
            onRenameProject={async (projectId, name) => {
              if (!props.api.renameProject) return;
              await runSidebarAction(async () => {
                const project = await props.api.renameProject!(projectId, name);
                setState((current) => ({ ...current, workspace: { ...current.workspace, projects: current.workspace.projects.map((item) => item.id === projectId ? { ...item, name: project.name } : item) } }));
              }, "Could not rename Project");
            }}
            onArchiveProject={async (projectId) => {
              if (!props.api.archiveProject) return;
              await runSidebarAction(async () => {
                await props.api.archiveProject!(projectId, true);
                locallyArchivedProjects.current.add(projectId);
                removeArchivedProject(projectId);
                await loadWorkspace();
              }, "Could not archive Project");
            }}
            onRenameConversation={async (conversationId, title) => {
              if (!props.api.renameConversation) return;
              await runSidebarAction(async () => {
                const renamed = await props.api.renameConversation!(conversationId, title);
                patchConversation((item) => ({ ...item, title: renamed.title ?? item.title }), conversationId);
              }, "Could not rename Conversation");
            }}
            onArchiveConversation={async (conversationId) => {
              if (!props.api.archiveConversation) return;
              await runSidebarAction(async () => {
                await props.api.archiveConversation!(conversationId, true);
                locallyArchivedConversations.current.add(conversationId);
                removeArchivedConversation(conversationId);
                await loadWorkspace();
              }, "Could not archive Conversation");
            }}
            onForkConversation={async (conversationId) => {
              await runSidebarAction(async () => {
                const created = await props.api.forkConversation?.(conversationId);
                const source = state.workspace.conversations.find((item) => item.id === conversationId);
                if (created) addCreatedConversation(created, null, cloneEvents(source?.events ?? [], created.id));
              }, "Could not branch Conversation");
            }}
            onRenameGraph={async (graphId, name) => {
              await runSidebarAction(async () => {
                const renamed = await props.api.renameGraph?.(graphId, name);
                if (renamed) setState((current) => ({ ...current, workspace: { ...current.workspace, graphs: (current.workspace.graphs ?? []).map((item) => item.id === graphId ? renamed : item) } }));
              }, "Could not rename Graph");
            }}
            onForkGraph={async (graphId) => {
              await runSidebarAction(async () => {
                const forked = await props.api.forkGraph?.(graphId);
                if (!forked) return;
                setNewConversation(null); setGraphMode("editor");
                setState((current) => ({ ...current, selectedGraphId: forked.id, workspace: { ...current.workspace, graphs: [forked, ...(current.workspace.graphs ?? [])], selectedProjectId: forked.projectId, selectedConversationId: null, conversation: null } }));
              }, "Could not branch Graph");
            }}
            onArchiveGraph={async (graphId) => {
              await runSidebarAction(async () => {
                await props.api.archiveGraph?.(graphId, true);
                locallyArchivedGraphs.current.add(graphId);
                setState((current) => {
                  const graphs = (current.workspace.graphs ?? []).filter((item) => item.id !== graphId);
                  if (current.selectedGraphId !== graphId) return { ...current, workspace: { ...current.workspace, graphs } };
                  const nextGraph = graphs.find((item) => item.projectId === current.workspace.selectedProjectId) ?? null;
                  const fallback = nextGraph ? null : current.workspace.conversations.find((item) => item.projectId === current.workspace.selectedProjectId) ?? null;
                  return { ...current, selectedGraphId: nextGraph?.id ?? null, workspace: { ...current.workspace, graphs, selectedConversationId: fallback?.id ?? null, conversation: fallback } };
                });
                await loadWorkspace();
              }, "Could not archive Graph");
            }}
            onOpenSettings={() => {
              setSettingsSection("general");
              setSettingsOpen(true);
            }}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
            language={preferences.language}
          />
        </aside>

        <main className="workspace__center">
          <div className="workspace__toolbar">
            <div className="workspace__conversation-title">
              <h2>{selectedGraph?.name ?? conversation?.title ?? (newConversation ? (preferences.language === "zh" ? "新对话" : "New conversation") : (preferences.language === "zh" ? "选择资源" : "Select a resource"))}</h2>
              {!selectedGraph && (conversation ?? newConversation) ? <AgentBadge agent={(conversation ?? newConversation)!.agentProductId}/> : null}
              {selectedGraph ? <div className="workspace__graph-actions">{graphValidation ? <span className="workspace__graph-status" data-valid={graphValidation.length === 0}>{graphValidation.length === 0 ? (preferences.language === "zh" ? "可运行" : "Runnable") : (preferences.language === "zh" ? "待完善" : "Incomplete")}</span> : null}<button type="button" onClick={() => setClearGraphRequest((value) => value + 1)}>{preferences.language === "zh" ? "清空图" : "Clear graph"}</button></div> : null}
            </div>
            {selectedGraph ? <div className="canvas-switch" role="group" aria-label="Graph view"><button type="button" className="canvas-switch__button" data-active={graphMode === "editor"} aria-pressed={graphMode === "editor"} onClick={() => setGraphMode("editor")}>{preferences.language === "zh" ? "编排" : "Editor"}</button><button type="button" className="canvas-switch__button" data-active={graphMode === "runs"} aria-pressed={graphMode === "runs"} onClick={() => setGraphMode("runs")}>{preferences.language === "zh" ? "最近运行" : "Latest run"}</button></div> : <CanvasSwitch value={state.activeCanvas} language={preferences.language} onChange={changeCanvas} />}
          </div>

          <section
            className="workspace__canvas"
            hidden={Boolean(selectedGraph) || state.activeCanvas !== "conversation"}
            aria-hidden={Boolean(selectedGraph) || state.activeCanvas !== "conversation"}
            inert={Boolean(selectedGraph) || state.activeCanvas !== "conversation"}
          >
            {state.workspace.projects.length === 0 ? <section className="workspace-empty workspace-empty--import"><div><h2>{preferences.language === "zh" ? "导入项目以开始对话" : "Import a project to start a conversation."}</h2><button type="button" onClick={() => void openProject()}>{preferences.language === "zh" ? "导入项目" : "Import project"}</button></div></section> : <ConversationCanvas
              conversation={newConversation ? null : conversation}
              showHeader={false}
              newConversation={newConversation}
              availableAgents={state.workspace.agents}
              onChangeAgent={(agentProductId) => {
                if (!newConversation) return;
                const agent = state.workspace.agents.find((item) => item.id === agentProductId);
                if (agent && isRunnableAgent(agent)) {
                  setNewConversation(createNewConversationDraft(agent, newConversation.projectId, preferences.defaultPermissionMode));
                }
              }}
              language={preferences.language}
              onChangeModel={(modelId) => {
                  if (newConversation) { setNewConversation({ ...newConversation, modelId }); return; }
                  if (!conversation) return;
                  const next = { ...conversation, modelId };
                  patchConversation(() => next);
                  persistConversationSettings(next);
              }}
              onChangePermissionMode={(permissionMode) => {
                  if (newConversation) { setNewConversation({ ...newConversation, permissionMode }); return; }
                  if (!conversation) return;
                  const next = { ...conversation, permissionMode };
                  patchConversation(() => next);
                  persistConversationSettings(next);
              }}
              onDeletePendingMessage={async (messageId) => {
                  if (!conversation) {
                    return;
                  }
                  const conversationId = conversation.id;
                  try {
                    await props.api.deletePendingMessage(conversationId, messageId);
                    clearActionError();
                    patchConversation((current) => ({
                      ...current,
                      queuedMessages: current.queuedMessages.filter((message) => message.id !== messageId),
                    }), conversationId);
                  } catch {
                    showActionError("Could not delete pending message");
                    throw new Error("delete failed");
                  }
              }}
              onResolveUncertainMessage={async (messageId, action) => {
                  if (!conversation) return;
                  try {
                    await props.api.resolveUncertainMessage(conversation.id, messageId, action);
                    await loadWorkspace({ projectId: conversation.projectId, conversationId: conversation.id });
                    clearActionError();
                  } catch {
                    showActionError(preferences.language === "zh" ? "无法处理待确认消息" : "Could not resolve uncertain message");
                  }
              }}
              onQueueMessage={async (content) => {
                  if (newConversation) {
                    const input: CreateConversationInput = {
                      projectId: newConversation.projectId, agentProductId: newConversation.agentProductId,
                      modelId: newConversation.modelId, permissionMode: newConversation.permissionMode,
                    };
                    let createdId: string | null = null;
                    try {
                      const created = await props.api.createConversation(input);
                      createdId = created.id;
                      addCreatedConversation(created, "starting");
                      await props.api.queueMessage(created.id, content);
                      clearActionError();
                      return;
                    } catch (error) {
                      if (createdId) patchConversation((item) => ({ ...item, activeTurnStatus: null }), createdId);
                      showActionError(actionError(error, "Could not create Conversation"));
                      throw error;
                    }
                  }
                  if (!conversation) {
                    return;
                  }
                  try {
                    while (configurationWriteQueue.current) {
                      await configurationWriteQueue.current.catch(() => undefined);
                    }
                    const configurationError =
                      configurationFailures.current[`conversation:${conversation.id}`] ??
                      configurationFailures.current[`plugins:conversation:${conversation.id}`];
                    if (configurationError) {
                      showActionError(configurationError);
                      throw new Error("configuration write failed");
                    }
                  } catch {
                    throw new Error("configuration write failed");
                  }
                  try {
                    if (!conversation.activeTurnStatus) {
                      patchConversation((item) => ({ ...item, activeTurnStatus: "starting", latestTurnStatus: "starting" }), conversation.id);
                    }
                    await props.api.queueMessage(conversation.id, content);
                    if (await loadWorkspace()) {
                      clearActionError();
                    }
                  } catch {
                    if (!conversation.activeTurnStatus) {
                      patchConversation((item) => ({ ...item, activeTurnStatus: null }), conversation.id);
                    }
                    showActionError("Could not send message");
                    throw new Error("send failed");
                  }
              }}
              onCancelTurn={async () => {
                  if (!conversation) {
                    return;
                  }
                  try {
                    await props.api.cancelActiveTurn(conversation.id);
                    clearActionError();
                  } catch {
                    showActionError("Could not stop active Turn");
                  }
              }}
              onRespondToPermission={async (requestId, decision) => {
                if (!conversation) return;
                try {
                  await props.api.respondToPermission(conversation.id, requestId, decision);
                  clearActionError();
                } catch {
                  showActionError("Could not respond to permission request");
                  throw new Error("permission response failed");
                }
              }}
              onForkConversation={async () => {
                if (!conversation) return;
                await runSidebarAction(async () => {
                  const created = await props.api.forkConversation?.(conversation.id);
                  if (created) {
                    addCreatedConversation(created, null, cloneEvents(conversation.events, created.id));
                  }
                }, "Could not branch Conversation");
              }}
            />}
          </section>

          <section
            className="workspace__canvas"
            hidden={Boolean(selectedGraph) || state.activeCanvas !== "trajectory"}
            aria-hidden={Boolean(selectedGraph) || state.activeCanvas !== "trajectory"}
            inert={Boolean(selectedGraph) || state.activeCanvas !== "trajectory"}
          >
            <TrajectoryCanvas language={preferences.language} events={conversation?.rawEvents ?? conversation?.events ?? []} />
          </section>

          <section
            className="workspace__canvas"
            hidden={!selectedGraph}
            aria-hidden={!selectedGraph}
            inert={!selectedGraph}
          >
            {selectedGraph ? <GraphCanvas language={preferences.language} api={props.api} graphId={selectedGraph.id} agents={agentsForProject(state.workspace.agents, selectedGraph.projectId)} view={graphMode} clearRequest={clearGraphRequest} onValidationChange={setGraphValidation} onGraphSaved={(saved) => setState((current) => ({ ...current, workspace: { ...current.workspace, graphs: [saved, ...(current.workspace.graphs ?? []).filter((item) => item.id !== saved.id)] } }))} /> : null}
          </section>

          <AppSettings
            open={settingsOpen}
            section={settingsSection}
            language={preferences.language}
            onSectionChange={setSettingsSection}
            archived={<ArchivedSettings state={archived} language={preferences.language} onRestoreProject={async (id) => { await runSidebarAction(async () => { await props.api.archiveProject?.(id, false); locallyArchivedProjects.current.delete(id); setArchived(await props.api.loadArchived?.() ?? { projects: [], conversations: [], graphs: [] }); await loadWorkspace(); }, "Could not restore Project"); }} onRestoreConversation={async (id) => { await runSidebarAction(async () => { await props.api.archiveConversation?.(id, false); locallyArchivedConversations.current.delete(id); setArchived(await props.api.loadArchived?.() ?? { projects: [], conversations: [], graphs: [] }); await loadWorkspace(); }, "Could not restore Conversation"); }} onRestoreGraph={async (id) => { await runSidebarAction(async () => { await props.api.archiveGraph?.(id, false); locallyArchivedGraphs.current.delete(id); setArchived(await props.api.loadArchived?.() ?? { projects: [], conversations: [], graphs: [] }); await loadWorkspace(); }, "Could not restore Graph"); }} onDeleteGraph={async (id) => { await runSidebarAction(async () => { await props.api.deleteGraph(id); setArchived((current) => ({ ...current, graphs: (current.graphs ?? []).filter((item) => item.id !== id) })); }, "Could not delete Graph"); }} onDeleteConversation={async (id) => { await runSidebarAction(async () => { await props.api.deleteArchivedConversation?.(id); setArchived((current) => ({ ...current, conversations: current.conversations.filter((item) => item.id !== id) })); }, "Could not delete Conversation"); }} onDeleteProject={async (id) => { await runSidebarAction(async () => { await props.api.deleteArchivedProject?.(id); locallyArchivedProjects.current.delete(id); setArchived((current) => ({ projects: current.projects.filter((item) => item.id !== id), conversations: current.conversations.filter((item) => item.projectId !== id), graphs: (current.graphs ?? []).filter((item) => item.projectId !== id) })); await loadWorkspace(); }, "Could not delete Project"); }}/>}
            onClose={() => setSettingsOpen(false)}
            general={<GeneralSettings value={preferences} onChange={setPreferences} />}
            agents={
              <Settings
                language={preferences.language}
                agents={state.workspace.agents.map((agent) => ({
                  ...agent,
                  catalog: selectedProjectId
                    ? agent.projectCatalogs?.[selectedProjectId] ?? agent.catalog
                    : agent.catalog,
                }))}
                onSaveExecutablePath={(agentProductId, executablePath) => {
                  void updateAgentExecutablePath(agentProductId, executablePath).catch(() => undefined);
                }}
                onPickExecutablePath={async (agentProductId) => await props.api.pickAgentExecutable?.(agentProductId) ?? null}
                onSetEnabled={(agentProductId, enabled) => {
                  void reloadAfter(
                    () => props.api.setAgentEnabled?.(agentProductId, enabled) ?? Promise.resolve(),
                    "Could not update Agent Product settings",
                  ).catch(() => undefined);
                }}
              />
            }
            plugins={
              <PluginSettings
                language={preferences.language}
                installedVersions={state.workspace.installedPlugins}
                error={state.workspace.pluginError}
                scope={pluginScope}
                conversationAgentProductId={selectedConversation?.agentProductId ?? null}
                enabledVersions={enabledPluginVersions}
                enablementsLoading={pluginEnablementsLoading}
                onInstallLocalPath={(path, type, compatibleAgents) => {
                  void reloadAfter(
                    () => props.api.installPlugin(path, type, compatibleAgents),
                    "Could not install plugin",
                  ).catch(() => undefined);
                }}
                onPickLocalPath={async (kind) => await props.api.pickLocalPath?.(kind) ?? null}
                onRefreshImports={() => {
                  void reloadAfter(
                    () => props.api.refreshPluginImports(),
                    "Could not refresh plugin imports",
                  ).catch(() => undefined);
                }}
                onScopeChange={(scope) => {
                  pluginRequest.current += 1;
                  pluginScopeRef.current = scope;
                  enabledPluginVersionsRef.current = [];
                  setEnabledPluginVersions([]);
                  setPluginEnablementsLoading(true);
                  setPluginScope(scope);
                }}
                onRepairMaterialization={(agentProductId, plugin) => {
                  void reloadAfter(
                    () => props.api.repairPluginMaterialization(agentProductId, plugin),
                    "Could not repair plugin materialization",
                  ).catch(() => undefined);
                }}
                onEnableChange={(scope, change) => {
                  const resolvedScope = resolvePluginScope(scope);
                  if (!resolvedScope) {
                    showActionError(`Select a ${scope} before changing plugin enablement`);
                    return;
                  }
                  const current = enabledPluginVersionsRef.current;
                  const next = change.enabled
                    ? [
                        ...current.filter((item) => item.pluginId !== change.pluginId),
                        { pluginId: change.pluginId, versionId: change.versionId },
                      ]
                    : current.filter(
                        (item) =>
                          item.pluginId !== change.pluginId || item.versionId !== change.versionId,
                      );
                  enabledPluginVersionsRef.current = next;
                  setEnabledPluginVersions(next);
                  const write = enqueueConfigurationWrite(
                    pluginWriteKey(resolvedScope),
                    () => props.api.setPluginEnablements(resolvedScope, next),
                    "Could not update plugin enablements",
                  );
                  void write.then(
                    () => loadWorkspace(),
                    async () => {
                      const pending = configurationWriteQueue.current;
                      if (pending && pending !== write) {
                        await pending.catch(() => undefined);
                      }
                      await loadPluginEnablements(scope);
                    },
                  );
                }}
              />
            }
          />
        </main>

      </div>
    </div>
  );
}

function isTerminalTurnEvent(event: Parameters<typeof applyConversationEvent>[1]): boolean {
  if (event.type !== "turn_status") {
    return false;
  }
  const status = event.payload.status;
  return status === "completed" ||
    status === "cancelled" ||
    status === "start_failed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancel_failed";
}

function isQueueAcknowledgement(event: Parameters<typeof applyConversationEvent>[1]): boolean {
  const acknowledged = event.payload.acknowledged;
  return event.type === "queue_status" && Boolean(
    acknowledged && typeof acknowledged === "object"
      && typeof (acknowledged as Record<string, unknown>).messageId === "string"
      && typeof (acknowledged as Record<string, unknown>).deliveryId === "string",
  );
}

function cloneEvents(events: ConversationView["events"], conversationId: string): ConversationView["events"] {
  return events.map((event) => ({ ...event, id: `${conversationId}:${event.sequence}`, conversationId }));
}

function pluginWriteKey(scope: PluginScope): string {
  return scope.type === "global" ? "plugins:global" : `plugins:${scope.type}:${scope.id}`;
}

function actionError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? `${fallback}: ${error.message}` : fallback;
}

function isRunnableAgent(agent: AgentSettingsView): boolean {
  return agent.enabled !== false && (agent.status === "available" || agent.status === "capability_limited");
}

function preferredAgent(agents: AgentSettingsView[]): AgentSettingsView | undefined {
  return agents.find(isRunnableAgent) ?? agents[0];
}

function agentsForProject(agents: AgentSettingsView[], projectId: string): AgentSettingsView[] {
  return agents.map((agent) => ({ ...agent, catalog: agent.projectCatalogs?.[projectId] ?? agent.catalog }));
}

function createNewConversationDraft(
  agent: AgentSettingsView,
  projectId: string,
  defaultPermissionMode: NewConversationDraft["permissionMode"],
): NewConversationDraft {
  const catalog = agent.projectCatalogs?.[projectId] ?? agent.catalog;
  return {
    projectId,
    agentProductId: agent.id,
    agentProductLabel: agent.name,
    modelId: catalog.models[0] ?? null,
    permissionMode: catalog.permissionModes.includes(defaultPermissionMode)
      ? defaultPermissionMode
      : catalog.permissionModes[0] ?? "request_approval",
    availableModels: catalog.models,
    availablePermissionModes: catalog.permissionModes.length
      ? catalog.permissionModes
      : ["request_approval"],
  };
}
