import type { NormalizedEvent, TurnStatus } from "../shared/contracts.js";
import type { ConversationView, InspectorState, WorkspaceState } from "./api.js";

export type CanvasKind = "conversation" | "graph";

export interface WorkspaceUiState {
  status: "loading" | "ready" | "error";
  errorMessage: string | null;
  actionError: string | null;
  activeCanvas: CanvasKind;
  leftDrawerOpen: boolean;
  rightDrawerOpen: boolean;
  workspace: WorkspaceState;
}

export function createInitialWorkspaceUiState(): WorkspaceUiState {
  return {
    status: "loading",
    errorMessage: null,
    actionError: null,
    activeCanvas: "conversation",
    leftDrawerOpen: false,
    rightDrawerOpen: false,
    workspace: {
      projects: [],
      selectedProjectId: null,
      conversations: [],
      selectedConversationId: null,
      conversation: null,
      inspector: emptyInspector(),
    },
  };
}

export function emptyInspector(): InspectorState {
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

export function applyConversationEvent(
  conversation: ConversationView,
  event: NormalizedEvent,
): ConversationView {
  if (
    conversation.events.some(
      (existing) => existing.id === event.id || existing.sequence === event.sequence,
    )
  ) {
    return conversation;
  }

  const nextEvents = [...conversation.events, event];

  if (event.type !== "turn_status") {
    return {
      ...conversation,
      events: nextEvents,
    };
  }

  const payloadStatus = readTurnStatus(event.payload);
  if (!payloadStatus) {
    return {
      ...conversation,
      events: nextEvents,
    };
  }

  if (payloadStatus === "starting" || payloadStatus === "running" || payloadStatus === "cancelling") {
    return {
      ...conversation,
      events: nextEvents,
      activeTurnStatus: payloadStatus,
      latestTurnStatus: payloadStatus,
    };
  }

  return {
    ...conversation,
    events: nextEvents,
    activeTurnStatus: null,
    latestTurnStatus: payloadStatus,
  };
}

function readTurnStatus(payload: Record<string, unknown>): TurnStatus | null {
  const status = payload.status;
  if (typeof status !== "string") {
    return null;
  }

  switch (status) {
    case "starting":
    case "running":
    case "cancelling":
    case "completed":
    case "cancelled":
    case "start_failed":
    case "failed":
    case "interrupted":
    case "cancel_failed":
      return status;
    default:
      return null;
  }
}
