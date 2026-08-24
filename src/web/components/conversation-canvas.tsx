import { useState } from "react";
import type { NormalizedEvent, PermissionMode } from "../../shared/contracts.js";
import type { ConversationView } from "../api.js";
import { Composer } from "./composer.js";

interface ConversationCanvasProps {
  conversation: ConversationView | null;
  onChangeModel(modelId: string | null): void;
  onChangePermissionMode(permissionMode: PermissionMode): void;
  onChangePlugins(pluginIds: string[]): void;
  onDeletePendingMessage(messageId: string): Promise<void>;
  onQueueMessage(content: string): Promise<void>;
  onCancelTurn(): Promise<void>;
  onContinueConversation(): Promise<void>;
  onRetryInterruptedTurn(turnId: string): Promise<void>;
}

export function ConversationCanvas(props: ConversationCanvasProps) {
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const conversation = props.conversation;
  if (!conversation) {
    return (
      <section
        className="conversation-canvas"
        data-testid="conversation-canvas"
        aria-label="Conversation Canvas"
      >
        <div className="workspace-empty">Create a conversation to start.</div>
      </section>
    );
  }

  const turnActive = Boolean(conversation.activeTurnStatus);
  const recoveryStatus = conversation.latestTurnStatus;
  const recoveryRequired =
    conversation.queuePaused &&
    recoveryStatus !== null &&
    ["start_failed", "failed", "interrupted", "cancel_failed"].includes(recoveryStatus);
  const uncertainNativeWork =
    recoveryStatus === "interrupted" || recoveryStatus === "cancel_failed";

  return (
    <section
      className="conversation-canvas"
      data-testid="conversation-canvas"
      aria-label="Conversation Canvas"
    >
      <header className="conversation-canvas__header">
        <div>
          <h2>{conversation.title}</h2>
          <p className="conversation-canvas__agent">Agent product: {conversation.agentProductLabel}</p>
        </div>
        {turnActive ? (
          <button type="button" className="conversation-canvas__stop" onClick={props.onCancelTurn}>
            Stop
          </button>
        ) : null}
      </header>

      {recoveryRequired && conversation.latestTurnId ? (
        <section className="conversation-canvas__recovery" aria-label="Paused Turn recovery">
          <p>
            The last Turn ended with {recoveryStatus}. Ain One will not continue automatically.
            {uncertainNativeWork ? " Before Continue or Retry, confirm native work is inactive." : ""}
          </p>
          <div>
            <button type="button" onClick={props.onContinueConversation}>
              Continue pending queue
            </button>
            {recoveryStatus === "interrupted" ? (
              <button
                type="button"
                onClick={() => props.onRetryInterruptedTurn(conversation.latestTurnId!)}
              >
                Retry interrupted Turn
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="conversation-canvas__controls">
        <label>
          Model
          <select
            aria-label="Model"
            value={conversation.modelId ?? ""}
            disabled={turnActive}
            onChange={(event) => {
              const next = event.currentTarget.value;
              props.onChangeModel(next.length === 0 ? null : next);
            }}
          >
            {!conversation.modelId ? <option value="">Default</option> : null}
            {conversation.availableModels.map((modelId) => (
              <option key={modelId} value={modelId}>
                {modelId}
              </option>
            ))}
          </select>
        </label>

        <div className="permission-selector">
          <button
            type="button"
            aria-label="Permission mode"
            aria-haspopup="menu"
            aria-expanded={permissionOpen && !turnActive}
            disabled={turnActive}
            onClick={() => setPermissionOpen((value) => !value)}
          >
            {permissionLabel(conversation.permissionMode)}
          </button>
          {permissionOpen && !turnActive ? (
            <div role="menu" className="permission-selector__popover">
              {conversation.availablePermissionModes.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={conversation.permissionMode === mode}
                  onClick={() => {
                    props.onChangePermissionMode(mode);
                    setPermissionOpen(false);
                  }}
                >
                  {permissionLabel(mode)}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <label>
          Plugins
          <select
            aria-label="Plugins"
            multiple
            value={conversation.enabledPluginIds}
            disabled={turnActive}
            onChange={(event) => {
              props.onChangePlugins(
                Array.from(event.currentTarget.selectedOptions, (option) => option.value),
              );
            }}
          >
            {conversation.availablePlugins.map((plugin) => (
              <option key={plugin.id} value={plugin.id}>
                {plugin.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <section className="conversation-canvas__timeline" aria-label="Activity timeline">
        <h3>Timeline</h3>
        <ul>
          {conversation.events.map((event) => (
            <li key={event.id} className="conversation-canvas__event">
              <code>{event.type}</code>
              <span>{describeEvent(event)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="conversation-canvas__pending" aria-label="Pending messages">
        <h3>Pending queue</h3>
        <ul>
          {conversation.queuedMessages.map((message) => (
            <li key={message.id}>
              <span>{message.content}</span>
              <button
                type="button"
                onClick={() => {
                  void props.onDeletePendingMessage(message.id).catch(() => undefined);
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Composer
        queueMode={turnActive}
        value={drafts[conversation.id] ?? ""}
        onChange={(value) => {
          setDrafts((current) => ({ ...current, [conversation.id]: value }));
        }}
        onSubmit={async (content) => {
          const conversationId = conversation.id;
          const submittedDraft = drafts[conversationId] ?? "";
          await props.onQueueMessage(content);
          setDrafts((current) =>
            current[conversationId] === submittedDraft
              ? { ...current, [conversationId]: "" }
              : current,
          );
        }}
      />
    </section>
  );
}

function permissionLabel(mode: PermissionMode): string {
  switch (mode) {
    case "request_approval":
      return "Request approval";
    case "help_me_approve":
      return "Help me approve";
    case "full_access":
      return "Full access";
    default:
      return mode;
  }
}

function describeEvent(event: NormalizedEvent): string {
  switch (event.type) {
    case "assistant_message":
      return readString(event.payload, "text") ?? "Assistant message";
    case "user_message":
      return readString(event.payload, "text") ?? "User message";
    case "reasoning":
      return readString(event.payload, "summary") ?? "Reasoning update";
    case "tool":
      return readString(event.payload, "name") ?? "Tool event";
    case "shell":
      return readString(event.payload, "command") ?? "Shell event";
    case "file":
      return readString(event.payload, "path") ?? "File event";
    case "permission":
      return readString(event.payload, "request") ?? "Permission request";
    case "usage":
      return readString(event.payload, "summary") ?? "Usage update";
    case "warning":
      return readString(event.payload, "message") ?? "Warning";
    case "turn_status": {
      const status = readString(event.payload, "status") ?? "unknown";
      const error = readErrorMessage(event.payload);
      return error ? `${status}: ${error}` : status;
    }
    default:
      return "Unknown event";
  }
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readErrorMessage(payload: Record<string, unknown>): string | null {
  const error = payload.error;
  if (!error || typeof error !== "object") {
    return null;
  }
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? message : null;
}
