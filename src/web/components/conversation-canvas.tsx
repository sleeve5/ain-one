import { useState } from "react";
import type { NormalizedEvent, PermissionMode } from "../../shared/contracts.js";
import type { ConversationView } from "../api.js";
import { Composer } from "./composer.js";

interface ConversationCanvasProps {
  conversation: ConversationView;
  onChangeModel(modelId: string | null): void;
  onChangePermissionMode(permissionMode: PermissionMode): void;
  onTogglePlugin(pluginId: string): void;
  onDeletePendingMessage(messageId: string): Promise<void>;
  onQueueMessage(content: string): Promise<void>;
}

export function ConversationCanvas(props: ConversationCanvasProps) {
  const [permissionOpen, setPermissionOpen] = useState(false);
  const turnActive = Boolean(props.conversation.activeTurnStatus);

  return (
    <section
      className="conversation-canvas"
      data-testid="conversation-canvas"
      aria-label="Conversation Canvas"
    >
      <header className="conversation-canvas__header">
        <h2>{props.conversation.title}</h2>
        <p className="conversation-canvas__agent">Agent product: {props.conversation.agentProductLabel}</p>
      </header>

      <div className="conversation-canvas__controls">
        <label>
          Model
          <select
            aria-label="Model"
            value={props.conversation.modelId ?? ""}
            disabled={turnActive}
            onChange={(event) => {
              const next = event.currentTarget.value;
              props.onChangeModel(next.length === 0 ? null : next);
            }}
          >
            {!props.conversation.modelId ? <option value="">Default</option> : null}
            {props.conversation.availableModels.map((modelId) => (
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
            disabled={turnActive}
            onClick={() => setPermissionOpen((value) => !value)}
          >
            {permissionLabel(props.conversation.permissionMode)}
          </button>
          {permissionOpen ? (
            <div role="menu" className="permission-selector__popover">
              {props.conversation.availablePermissionModes.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={props.conversation.permissionMode === mode}
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
            value={props.conversation.enabledPluginIds}
            disabled={turnActive}
            onChange={(event) => {
              const selected = new Set(
                Array.from(event.currentTarget.selectedOptions, (option) => option.value),
              );
              for (const plugin of props.conversation.availablePlugins) {
                const enabled = props.conversation.enabledPluginIds.includes(plugin.id);
                if (enabled !== selected.has(plugin.id)) {
                  props.onTogglePlugin(plugin.id);
                }
              }
            }}
          >
            {props.conversation.availablePlugins.map((plugin) => (
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
          {props.conversation.events.map((event) => (
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
          {props.conversation.queuedMessages.map((message) => (
            <li key={message.id}>
              <span>{message.content}</span>
              <button
                type="button"
                onClick={() => {
                  void props.onDeletePendingMessage(message.id);
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>

      <Composer queueMode={turnActive} onSubmit={props.onQueueMessage} />
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
