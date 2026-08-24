import { startTransition, useEffect, useRef, useState } from "react";
import type { AgentProductId, PluginVersion } from "../shared/contracts.js";
import type {
  AinOneApi,
  ConversationView,
  InspectorSelection,
  PluginScope,
} from "./api.js";
import { isPhaseOneAgentProductId } from "./api.js";
import { CanvasSwitch } from "./components/canvas-switch.js";
import { ConversationCanvas } from "./components/conversation-canvas.js";
import { GraphCanvas } from "./components/graph-canvas.js";
import { Inspector } from "./components/inspector.js";
import {
  PluginSettings,
  type PluginScope as PluginScopeKind,
} from "./components/plugin-settings.js";
import { ProjectSidebar } from "./components/project-sidebar.js";
import { Settings } from "./components/settings.js";
import {
  applyConversationEvent,
  createInitialWorkspaceUiState,
  type CanvasKind,
  type WorkspaceUiState,
} from "./store.js";

interface AppProps {
  api: AinOneApi;
}

type CenterView = "workspace" | "agents" | "plugins";
type ConfigurationWriteKey = string;
interface WorkspaceSelection {
  projectId?: string;
  conversationId?: string;
}

export function App(props: AppProps) {
  const [state, setState] = useState<WorkspaceUiState>(() => createInitialWorkspaceUiState());
  const [centerView, setCenterView] = useState<CenterView>("workspace");
  const [pluginScope, setPluginScope] = useState<PluginScopeKind>("global");
  const [enabledPluginVersions, setEnabledPluginVersions] = useState<PluginVersion[]>([]);
  const [pluginEnablementsLoading, setPluginEnablementsLoading] = useState(false);
  const workspaceRequest = useRef(0);
  const workspaceGeneration = useRef(0);
  const pendingWorkspaceSelection = useRef<WorkspaceSelection | null>(null);
  const inspectorRequest = useRef(0);
  const pluginRequest = useRef(0);
  const pluginScopeRef = useRef<PluginScopeKind>("global");
  const configurationWriteQueue = useRef<Promise<void> | null>(null);
  const configurationFailures = useRef<Record<ConfigurationWriteKey, string>>({});
  const agentExecutableWrites = useRef(new Map<AgentProductId, Promise<void>>());
  const enabledPluginVersionsRef = useRef<PluginVersion[]>([]);
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
          agents: loadedWorkspace.agents.filter((agent) => isPhaseOneAgentProductId(agent.id)),
          conversations: loadedWorkspace.conversations.filter((conversation) =>
            isPhaseOneAgentProductId(conversation.agentProductId)
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
            inspector:
              selectedProjectId !== workspace.selectedProjectId &&
                selectedProjectId === current.workspace.selectedProjectId
                ? current.workspace.inspector
                : workspace.inspector,
          },
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
  const pluginEnablementsLocked = state.workspace.conversations.some((item) => {
    if (!item.activeTurnStatus) {
      return false;
    }
    if (pluginScope === "global") {
      return true;
    }
    if (pluginScope === "project") {
      return item.projectId === selectedProjectId;
    }
    return item.id === selectedConversation?.id;
  });

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
    if (centerView === "plugins") {
      void loadPluginEnablements(pluginScope);
    }
  }, [centerView, pluginScope, selectedProjectId, selectedConversation?.id]);

  const conversationIds = state.workspace.conversations.map((item) => item.id).join("\0");

  useEffect(() => {
    const unsubscribe = state.workspace.conversations.map((conversation) => {
      const replaySequence = conversation.events.reduce(
        (sequence, event) => Math.max(sequence, event.sequence),
        0,
      );
      return props.api.subscribeConversationEvents(conversation.id, replaySequence, (event) => {
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
        if (isTerminalTurnEvent(event)) {
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

  const loadInspector = async (
    projectId: string,
    selection: InspectorSelection | null = null,
  ): Promise<void> => {
    const request = ++inspectorRequest.current;
    try {
      const inspector = await props.api.listProjectFiles(projectId, selection);
      setState((current) => {
        if (request !== inspectorRequest.current || current.workspace.selectedProjectId !== projectId) {
          return current;
        }
        return {
          ...current,
          actionError: null,
          workspace: { ...current.workspace, inspector },
        };
      });
    } catch {
      if (request === inspectorRequest.current) {
        showActionError("Could not load inspector");
      }
    }
  };

  const selectConversation = (conversationId: string): void => {
    const conversation = state.workspace.conversations.find((item) => item.id === conversationId);
    if (!conversation) {
      return;
    }
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
    }));
    void loadInspector(conversation.projectId);
  };

  const selectProject = (projectId: string): void => {
    const conversation =
      state.workspace.conversations.find((item) => item.projectId === projectId) ?? null;

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
    }));
    void loadInspector(projectId);
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

  const changeConversationPlugins = (enabledPluginIds: string[]): void => {
    if (!selectedConversation) {
      return;
    }
    const pluginVersions = enabledPluginIds.flatMap((id) => {
      const plugin = selectedConversation.availablePlugins.find((item) => item.id === id);
      return plugin ? [{ pluginId: plugin.pluginId, versionId: plugin.versionId }] : [];
    });

    patchConversation((conversation) => ({ ...conversation, enabledPluginIds }));
    void enqueueConfigurationWrite(
      `plugins:conversation:${selectedConversation.id}`,
      () => props.api.setPluginEnablements(
        { type: "conversation", id: selectedConversation.id },
        pluginVersions,
      ),
      "Could not update plugin enablements",
    );
  };

  const selectInspector = (selection: InspectorSelection): void => {
    if (!selectedProjectId) {
      return;
    }
    void loadInspector(selectedProjectId, selection);
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

  if (state.status === "loading") {
    return <div className="workspace-empty">Loading workspace...</div>;
  }

  if (state.status === "error") {
    return <div className="workspace-empty">{state.errorMessage ?? "Workspace failed to load."}</div>;
  }

  const conversation = state.workspace.conversation;

  return (
    <div className="workspace">
      <header className="workspace__header">
        <div>
          <h1>Ain One</h1>
          {state.actionError ? (
            <p className="workspace__action-error" role="alert">
              {state.actionError}
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
            Projects
          </button>
          <button
            type="button"
            className="workspace__drawer-button"
            aria-expanded={state.rightDrawerOpen}
            aria-controls="inspector-drawer"
            onClick={() =>
              setState((current) => ({
                ...current,
                rightDrawerOpen: !current.rightDrawerOpen,
              }))
            }
          >
            Inspector
          </button>
        </div>
      </header>

      <div className="workspace__layout">
        <aside
          id="project-drawer"
          className="workspace__left"
          data-open={state.leftDrawerOpen}
          inert={narrowScreen && !state.leftDrawerOpen}
          aria-hidden={narrowScreen && !state.leftDrawerOpen}
        >
          <ProjectSidebar
            projects={state.workspace.projects}
            conversations={state.workspace.conversations}
            selectedProjectId={state.workspace.selectedProjectId}
            selectedConversationId={state.workspace.selectedConversationId}
            agents={state.workspace.agents}
            onOpenProject={async () => {
              try {
                const project = await props.api.pickProject();
                if (!project) {
                  return;
                }
                if (await loadWorkspace({ projectId: project.id })) {
                  await loadInspector(project.id);
                  clearActionError();
                }
              } catch (error) {
                const message = actionError(error, "Could not open Project");
                showActionError(message);
                throw new Error(message);
              }
            }}
            onCreateConversation={async (input) => {
              try {
                const created = await props.api.createConversation(input);
                if (await loadWorkspace({
                  projectId: created.projectId,
                  conversationId: created.id,
                })) {
                  clearActionError();
                }
              } catch (error) {
                const message = actionError(error, "Could not create Conversation");
                showActionError(message);
                throw new Error(message);
              }
            }}
            onSelectProject={(projectId) => {
              selectProject(projectId);
            }}
            onSelectConversation={selectConversation}
          />
        </aside>

        <main className="workspace__center">
          <div className="workspace__toolbar">
            <div className="workspace__view-switch" aria-label="Workspace views">
              <button
                type="button"
                data-active={centerView === "workspace"}
                aria-pressed={centerView === "workspace"}
                onClick={() => setCenterView("workspace")}
              >
                Workspace
              </button>
              <button
                type="button"
                data-active={centerView === "agents"}
                aria-pressed={centerView === "agents"}
                onClick={() => setCenterView("agents")}
              >
                Agent Settings
              </button>
              <button
                type="button"
                data-active={centerView === "plugins"}
                aria-pressed={centerView === "plugins"}
                onClick={() => setCenterView("plugins")}
              >
                Plugin Settings
              </button>
            </div>
            {centerView === "workspace" ? (
              <CanvasSwitch value={state.activeCanvas} onChange={changeCanvas} />
            ) : null}
          </div>

          <section
            className="workspace__canvas"
            hidden={centerView !== "workspace" || state.activeCanvas !== "conversation"}
            aria-hidden={centerView !== "workspace" || state.activeCanvas !== "conversation"}
            inert={centerView !== "workspace" || state.activeCanvas !== "conversation"}
          >
            <ConversationCanvas
              conversation={conversation}
              onChangeModel={(modelId) => {
                  if (!conversation) {
                    return;
                  }
                  const next = { ...conversation, modelId };
                  patchConversation(() => next);
                  persistConversationSettings(next);
              }}
              onChangePermissionMode={(permissionMode) => {
                  if (!conversation) {
                    return;
                  }
                  const next = { ...conversation, permissionMode };
                  patchConversation(() => next);
                  persistConversationSettings(next);
              }}
              onChangePlugins={changeConversationPlugins}
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
              onQueueMessage={async (content) => {
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
                    await props.api.queueMessage(conversation.id, content);
                    if (await loadWorkspace()) {
                      clearActionError();
                    }
                  } catch {
                    showActionError("Could not queue message");
                    throw new Error("queue failed");
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
              onContinueConversation={async () => {
                  if (!conversation) {
                    return;
                  }
                  try {
                    await props.api.continueConversation(conversation.id);
                    if (await loadWorkspace()) {
                      clearActionError();
                    }
                  } catch {
                    showActionError("Could not continue pending queue");
                  }
              }}
              onRetryInterruptedTurn={async (turnId) => {
                  if (!conversation) {
                    return;
                  }
                  try {
                    await props.api.retryInterruptedTurn(conversation.id, turnId);
                    if (await loadWorkspace()) {
                      clearActionError();
                    }
                  } catch {
                    showActionError("Could not retry interrupted Turn");
                  }
              }}
            />
          </section>

          <section
            className="workspace__canvas"
            hidden={centerView !== "workspace" || state.activeCanvas !== "graph"}
            aria-hidden={centerView !== "workspace" || state.activeCanvas !== "graph"}
            inert={centerView !== "workspace" || state.activeCanvas !== "graph"}
          >
            <GraphCanvas />
          </section>

          {centerView === "agents" ? (
            <div className="workspace__page">
              <Settings
                agents={state.workspace.agents.map((agent) => ({
                  ...agent,
                  catalog: selectedProjectId
                    ? agent.projectCatalogs?.[selectedProjectId] ?? agent.catalog
                    : agent.catalog,
                }))}
                onSaveExecutablePath={(agentProductId, executablePath) => {
                  void updateAgentExecutablePath(agentProductId, executablePath).catch(() => undefined);
                }}
              />
            </div>
          ) : null}

          {centerView === "plugins" ? (
            <div className="workspace__page">
              <PluginSettings
                installedVersions={state.workspace.installedPlugins}
                importCandidates={state.workspace.pluginCandidates}
                error={state.workspace.pluginError}
                scope={pluginScope}
                conversationAgentProductId={selectedConversation?.agentProductId ?? null}
                enabledVersions={enabledPluginVersions}
                enablementsLoading={pluginEnablementsLoading}
                enablementsLocked={pluginEnablementsLocked}
                onAcceptCandidate={(candidateId) => {
                  void reloadAfter(
                    () => props.api.acceptPluginCandidate(candidateId),
                    "Could not accept plugin candidate",
                  ).catch(() => undefined);
                }}
                onInstallLocalPath={(path, type, compatibleAgents) => {
                  void reloadAfter(
                    () => props.api.installPlugin(path, type, compatibleAgents),
                    "Could not install plugin",
                  ).catch(() => undefined);
                }}
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
                    () => loadPluginEnablements(scope),
                  );
                }}
              />
            </div>
          ) : null}
        </main>

        <aside
          id="inspector-drawer"
          className="workspace__right"
          data-open={state.rightDrawerOpen}
          inert={narrowScreen && !state.rightDrawerOpen}
          aria-hidden={narrowScreen && !state.rightDrawerOpen}
        >
          <Inspector
            state={state.workspace.inspector}
            onSelect={selectInspector}
          />
        </aside>
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

function pluginWriteKey(scope: PluginScope): string {
  return scope.type === "global" ? "plugins:global" : `plugins:${scope.type}:${scope.id}`;
}

function actionError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? `${fallback}: ${error.message}` : fallback;
}
