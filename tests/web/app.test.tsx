import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

  it("cancels an active Turn from the Stop button", async () => {
    const user = userEvent.setup();
    const cancelActiveTurn = vi.fn(async () => undefined);
    render(<App api={fakeApi({ activeTurn: true, cancelActiveTurn })} />);

    await user.click(await screen.findByRole("button", { name: "Stop" }));

    expect(cancelActiveTurn).toHaveBeenCalledWith("conv-1");
  });

  it("preserves the draft and surfaces queue failures inline", async () => {
    const user = userEvent.setup();
    render(
      <App
        api={fakeApi({
          queueError: new Error("queue unavailable"),
        })}
      />,
    );

    const message = await screen.findByLabelText("Message");
    await user.type(message, "keep this draft");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not queue message");
    expect(message).toHaveValue("keep this draft");
  });

  it("surfaces inspector failures and preserves the selected project", async () => {
    const user = userEvent.setup();
    render(
      <App
        api={fakeApi({
          twoProjects: true,
          inspectorError: new Error("inspector unavailable"),
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Project Two" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load inspector");
    expect(screen.getByRole("button", { name: "Project Two" })).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("refreshes inspector across projects and ignores stale responses", async () => {
    const user = userEvent.setup();
    const projectTwoInspector = deferred<InspectorState>();
    const api = fakeApi({
      twoProjects: true,
      inspectorByProject: {
        "project-1": createInspector("one.ts", "."),
        "project-2": projectTwoInspector.promise,
      },
    });
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Conversation Two" }));
    await user.click(screen.getByRole("button", { name: "Main Conversation" }));
    projectTwoInspector.resolve(createInspector("two.ts", "."));

    expect(await screen.findByRole("button", { name: "one.ts" })).toBeVisible();
    expect(screen.queryByText("two.ts")).toBeNull();
  });

  it("navigates into directories and back to the parent", async () => {
    const user = userEvent.setup();
    const calls: Array<{ projectId: string; selection?: { path: string; type: string } | null }> = [];
    const rootInspector = createInspector("src", ".", "directory");
    const srcInspector = createInspector("src/web", "src", "directory");
    const api = fakeApi({
      initialInspector: rootInspector,
      listProjectFiles: async (projectId, selection) => {
        calls.push({ projectId, selection });
        return selection?.path === "src" ? srcInspector : rootInspector;
      },
    });
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "src" }));
    expect(await screen.findByText("Directory: src")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Up" }));

    expect(calls).toEqual([
      { projectId: "project-1", selection: { path: "src", type: "directory" } },
      { projectId: "project-1", selection: { path: ".", type: "directory" } },
    ]);
  });

  it("makes closed mobile drawers inert and aria-hidden", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(<App api={fakeApi()} />);

    const projectDrawer = (await screen.findByLabelText("Projects and conversations")).closest(
      ".workspace__left",
    );
    const inspectorDrawer = screen.getByLabelText("Project inspector").closest(
      ".workspace__right",
    );
    expect(projectDrawer).toHaveAttribute("inert");
    expect(projectDrawer).toHaveAttribute("aria-hidden", "true");
    expect(inspectorDrawer).toHaveAttribute("inert");
    expect(inspectorDrawer).toHaveAttribute("aria-hidden", "true");
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
    cancelActiveTurn?: (conversationId: string) => Promise<void>;
    queueError?: Error;
    inspectorError?: Error;
    twoProjects?: boolean;
    initialInspector?: InspectorState;
    inspectorByProject?: Record<string, InspectorState | Promise<InspectorState>>;
    listProjectFiles?: AinOneApi["listProjectFiles"];
  } = {},
): AinOneApi {
  const state = createWorkspaceState({
    activeTurn: input.activeTurn ?? false,
    includeAllEventTypes: input.includeAllEventTypes ?? false,
    initialQueuedMessages: input.initialQueuedMessages ?? [],
    permissionModes: input.permissionModes,
    twoProjects: input.twoProjects ?? false,
    initialInspector: input.initialInspector,
  });
  if (!state.conversation) {
    throw new Error("expected conversation fixture");
  }
  const queued = [...state.conversation.queuedMessages];
  const conversation = state.conversation;
  const conversations = state.conversations;

  return {
    async loadWorkspace() {
      return {
        ...state,
        conversation: {
          ...conversation,
          queuedMessages: [...queued],
        },
        conversations: conversations.map((item) =>
          item.id === conversation.id ? { ...conversation, queuedMessages: [...queued] } : item,
        ),
      };
    },
    async queueMessage(_, content) {
      if (input.queueError) {
        throw input.queueError;
      }
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
    async cancelActiveTurn(conversationId) {
      await input.cancelActiveTurn?.(conversationId);
    },
    async updateConversationDraftSettings() {
      return undefined;
    },
    async listProjectFiles(projectId, selection) {
      if (input.listProjectFiles) {
        return input.listProjectFiles(projectId, selection);
      }
      if (input.inspectorError) {
        throw input.inspectorError;
      }
      return await input.inspectorByProject?.[projectId] ?? state.inspector;
    },
  };
}

function createWorkspaceState(input: {
  activeTurn: boolean;
  includeAllEventTypes: boolean;
  initialQueuedMessages: string[];
  permissionModes?: PermissionMode[];
  twoProjects: boolean;
  initialInspector?: InspectorState;
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

  const inspector = input.initialInspector ?? createInspector("src/index.ts", ".");

  const conversations = input.twoProjects
    ? [
        conversation,
        {
          ...conversation,
          id: "conv-2",
          projectId: "project-2",
          title: "Conversation Two",
        },
      ]
    : [conversation];

  return {
    projects: input.twoProjects
      ? [
          { id: "project-1", name: "Project One", path: "/tmp/one" },
          { id: "project-2", name: "Project Two", path: "/tmp/two" },
        ]
      : [{ id: "project-1", name: "Ain One", path: "/tmp/ain-one" }],
    selectedProjectId: "project-1",
    conversations,
    selectedConversationId: conversation.id,
    conversation,
    inspector,
  };
}

function createInspector(
  path: string,
  currentPath: string,
  type: "file" | "directory" = "file",
): InspectorState {
  return {
    currentPath,
    selectedPath: type === "file" ? path : null,
    files: [{ path, type }],
    preview: {
      path: type === "file" ? path : null,
      language: "ts",
      content: "console.log('hello');",
    },
    gitStatus: {
      branch: "feature/ain-one-phase1",
      entries: [{ path: "src/index.ts", status: "M" }],
    },
    gitDiff: {
      path: type === "file" ? path : null,
      content: "@@ -1 +1 @@\n-console.log('old')\n+console.log('hello')",
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
