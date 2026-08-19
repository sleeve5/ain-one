import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../src/web/app.js";
import type {
  AinOneApi,
  ConversationView,
  InspectorState,
  WorkspaceState,
} from "../../src/web/api.js";
import type { NormalizedEventType, PermissionMode } from "../../src/shared/contracts.js";

describe("web app", () => {
  it("queues a message while a Turn is active and disables Turn settings", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi({ activeTurn: true })} />);

    expect(await screen.findByLabelText("Model")).toBeDisabled();
    expect(screen.getByLabelText("Permission mode")).toBeDisabled();
    expect(screen.getByLabelText("Plugins")).toBeDisabled();

    await user.type(screen.getByLabelText("Message"), "next task");
    await user.click(screen.getByRole("button", { name: "Queue message" }));

    expect(await screen.findByText("next task")).toBeVisible();
  });

  it("renders all normalized event types in timeline", async () => {
    render(<App api={fakeApi({ includeAllEventTypes: true })} />);

    expect(await screen.findByText("Assistant says hi")).toBeVisible();
    expect(screen.getByText("User sent hello")).toBeVisible();
    expect(screen.getByText("Thought summary")).toBeVisible();
    expect(screen.getByText("list_files")).toBeVisible();
    expect(screen.getByText("pnpm test")).toBeVisible();
    expect(screen.getByText("src/web/app.tsx")).toBeVisible();
    expect(screen.getByText("Write outside workspace")).toBeVisible();
    expect(screen.getByText("33 tokens")).toBeVisible();
    expect(screen.getByText("Rate limit near cap")).toBeVisible();
    expect(screen.getByText("failed: Spawn failed")).toBeVisible();
  });

  it("deletes a pending message", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi({ initialQueuedMessages: ["delete me"] })} />);

    expect(await screen.findByText("delete me")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.queryByText("delete me")).toBeNull();
  });

  it("shows immutable agent identity and permission popover with catalog-limited choices", async () => {
    const user = userEvent.setup();
    render(
      <App
        api={fakeApi({
          permissionModes: ["request_approval", "full_access"],
        })}
      />,
    );

    expect(await screen.findByText("Agent product: Codex")).toBeVisible();
    expect(screen.queryByLabelText("Agent product")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Permission mode" }));
    expect(screen.getByRole("menuitemradio", { name: "Request approval" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "Full access" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio", { name: "Help me approve" })).toBeNull();
  });

  it("renders read-only inspector preview, git status, and diff", async () => {
    render(<App api={fakeApi()} />);

    expect(await screen.findByLabelText("Read-only file preview")).toBeVisible();
    expect(screen.getByLabelText("Git status")).toBeVisible();
    const gitDiff = screen.getByLabelText("Git diff");
    expect(gitDiff).toBeVisible();
    expect(screen.getByText("Branch: feature/ain-one-phase1")).toBeVisible();
    expect(gitDiff).toHaveTextContent(/@@ -1 \+1 @@/);
  });
});

function fakeApi(
  input: {
    activeTurn?: boolean;
    includeAllEventTypes?: boolean;
    initialQueuedMessages?: string[];
    permissionModes?: PermissionMode[];
  } = {},
): AinOneApi {
  const state = createWorkspaceState({
    activeTurn: input.activeTurn ?? false,
    includeAllEventTypes: input.includeAllEventTypes ?? false,
    initialQueuedMessages: input.initialQueuedMessages ?? [],
    permissionModes: input.permissionModes,
  });
  if (!state.conversation) {
    throw new Error("expected conversation fixture");
  }
  const queued = [...state.conversation.queuedMessages];
  const conversation = state.conversation;

  return {
    async loadWorkspace() {
      return {
        ...state,
        conversation: {
          ...conversation,
          queuedMessages: [...queued],
        },
        conversations: [{ ...conversation, queuedMessages: [...queued] }],
      };
    },
    async queueMessage(_, content) {
      queued.push({
        id: `msg-${queued.length + 1}`,
        content,
        createdAt: new Date().toISOString(),
      });
    },
    async deletePendingMessage(_, messageId) {
      const index = queued.findIndex((message) => message.id === messageId);
      if (index >= 0) {
        queued.splice(index, 1);
      }
    },
    subscribeConversationEvents() {
      return () => undefined;
    },
    async updateConversationDraftSettings() {
      return undefined;
    },
    async listProjectFiles() {
      return state.inspector;
    },
  };
}

function createWorkspaceState(input: {
  activeTurn: boolean;
  includeAllEventTypes: boolean;
  initialQueuedMessages: string[];
  permissionModes?: PermissionMode[];
}): WorkspaceState {
  const conversation: ConversationView = {
    id: "conv-1",
    projectId: "project-1",
    title: "Main Conversation",
    agentProductId: "codex",
    agentProductLabel: "Codex",
    modelId: "gpt-5",
    permissionMode: "request_approval",
    availableModels: ["gpt-5", "gpt-5-mini"],
    availablePermissionModes:
      input.permissionModes ?? ["request_approval", "help_me_approve", "full_access"],
    enabledPluginIds: ["formatter"],
    availablePlugins: [
      {
        id: "formatter",
        name: "Formatter",
      },
    ],
    activeTurnStatus: input.activeTurn ? "running" : null,
    latestTurnStatus: input.activeTurn ? "running" : "completed",
    queuePaused: false,
    queuedMessages: input.initialQueuedMessages.map((content, index) => ({
      id: `pending-${index}`,
      content,
      createdAt: new Date().toISOString(),
    })),
    events: input.includeAllEventTypes ? allEventTypes() : [],
  };

  const inspector: InspectorState = {
    selectedPath: "src/index.ts",
    files: [
      { path: "src", type: "directory" },
      { path: "src/index.ts", type: "file" },
    ],
    preview: {
      path: "src/index.ts",
      language: "ts",
      content: "console.log('hello');",
    },
    gitStatus: {
      branch: "feature/ain-one-phase1",
      entries: [{ path: "src/index.ts", status: "M" }],
    },
    gitDiff: {
      path: "src/index.ts",
      content: "@@ -1 +1 @@\n-console.log('old')\n+console.log('hello')",
    },
  };

  return {
    projects: [{ id: "project-1", name: "Ain One", path: "/tmp/ain-one" }],
    selectedProjectId: "project-1",
    conversations: [conversation],
    selectedConversationId: conversation.id,
    conversation,
    inspector,
  };
}

function allEventTypes(): ConversationView["events"] {
  const items: Array<{ type: NormalizedEventType; payload: Record<string, unknown> }> = [
    { type: "assistant_message", payload: { text: "Assistant says hi" } },
    { type: "user_message", payload: { text: "User sent hello" } },
    { type: "reasoning", payload: { summary: "Thought summary" } },
    { type: "tool", payload: { name: "list_files" } },
    { type: "shell", payload: { command: "pnpm test" } },
    { type: "file", payload: { path: "src/web/app.tsx" } },
    { type: "permission", payload: { request: "Write outside workspace" } },
    { type: "usage", payload: { summary: "33 tokens" } },
    { type: "warning", payload: { message: "Rate limit near cap" } },
    {
      type: "turn_status",
      payload: {
        status: "failed",
        error: {
          message: "Spawn failed",
        },
      },
    },
  ];

  return items.map((item, index) => ({
    id: `event-${index}`,
    conversationId: "conv-1",
    sequence: index + 1,
    type: item.type,
    payload: item.payload,
    createdAt: new Date().toISOString(),
  }));
}
