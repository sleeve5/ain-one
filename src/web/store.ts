import type { NormalizedEvent, TurnStatus } from "../shared/contracts.js";
import type { ConversationView, WorkspaceState } from "./api.js";

export type CanvasKind = "conversation" | "trajectory" | "graph";

export interface WorkspaceUiState {
  status: "loading" | "ready" | "error";
  errorMessage: string | null;
  actionError: string | null;
  activeCanvas: CanvasKind;
  leftDrawerOpen: boolean;
  workspace: WorkspaceState;
}

export function createInitialWorkspaceUiState(): WorkspaceUiState {
  return {
    status: "loading",
    errorMessage: null,
    actionError: null,
    activeCanvas: "conversation",
    leftDrawerOpen: false,
    workspace: {
      projects: [],
      selectedProjectId: null,
      conversations: [],
      selectedConversationId: null,
      conversation: null,
      agents: [],
      installedPlugins: [],
      pluginCandidates: [],
      pluginError: null,
    },
  };
}

export function applyConversationEvent(
  conversation: ConversationView,
  event: NormalizedEvent,
): ConversationView {
  const rawEvents = appendRawEvent(conversation.rawEvents ?? conversation.events, event);
  const nextEvents = appendConversationEvent(conversation.events, event);
  if (nextEvents === conversation.events && rawEvents === (conversation.rawEvents ?? conversation.events)) {
    return conversation;
  }
  if (event.type === "queue_status") {
    return { ...conversation, events: nextEvents, rawEvents };
  }

  if (event.type !== "turn_status") {
    return {
      ...conversation,
      events: nextEvents,
      rawEvents,
    };
  }

  const payloadStatus = readTurnStatus(event.payload);
  if (!payloadStatus) {
    return {
      ...conversation,
      events: nextEvents,
      rawEvents,
    };
  }

  if (payloadStatus === "starting" || payloadStatus === "running" || payloadStatus === "cancelling") {
    return {
      ...conversation,
      events: nextEvents,
      rawEvents,
      activeTurnStatus: payloadStatus,
      latestTurnStatus: payloadStatus,
    };
  }

  return {
    ...conversation,
    events: nextEvents,
    rawEvents,
    activeTurnStatus: null,
    latestTurnId: readTurnId(event.payload) ?? conversation.latestTurnId,
    latestTurnStatus: payloadStatus,
    queuePaused:
      payloadStatus === "completed" || payloadStatus === "cancelled"
        ? false
        : true,
  };
}

function appendRawEvent(events: NormalizedEvent[], event: NormalizedEvent): NormalizedEvent[] {
  return events.some((existing) => existing.id === event.id || existing.sequence === event.sequence)
    ? events
    : [...events, event];
}

export function coalesceConversationEvents(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  return events.reduce<NormalizedEvent[]>((result, event) => {
    const next = appendConversationEvent(result, event);
    return next === result ? result : next;
  }, []);
}

function appendConversationEvent(
  events: NormalizedEvent[],
  event: NormalizedEvent,
): NormalizedEvent[] {
  if (events.some((existing) => existing.id === event.id || existing.sequence === event.sequence)) {
    return events;
  }
  const streamId = event.type === "assistant_message" && typeof event.payload.streamId === "string"
    ? event.payload.streamId
    : null;
  if (streamId) {
    const lastUserIndex = events.findLastIndex((existing) => existing.type === "user_message");
    const index = events.findLastIndex((existing, eventIndex) =>
      eventIndex > lastUserIndex &&
      existing.type === "assistant_message" &&
      existing.payload.streamId === streamId
    );
    if (index >= 0) {
      const previous = events[index]!;
      const text = event.payload.delta === true
        ? `${typeof previous.payload.text === "string" ? previous.payload.text : ""}${typeof event.payload.text === "string" ? event.payload.text : ""}`
        : event.payload.text;
      const payload: Record<string, unknown> = { ...previous.payload, ...event.payload, text };
      if (event.payload.final === true) delete payload.delta;
      const next = [...events];
      next[index] = { ...event, payload };
      return next;
    }
  }
  return [...events, event];
}

function readTurnId(payload: Record<string, unknown>): string | null {
  return typeof payload.turnId === "string" ? payload.turnId : null;
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
