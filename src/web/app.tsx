import { startTransition, useEffect, useRef, useState } from "react";
import type { AinOneApi, ConversationView, InspectorSelection } from "./api.js";
import { CanvasSwitch } from "./components/canvas-switch.js";
import { ConversationCanvas } from "./components/conversation-canvas.js";
import { GraphCanvas } from "./components/graph-canvas.js";
import { Inspector } from "./components/inspector.js";
import { ProjectSidebar } from "./components/project-sidebar.js";
import {
  applyConversationEvent,
  createInitialWorkspaceUiState,
  type CanvasKind,
  type WorkspaceUiState,
} from "./store.js";

interface AppProps {
  api: AinOneApi;
}

export function App(props: AppProps) {
  const [state, setState] = useState<WorkspaceUiState>(() => createInitialWorkspaceUiState());
  const inspectorRequest = useRef(0);
  const [narrowScreen, setNarrowScreen] = useState(
    () => globalThis.matchMedia?.("(max-width: 960px)").matches ?? false,
  );

  const loadWorkspace = async (): Promise<void> => {
    try {
      const workspace = await props.api.loadWorkspace();
      setState((current) => ({
        ...current,
        status: "ready",
        errorMessage: null,
        workspace,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((current) => ({
        ...current,
        status: "error",
        errorMessage: message,
      }));
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

  useEffect(() => {
    if (!selectedConversation) {
      return;
    }

    const replaySequence = selectedConversation.events.reduce(
      (sequence, event) => Math.max(sequence, event.sequence),
      0,
    );
    return props.api.subscribeConversationEvents(selectedConversation.id, replaySequence, (event) => {
      startTransition(() => {
        setState((current) => {
          if (current.workspace.selectedConversationId !== selectedConversation.id) {
            return current;
          }
          const conversation = current.workspace.conversation;
          if (!conversation) {
            return current;
          }

          const nextConversation = applyConversationEvent(conversation, event);
          const nextConversations = current.workspace.conversations.map((item) =>
            item.id === nextConversation.id ? nextConversation : item,
          );

          return {
            ...current,
            workspace: {
              ...current.workspace,
              conversation: nextConversation,
              conversations: nextConversations,
            },
          };
        });
      });
    });
  }, [props.api, selectedConversation?.id]);

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

  const patchConversation = (patch: (current: ConversationView) => ConversationView): void => {
    setState((current) => {
      const selected = current.workspace.conversation;
      if (!selected) {
        return current;
      }

      const nextConversation = patch(selected);
      return {
        ...current,
        workspace: {
          ...current.workspace,
          conversation: nextConversation,
          conversations: current.workspace.conversations.map((item) =>
            item.id === nextConversation.id ? nextConversation : item,
          ),
        },
      };
    });
  };

  const persistConversationSettings = (conversation: ConversationView): void => {
    void props.api
      .updateConversationDraftSettings(conversation.id, {
        modelId: conversation.modelId,
        permissionMode: conversation.permissionMode,
        enabledPluginIds: conversation.enabledPluginIds,
      })
      .then(clearActionError, () => showActionError("Could not update conversation settings"));
  };

  const togglePlugin = (pluginId: string): void => {
    patchConversation((conversation) => {
      const enabled = conversation.enabledPluginIds.includes(pluginId)
        ? conversation.enabledPluginIds.filter((id) => id !== pluginId)
        : [...conversation.enabledPluginIds, pluginId];
      const next = {
        ...conversation,
        enabledPluginIds: enabled,
      };
      persistConversationSettings(next);
      return next;
    });
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
            onSelectProject={(projectId) => {
              selectProject(projectId);
            }}
            onSelectConversation={selectConversation}
          />
        </aside>

        <main className="workspace__center">
          <div className="workspace__toolbar">
            <CanvasSwitch value={state.activeCanvas} onChange={changeCanvas} />
          </div>

          <section
            className="workspace__canvas"
            hidden={state.activeCanvas !== "conversation"}
            aria-hidden={state.activeCanvas !== "conversation"}
            inert={state.activeCanvas !== "conversation"}
          >
            {conversation ? (
              <ConversationCanvas
                conversation={conversation}
                onChangeModel={(modelId) => {
                  patchConversation((current) => {
                    const next = {
                      ...current,
                      modelId,
                    };
                    persistConversationSettings(next);
                    return next;
                  });
                }}
                onChangePermissionMode={(permissionMode) => {
                  patchConversation((current) => {
                    const next = {
                      ...current,
                      permissionMode,
                    };
                    persistConversationSettings(next);
                    return next;
                  });
                }}
                onTogglePlugin={togglePlugin}
                onDeletePendingMessage={async (messageId) => {
                  if (!conversation) {
                    return;
                  }
                  try {
                    await props.api.deletePendingMessage(conversation.id, messageId);
                    clearActionError();
                    patchConversation((current) => ({
                      ...current,
                      queuedMessages: current.queuedMessages.filter((message) => message.id !== messageId),
                    }));
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
                    await props.api.queueMessage(conversation.id, content);
                    await loadWorkspace();
                    clearActionError();
                  } catch {
                    showActionError("Could not queue message");
                    throw new Error("queue failed");
                  }
                }}
                onCancelTurn={async () => {
                  try {
                    await props.api.cancelActiveTurn(conversation.id);
                    clearActionError();
                  } catch {
                    showActionError("Could not stop active Turn");
                  }
                }}
              />
            ) : (
              <div className="workspace-empty">Create a conversation to start.</div>
            )}
          </section>

          <section
            className="workspace__canvas"
            hidden={state.activeCanvas !== "graph"}
            aria-hidden={state.activeCanvas !== "graph"}
            inert={state.activeCanvas !== "graph"}
          >
            <GraphCanvas />
          </section>
        </main>

        <aside
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
