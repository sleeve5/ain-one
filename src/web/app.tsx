import { startTransition, useEffect, useState } from "react";
import type { AinOneApi, ConversationView } from "./api.js";
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

  const selectedConversation = state.workspace.conversation;
  const selectedProjectId = state.workspace.selectedProjectId;

  useEffect(() => {
    if (!selectedConversation) {
      return;
    }

    return props.api.subscribeConversationEvents(selectedConversation.id, (event) => {
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

  const selectConversation = (conversationId: string): void => {
    setState((current) => {
      const conversation = current.workspace.conversations.find((item) => item.id === conversationId) ?? null;
      if (!conversation) {
        return current;
      }

      return {
        ...current,
        workspace: {
          ...current.workspace,
          selectedProjectId: conversation.projectId,
          selectedConversationId: conversationId,
          conversation,
        },
      };
    });
  };

  const selectProject = async (projectId: string): Promise<void> => {
    const conversation =
      state.workspace.conversations.find((item) => item.projectId === projectId) ?? null;

    setState((current) => ({
      ...current,
      workspace: {
        ...current.workspace,
        selectedProjectId: projectId,
        selectedConversationId: conversation?.id ?? null,
        conversation,
      },
    }));

    const inspector = await props.api.listProjectFiles(projectId);
    setState((current) => ({
      ...current,
      workspace: {
        ...current.workspace,
        inspector,
      },
    }));
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

  const persistConversationSettings = async (conversation: ConversationView): Promise<void> => {
    await props.api.updateConversationDraftSettings(conversation.id, {
      modelId: conversation.modelId,
      permissionMode: conversation.permissionMode,
      enabledPluginIds: conversation.enabledPluginIds,
    });
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
      void persistConversationSettings(next);
      return next;
    });
  };

  const selectInspectorPath = async (path: string): Promise<void> => {
    if (!selectedProjectId) {
      return;
    }
    const inspector = await props.api.listProjectFiles(selectedProjectId, path);
    setState((current) => ({
      ...current,
      workspace: {
        ...current.workspace,
        inspector,
      },
    }));
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
        <h1>Ain One</h1>
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
        <aside className="workspace__left" data-open={state.leftDrawerOpen}>
          <ProjectSidebar
            projects={state.workspace.projects}
            conversations={state.workspace.conversations}
            selectedProjectId={state.workspace.selectedProjectId}
            selectedConversationId={state.workspace.selectedConversationId}
            onSelectProject={(projectId) => {
              void selectProject(projectId);
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
                    void persistConversationSettings(next);
                    return next;
                  });
                }}
                onChangePermissionMode={(permissionMode) => {
                  patchConversation((current) => {
                    const next = {
                      ...current,
                      permissionMode,
                    };
                    void persistConversationSettings(next);
                    return next;
                  });
                }}
                onTogglePlugin={togglePlugin}
                onDeletePendingMessage={async (messageId) => {
                  if (!conversation) {
                    return;
                  }
                  await props.api.deletePendingMessage(conversation.id, messageId);
                  patchConversation((current) => ({
                    ...current,
                    queuedMessages: current.queuedMessages.filter((message) => message.id !== messageId),
                  }));
                }}
                onQueueMessage={async (content) => {
                  if (!conversation) {
                    return;
                  }
                  await props.api.queueMessage(conversation.id, content);
                  await loadWorkspace();
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

        <aside className="workspace__right" data-open={state.rightDrawerOpen}>
          <Inspector
            state={state.workspace.inspector}
            onSelectPath={(path) => {
              void selectInspectorPath(path);
            }}
          />
        </aside>
      </div>
    </div>
  );
}
