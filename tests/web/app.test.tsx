import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/web/app.js";
import type {
  AinOneApi,
  ConversationView,
  InspectorState,
  WorkspaceState,
} from "../../src/web/api.js";
import type {
  Conversation,
  NormalizedEventType,
  PermissionMode,
  Project,
} from "../../src/shared/contracts.js";

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

  it("continues pending work or retries the interrupted Turn explicitly", async () => {
    const user = userEvent.setup();
    const continueConversation = vi.fn(async () => undefined);
    const retryInterruptedTurn = vi.fn(async () => undefined);
    render(
      <App
        api={fakeApi({
          recoveryTurn: {
            latestTurnId: "turn-interrupted",
            latestTurnStatus: "interrupted",
          },
          initialQueuedMessages: ["next task"],
          continueConversation,
          retryInterruptedTurn,
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Continue pending queue" }));
    expect(continueConversation).toHaveBeenCalledWith("conv-1");

    await user.click(screen.getByRole("button", { name: "Retry interrupted Turn" }));
    expect(retryInterruptedTurn).toHaveBeenCalledWith("conv-1", "turn-interrupted");
    expect(screen.getByText(/confirm native work is inactive/i)).toBeVisible();
  });

  it.each(["start_failed", "failed", "cancel_failed"] as const)(
    "offers Continue but not Retry after %s",
    async (status) => {
      render(
        <App
          api={fakeApi({
            recoveryTurn: {
              latestTurnId: `turn-${status}`,
              latestTurnStatus: status,
            },
            initialQueuedMessages: ["next task"],
          })}
        />,
      );

      expect(await screen.findByRole("button", { name: "Continue pending queue" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Retry interrupted Turn" })).toBeNull();
      if (status === "cancel_failed") {
        expect(screen.getByText(/confirm native work is inactive/i)).toBeVisible();
      }
    },
  );

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

  it("keeps SSE events that arrive before the post-queue workspace refresh", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    let onEvent: (event: ConversationView["events"][number]) => void = () => undefined;
    api.subscribeConversationEvents = (_conversationId, _afterSequence, callback) => {
      onEvent = callback;
      return () => undefined;
    };
    api.queueMessage = async () => {
      onEvent({
        id: "event-live",
        conversationId: "conv-1",
        sequence: 1,
        type: "assistant_message",
        payload: { text: "live before refresh" },
        createdAt: new Date().toISOString(),
      });
    };
    render(<App api={api} />);

    await user.type(await screen.findByRole("textbox", { name: "Message" }), "start");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("live before refresh")).toBeVisible();
  });

  it("refreshes persisted queue state after a terminal SSE event", async () => {
    const api = fakeApi({ activeTurn: true });
    const loadWorkspace = vi.spyOn(api, "loadWorkspace");
    let onEvent: (event: ConversationView["events"][number]) => void = () => undefined;
    api.subscribeConversationEvents = (_conversationId, _afterSequence, callback) => {
      onEvent = callback;
      return () => undefined;
    };
    render(<App api={api} />);
    await screen.findByRole("button", { name: "Stop" });

    onEvent({
      id: "event-terminal",
      conversationId: "conv-1",
      sequence: 1,
      type: "turn_status",
      payload: { turnId: "turn-running", status: "failed" },
      createdAt: new Date().toISOString(),
    });

    await vi.waitFor(() => expect(loadWorkspace).toHaveBeenCalledTimes(2));
  });

  it("keeps the selected Project Inspector after a background workspace refresh", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      twoProjects: true,
      initialInspector: createInspector("one.ts", "."),
      inspectorByProject: {
        "project-2": createInspector("two.ts", "."),
      },
    });
    const loadWorkspace = vi.spyOn(api, "loadWorkspace");
    const subscriptions = new Map<
      string,
      (event: ConversationView["events"][number]) => void
    >();
    api.subscribeConversationEvents = (conversationId, _afterSequence, callback) => {
      subscriptions.set(conversationId, callback);
      return () => subscriptions.delete(conversationId);
    };
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Conversation Two" }));
    expect(await screen.findByRole("button", { name: "two.ts" })).toBeVisible();

    subscriptions.get("conv-2")?.({
      id: "event-project-two-terminal",
      conversationId: "conv-2",
      sequence: 1,
      type: "turn_status",
      payload: { turnId: "turn-project-two", status: "completed" },
      createdAt: new Date().toISOString(),
    });

    await vi.waitFor(() => expect(loadWorkspace).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "two.ts" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "one.ts" })).toBeNull();
  });

  it("keeps both Canvases mounted when a background workspace refresh fails", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ activeTurn: true });
    const initial = await api.loadWorkspace();
    let onEvent: (event: ConversationView["events"][number]) => void = () => undefined;
    api.loadWorkspace = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    api.subscribeConversationEvents = (_conversationId, _afterSequence, callback) => {
      onEvent = callback;
      return () => undefined;
    };
    render(<App api={api} />);

    await user.type(await screen.findByLabelText("Message"), "draft survives refresh");
    onEvent({
      id: "event-refresh-failed",
      conversationId: "conv-1",
      sequence: 1,
      type: "turn_status",
      payload: { turnId: "turn-running", status: "completed" },
      createdAt: new Date().toISOString(),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("refresh unavailable");
    expect(screen.getByTestId("conversation-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("graph-canvas")).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toHaveValue("draft survives refresh");
  });

  it("subscribes to background Conversations and updates their sidebar status", async () => {
    const api = fakeApi({ twoProjects: true });
    const subscriptions = new Map<
      string,
      (event: ConversationView["events"][number]) => void
    >();
    api.subscribeConversationEvents = (conversationId, _afterSequence, callback) => {
      subscriptions.set(conversationId, callback);
      return () => subscriptions.delete(conversationId);
    };
    render(<App api={api} />);

    await screen.findByRole("button", { name: "Main Conversation" });
    await vi.waitFor(() => expect([...subscriptions.keys()].sort()).toEqual(["conv-1", "conv-2"]));
    subscriptions.get("conv-2")?.({
      id: "event-background-running",
      conversationId: "conv-2",
      sequence: 1,
      type: "turn_status",
      payload: { turnId: "turn-background", status: "running" },
      createdAt: new Date().toISOString(),
    });

    await vi.waitFor(() =>
      expect(within(screen.getByRole("button", { name: /Conversation Two/ })).getByText("running"))
        .toBeVisible(),
    );
  });

  it("preserves a Conversation draft while visiting a Project without Conversations", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ twoProjects: true });
    const initial = await api.loadWorkspace();
    const workspace = {
      ...initial,
      conversations: initial.conversations.filter((item) => item.projectId === "project-1"),
    };
    api.loadWorkspace = async () => workspace;
    render(<App api={api} />);

    await user.type(await screen.findByLabelText("Message"), "draft across empty project");
    await user.click(screen.getByRole("button", { name: "Project Two" }));
    expect(screen.getByText("Create a conversation to start.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Project One" }));

    expect(screen.getByLabelText("Message")).toHaveValue("draft across empty project");
  });

  it("keeps the selected Conversation across workspace refreshes", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi({ twoProjects: true })} />);

    await user.click(await screen.findByRole("button", { name: "Conversation Two" }));
    await user.type(screen.getByRole("textbox", { name: "Message" }), "refresh workspace");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("button", { name: "Conversation Two" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByRole("button", { name: "Conversation Two" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("selects a newly opened Project even when it has no Conversation", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const initial = await api.loadWorkspace();
    const opened: Project = {
      id: "project-new",
      path: "/tmp/new-project",
      name: "New Project",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    };
    const refreshed: WorkspaceState = {
      ...initial,
      projects: [...initial.projects, { id: opened.id, path: opened.path, name: opened.name }],
    };
    api.openProject = (async () => opened) as unknown as AinOneApi["openProject"];
    api.loadWorkspace = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    render(<App api={api} />);

    await user.type(await screen.findByLabelText("Project path"), opened.path);
    await user.click(screen.getByRole("button", { name: "Open Project" }));

    expect(await screen.findByRole("button", { name: "New Project" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByText("Create a conversation to start.")).toBeVisible();
  });

  it("selects a newly created Conversation instead of retaining the previous one", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const initial = await api.loadWorkspace();
    const created: Conversation = {
      id: "conv-new",
      projectId: "project-1",
      agentProductId: "codex",
      modelId: "gpt-5",
      permissionMode: "request_approval",
      queuePaused: false,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    };
    const newConversation: ConversationView = {
      ...initial.conversation!,
      id: created.id,
      title: "New Conversation",
      events: [],
      queuedMessages: [],
    };
    const refreshed: WorkspaceState = {
      ...initial,
      conversations: [...initial.conversations, newConversation],
    };
    api.createConversation = (async () => created) as unknown as AinOneApi["createConversation"];
    api.loadWorkspace = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Create Conversation" }));

    expect(await screen.findByRole("button", { name: "New Conversation" })).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("ignores an older workspace refresh that finishes after a newer one", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      agents: [
        agent("codex", "Codex", "available"),
        agent("claude", "Claude Code", "available"),
      ],
    });
    const initial = await api.loadWorkspace();
    const older = {
      ...initial,
      projects: initial.projects.map((project) => ({ ...project, name: "Older Project" })),
    };
    const newer = {
      ...initial,
      projects: initial.projects.map((project) => ({ ...project, name: "Newer Project" })),
    };
    const first = deferred<WorkspaceState>();
    const second = deferred<WorkspaceState>();
    api.loadWorkspace = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    api.updateAgentExecutablePath = async () => undefined;
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Agent Settings" }));
    await user.click(screen.getByRole("button", { name: "Save Codex path" }));
    await user.click(screen.getByRole("button", { name: "Save Claude Code path" }));
    await vi.waitFor(() => expect(api.loadWorkspace).toHaveBeenCalledTimes(3));

    second.resolve(newer);
    expect(await screen.findByRole("button", { name: "Newer Project" })).toBeVisible();
    first.resolve(older);
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Older Project" })).toBeNull());
    expect(screen.getByRole("button", { name: "Newer Project" })).toBeVisible();
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
    expect(screen.getByRole("button", { name: "Project Two" })).toHaveAttribute(
      "aria-pressed",
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

  it("closes an open permission menu when a Turn becomes active", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    let onEvent: (event: ConversationView["events"][number]) => void = () => undefined;
    api.subscribeConversationEvents = (_conversationId, _afterSequence, callback) => {
      onEvent = callback;
      return () => undefined;
    };
    render(<App api={api} />);

    const permissionButton = await screen.findByRole("button", { name: "Permission mode" });
    expect(permissionButton).toHaveAttribute("aria-expanded", "false");
    await user.click(permissionButton);
    expect(permissionButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitemradio", { name: "Full access" })).toBeVisible();
    onEvent({
      id: "turn-running",
      conversationId: "conv-1",
      sequence: 1,
      type: "turn_status",
      payload: { turnId: "turn-1", status: "running" },
      createdAt: "2026-08-22T00:00:00.000Z",
    });

    await vi.waitFor(() =>
      expect(screen.queryByRole("menuitemradio", { name: "Full access" })).toBeNull(),
    );
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

  it("opens a Project and creates a Conversation with one immutable Agent Product", async () => {
    const user = userEvent.setup();
    const openProject = vi.fn(async (): Promise<Project> => ({
      id: "project-2",
      path: "/tmp/new-project",
      name: "new-project",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    }));
    const createConversation = vi.fn(async (): Promise<Conversation> => ({
      id: "conv-2",
      projectId: "project-1",
      agentProductId: "claude",
      modelId: "sonnet",
      permissionMode: "request_approval",
      queuePaused: false,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    }));
    render(<App api={fakeApi({ openProject, createConversation })} />);

    await user.type(await screen.findByLabelText("Project path"), "/tmp/new-project");
    await user.click(screen.getByRole("button", { name: "Open Project" }));
    expect(openProject).toHaveBeenCalledWith("/tmp/new-project");

    await user.selectOptions(screen.getByLabelText("New conversation Agent Product"), "claude");
    await user.selectOptions(screen.getByLabelText("New conversation model"), "sonnet");
    await user.click(screen.getByRole("button", { name: "Create Conversation" }));
    expect(createConversation).toHaveBeenCalledWith({
      projectId: "project-1",
      agentProductId: "claude",
      modelId: "sonnet",
      permissionMode: "request_approval",
    });
  });

  it("only allows Conversations for runnable Agent Products", async () => {
    const user = userEvent.setup();
    const createConversation = vi.fn(async (): Promise<Conversation> => ({
      id: "conv-2",
      projectId: "project-1",
      agentProductId: "claude",
      modelId: "sonnet",
      permissionMode: "request_approval",
      queuePaused: false,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    }));
    render(
      <App
        api={fakeApi({
          createConversation,
          agents: [
            agent("codex", "Codex", "authentication_required"),
            agent("claude", "Claude Code", "capability_limited", ["sonnet"]),
            agent("trae", "Trae", "runtime_error"),
            agent("opencode", "OpenCode", "not_installed"),
          ],
        })}
      />,
    );

    expect(await screen.findByRole("option", { name: "Codex" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Trae" })).toBeDisabled();
    expect(screen.queryByRole("option", { name: "OpenCode" })).toBeNull();
    expect(screen.getByLabelText("New conversation Agent Product")).toHaveValue("claude");

    await user.click(screen.getByRole("button", { name: "Create Conversation" }));
    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ agentProductId: "claude" }),
    );
  });

  it("persists model and plugin version changes through separate scopes", async () => {
    const user = userEvent.setup();
    const updateConversationSettings = vi.fn(async () => undefined);
    const setPluginEnablements = vi.fn(async () => undefined);
    render(<App api={fakeApi({ updateConversationSettings, setPluginEnablements })} />);

    await user.selectOptions(await screen.findByLabelText("Model"), "gpt-5-mini");
    await user.selectOptions(screen.getByLabelText("Plugins"), "formatter@v2");

    expect(updateConversationSettings).toHaveBeenCalledWith("conv-1", {
      modelId: "gpt-5-mini",
      permissionMode: "request_approval",
    });
    expect(setPluginEnablements).toHaveBeenCalledWith(
      { type: "conversation", id: "conv-1" },
      [{ pluginId: "formatter", versionId: "v2" }],
    );
  });

  it("serializes model, permission, and Conversation plugin writes through one queue", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const second = deferred<void>();
    const third = deferred<void>();
    const updateConversationSettings = vi
      .fn<AinOneApi["updateConversationSettings"]>()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    const setPluginEnablements = vi
      .fn<AinOneApi["setPluginEnablements"]>()
      .mockImplementationOnce(async () => third.promise);
    render(<App api={fakeApi({ updateConversationSettings, setPluginEnablements })} />);

    await user.selectOptions(await screen.findByLabelText("Model"), "gpt-5-mini");
    await user.click(screen.getByRole("button", { name: "Permission mode" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Full access" }));
    await user.selectOptions(screen.getByLabelText("Plugins"), "formatter@v2");

    expect(updateConversationSettings).toHaveBeenCalledTimes(1);
    expect(setPluginEnablements).not.toHaveBeenCalled();
    expect(updateConversationSettings).toHaveBeenNthCalledWith(1, "conv-1", {
      modelId: "gpt-5-mini",
      permissionMode: "request_approval",
    });

    first.resolve();
    await vi.waitFor(() => expect(updateConversationSettings).toHaveBeenCalledTimes(2));
    expect(updateConversationSettings).toHaveBeenNthCalledWith(2, "conv-1", {
      modelId: "gpt-5-mini",
      permissionMode: "full_access",
    });
    expect(setPluginEnablements).not.toHaveBeenCalled();

    second.resolve();
    await vi.waitFor(() => expect(setPluginEnablements).toHaveBeenCalledTimes(1));
    expect(setPluginEnablements).toHaveBeenCalledWith(
      { type: "conversation", id: "conv-1" },
      [{ pluginId: "formatter", versionId: "v2" }],
    );
    third.resolve();
  });

  it("waits for every queued configuration write before sending a message", async () => {
    const user = userEvent.setup();
    const settingsWrite = deferred<void>();
    const pluginWrite = deferred<void>();
    const updateConversationSettings = vi.fn(async () => settingsWrite.promise);
    const setPluginEnablements = vi.fn(async () => pluginWrite.promise);
    const queueMessage = vi.fn(async () => undefined);
    render(
      <App
        api={fakeApi({ updateConversationSettings, setPluginEnablements, queueMessage })}
      />,
    );

    await user.selectOptions(await screen.findByLabelText("Model"), "gpt-5-mini");
    await user.selectOptions(screen.getByLabelText("Plugins"), "formatter@v2");
    await user.type(screen.getByLabelText("Message"), "use current settings");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(queueMessage).not.toHaveBeenCalled();
    settingsWrite.resolve();
    await vi.waitFor(() => expect(setPluginEnablements).toHaveBeenCalledTimes(1));
    expect(queueMessage).not.toHaveBeenCalled();

    pluginWrite.resolve();
    await vi.waitFor(() =>
      expect(queueMessage).toHaveBeenCalledWith("conv-1", "use current settings"),
    );
  });

  it("keeps the draft and does not send when a configuration write fails", async () => {
    const user = userEvent.setup();
    const settingsWrite = deferred<void>();
    const updateConversationSettings = vi.fn(async () => settingsWrite.promise);
    const queueMessage = vi.fn(async () => undefined);
    render(<App api={fakeApi({ updateConversationSettings, queueMessage })} />);

    await user.selectOptions(await screen.findByLabelText("Model"), "gpt-5-mini");
    const message = screen.getByLabelText("Message");
    await user.type(message, "keep after settings failure");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    settingsWrite.reject(new Error("settings unavailable"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not update conversation settings: settings unavailable",
    );
    expect(queueMessage).not.toHaveBeenCalled();
    expect(message).toHaveValue("keep after settings failure");
  });

  it("does not let a successful plugin write hide a failed conversation settings write", async () => {
    const user = userEvent.setup();
    const updateConversationSettings = vi.fn(async () => {
      throw new Error("settings unavailable");
    });
    const setPluginEnablements = vi.fn(async () => undefined);
    const queueMessage = vi.fn(async () => undefined);
    render(
      <App
        api={fakeApi({ updateConversationSettings, setPluginEnablements, queueMessage })}
      />,
    );

    await user.selectOptions(await screen.findByLabelText("Model"), "gpt-5-mini");
    await user.selectOptions(screen.getByLabelText("Plugins"), "formatter@v2");
    const message = screen.getByLabelText("Message");
    await user.type(message, "do not send stale settings");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not update conversation settings",
    );
    expect(setPluginEnablements).toHaveBeenCalledOnce();
    expect(queueMessage).not.toHaveBeenCalled();
    expect(message).toHaveValue("do not send stale settings");
  });

  it("does not let one Conversation's failed settings write block another Conversation", async () => {
    const user = userEvent.setup();
    const updateConversationSettings = vi.fn(async (conversationId: string) => {
      if (conversationId === "conv-1") {
        throw new Error("settings unavailable");
      }
    });
    const queueMessage = vi.fn(async () => undefined);
    render(
      <App
        api={fakeApi({ twoProjects: true, updateConversationSettings, queueMessage })}
      />,
    );

    await user.selectOptions(await screen.findByLabelText("Model"), "gpt-5-mini");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not update conversation settings",
    );

    await user.click(screen.getByRole("button", { name: "Conversation Two" }));
    await user.type(screen.getByLabelText("Message"), "send from two");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await vi.waitFor(() =>
      expect(queueMessage).toHaveBeenCalledWith("conv-2", "send from two"),
    );
  });

  it("restores a Conversation's configuration error when Send remains blocked", async () => {
    const user = userEvent.setup();
    const updateConversationSettings = vi.fn(async (conversationId: string) => {
      if (conversationId === "conv-1") {
        throw new Error("settings unavailable");
      }
    });
    const queueMessage = vi.fn(async () => undefined);
    render(
      <App
        api={fakeApi({ twoProjects: true, updateConversationSettings, queueMessage })}
      />,
    );

    await user.selectOptions(await screen.findByLabelText("Model"), "gpt-5-mini");
    expect(await screen.findByRole("alert")).toHaveTextContent("settings unavailable");
    await user.click(screen.getByRole("button", { name: "Conversation Two" }));
    await user.click(screen.getByRole("button", { name: "Main Conversation" }));
    expect(screen.queryByRole("alert")).toBeNull();

    await user.type(screen.getByLabelText("Message"), "blocked with explanation");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("settings unavailable");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("waits for configuration writes queued while Send is already waiting", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const second = deferred<void>();
    const updateConversationSettings = vi
      .fn<AinOneApi["updateConversationSettings"]>()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    const queueMessage = vi.fn(async () => undefined);
    render(<App api={fakeApi({ updateConversationSettings, queueMessage })} />);

    await user.selectOptions(await screen.findByLabelText("Model"), "gpt-5-mini");
    await user.type(screen.getByLabelText("Message"), "wait for both writes");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await user.click(screen.getByRole("button", { name: "Permission mode" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Full access" }));

    first.resolve();
    await vi.waitFor(() => expect(updateConversationSettings).toHaveBeenCalledTimes(2));
    expect(queueMessage).not.toHaveBeenCalled();
    second.resolve();
    await vi.waitFor(() => expect(queueMessage).toHaveBeenCalledOnce());
  });

  it("serializes Conversation replace-all plugin writes so the latest complete set wins", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const setPluginEnablements = vi
      .fn<AinOneApi["setPluginEnablements"]>()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    render(
      <App
        api={fakeApi({
          setPluginEnablements,
          pluginState: {
            enabledPluginIds: ["formatter@v2"],
            availablePlugins: [
              plugin("formatter@v2", "formatter", "v2"),
              plugin("reviewer@v1", "reviewer", "v1"),
            ],
          },
        })}
      />,
    );

    const select = await screen.findByLabelText<HTMLSelectElement>("Plugins");
    selectOptions(select, ["reviewer@v1"]);
    selectOptions(select, ["formatter@v2", "reviewer@v1"]);

    expect(setPluginEnablements).toHaveBeenCalledTimes(1);
    expect(setPluginEnablements).toHaveBeenNthCalledWith(
      1,
      { type: "conversation", id: "conv-1" },
      [{ pluginId: "reviewer", versionId: "v1" }],
    );

    first.resolve();
    await vi.waitFor(() => expect(setPluginEnablements).toHaveBeenCalledTimes(2));
    expect(setPluginEnablements).toHaveBeenNthCalledWith(
      2,
      { type: "conversation", id: "conv-1" },
      [
        { pluginId: "formatter", versionId: "v2" },
        { pluginId: "reviewer", versionId: "v1" },
      ],
    );
    second.resolve();
  });

  it("serializes rapid Plugin Settings changes and sends the latest complete set", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const second = deferred<void>();
    const setPluginEnablements = vi
      .fn<AinOneApi["setPluginEnablements"]>()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    render(
      <App
        api={fakeApi({
          setPluginEnablements,
          installedPlugins: [
            plugin("formatter@v2", "formatter", "v2"),
            plugin("reviewer@v1", "reviewer", "v1"),
          ],
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Plugin Settings" }));
    await user.click(screen.getByRole("checkbox", { name: "Enable formatter v2" }));
    await user.click(screen.getByRole("checkbox", { name: "Enable reviewer v1" }));

    await vi.waitFor(() => expect(setPluginEnablements).toHaveBeenCalledTimes(1));
    expect(setPluginEnablements).toHaveBeenNthCalledWith(
      1,
      { type: "global" },
      [{ pluginId: "formatter", versionId: "v2" }],
    );

    first.resolve();
    await vi.waitFor(() => expect(setPluginEnablements).toHaveBeenCalledTimes(2));
    expect(setPluginEnablements).toHaveBeenNthCalledWith(
      2,
      { type: "global" },
      [
        { pluginId: "formatter", versionId: "v2" },
        { pluginId: "reviewer", versionId: "v1" },
      ],
    );
    second.resolve();
  });

  it("clears and disables Plugin Settings while a new scope is loading", async () => {
    const user = userEvent.setup();
    const projectEnablements = deferred<Array<{ pluginId: string; versionId: string }>>();
    const setPluginEnablements = vi.fn(async () => undefined);
    render(
      <App
        api={fakeApi({
          getPluginEnablements: async (scope) =>
            scope.type === "project" ? projectEnablements.promise : [],
          setPluginEnablements,
          installedPlugins: [plugin("formatter@v2", "formatter", "v2")],
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Plugin Settings" }));
    await user.selectOptions(screen.getByLabelText("Plugin scope"), "project");

    expect(screen.getByRole("checkbox", { name: "Enable formatter v2" })).toBeDisabled();
    expect(setPluginEnablements).not.toHaveBeenCalled();

    projectEnablements.resolve([{ pluginId: "formatter", versionId: "v2" }]);
    await vi.waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Enable formatter v2" })).toBeChecked(),
    );
  });

  it("keeps Plugin Settings disabled when enablements fail to load", async () => {
    const user = userEvent.setup();
    const setPluginEnablements = vi.fn(async () => undefined);
    render(
      <App
        api={fakeApi({
          getPluginEnablements: async () => {
            throw new Error("enablements unavailable");
          },
          setPluginEnablements,
          installedPlugins: [plugin("formatter@v2", "formatter", "v2")],
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Plugin Settings" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("enablements unavailable");

    const checkbox = screen.getByRole("checkbox", { name: "Enable formatter v2" });
    expect(checkbox).toBeDisabled();
    await user.click(checkbox);
    expect(setPluginEnablements).not.toHaveBeenCalled();
  });

  it("does not let a failed old-scope write overwrite the selected plugin scope", async () => {
    const user = userEvent.setup();
    const globalWrite = deferred<void>();
    render(
      <App
        api={fakeApi({
          installedPlugins: [
            plugin("formatter@v2", "formatter", "v2"),
            plugin("reviewer@v1", "reviewer", "v1"),
          ],
          getPluginEnablements: async (scope) =>
            scope.type === "project" ? [{ pluginId: "reviewer", versionId: "v1" }] : [],
          setPluginEnablements: async (scope) => {
            if (scope.type === "global") {
              await globalWrite.promise;
            }
          },
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Plugin Settings" }));
    await user.click(screen.getByRole("checkbox", { name: "Enable formatter v2" }));
    await user.selectOptions(screen.getByLabelText("Plugin scope"), "project");
    await vi.waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Enable reviewer v1" })).toBeChecked(),
    );

    globalWrite.reject(new Error("global write failed"));
    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(screen.getByRole("checkbox", { name: "Enable reviewer v1" })).toBeChecked();
  });

  it("keeps only one enabled version of a plugin", async () => {
    const user = userEvent.setup();
    const setPluginEnablements = vi.fn(async () => undefined);
    render(
      <App
        api={fakeApi({
          setPluginEnablements,
          installedPlugins: [
            plugin("formatter@v1", "formatter", "v1"),
            plugin("formatter@v2", "formatter", "v2"),
          ],
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Plugin Settings" }));
    await user.click(screen.getByRole("checkbox", { name: "Enable formatter v1" }));
    await user.click(screen.getByRole("checkbox", { name: "Enable formatter v2" }));

    await vi.waitFor(() => expect(setPluginEnablements).toHaveBeenCalledTimes(2));
    expect(setPluginEnablements).toHaveBeenLastCalledWith(
      { type: "global" },
      [{ pluginId: "formatter", versionId: "v2" }],
    );
  });

  it("keeps separate drafts for each Conversation", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi({ twoProjects: true })} />);

    const message = await screen.findByLabelText("Message");
    await user.type(message, "draft for one");
    await user.click(screen.getByRole("button", { name: "Conversation Two" }));
    expect(screen.getByLabelText("Message")).toHaveValue("");

    await user.type(screen.getByLabelText("Message"), "draft for two");
    await user.click(screen.getByRole("button", { name: "Main Conversation" }));
    expect(screen.getByLabelText("Message")).toHaveValue("draft for one");
  });

  it("does not clear a new draft typed while the previous send is finishing", async () => {
    const user = userEvent.setup();
    const queued = deferred<void>();
    const queueMessage = vi.fn(async () => queued.promise);
    render(<App api={fakeApi({ queueMessage })} />);

    const message = await screen.findByLabelText("Message");
    await user.type(message, "first message");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await user.clear(message);
    await user.type(message, "next message");
    queued.resolve();

    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
    );
    expect(message).toHaveValue("next message");
  });

  it("opens Agent and Plugin settings without unmounting either Canvas", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} />);

    await user.click(await screen.findByRole("button", { name: "Agent Settings" }));
    expect(screen.getByRole("heading", { name: "Agent Products" })).toBeVisible();
    expect(screen.getByTestId("conversation-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("graph-canvas")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Plugin Settings" }));
    expect(screen.getByRole("heading", { name: "Plugins" })).toBeVisible();
  });

  it("shows Agent Settings catalog for the selected Project", async () => {
    const user = userEvent.setup();
    const codex = agent("codex", "Codex", "available", ["first-model"]);
    codex.projectCatalogs = {
      "project-1": { models: ["first-model"], permissionModes: ["request_approval"] },
      "project-2": { models: ["second-model"], permissionModes: ["full_access"] },
    };
    render(<App api={fakeApi({ twoProjects: true, agents: [codex] })} />);

    await user.click(await screen.findByRole("button", { name: "Project Two" }));
    await user.click(screen.getByRole("button", { name: "Agent Settings" }));

    expect(
      within(screen.getByRole("region", { name: "Codex catalog models" })).getByText(
        "second-model",
      ),
    ).toBeVisible();
    expect(screen.getByText("Full access")).toBeVisible();
    expect(screen.queryByText("first-model")).toBeNull();
  });
});

function fakeApi(
  input: {
    activeTurn?: boolean;
    recoveryTurn?: Pick<ConversationView, "latestTurnId" | "latestTurnStatus">;
    includeAllEventTypes?: boolean;
    initialQueuedMessages?: string[];
    permissionModes?: PermissionMode[];
    cancelActiveTurn?: (conversationId: string) => Promise<void>;
    continueConversation?: (conversationId: string) => Promise<void>;
    retryInterruptedTurn?: (conversationId: string, turnId: string) => Promise<void>;
    queueError?: Error;
    inspectorError?: Error;
    twoProjects?: boolean;
    initialInspector?: InspectorState;
    inspectorByProject?: Record<string, InspectorState | Promise<InspectorState>>;
    listProjectFiles?: AinOneApi["listProjectFiles"];
    openProject?: AinOneApi["openProject"];
    createConversation?: AinOneApi["createConversation"];
    queueMessage?: AinOneApi["queueMessage"];
    updateConversationSettings?: AinOneApi["updateConversationSettings"];
    setPluginEnablements?: AinOneApi["setPluginEnablements"];
    getPluginEnablements?: AinOneApi["getPluginEnablements"];
    pluginState?: Pick<ConversationView, "enabledPluginIds" | "availablePlugins">;
    installedPlugins?: WorkspaceState["installedPlugins"];
    agents?: WorkspaceState["agents"];
  } = {},
): AinOneApi {
  const state = createWorkspaceState({
    activeTurn: input.activeTurn ?? false,
    recoveryTurn: input.recoveryTurn,
    includeAllEventTypes: input.includeAllEventTypes ?? false,
    initialQueuedMessages: input.initialQueuedMessages ?? [],
    permissionModes: input.permissionModes,
    twoProjects: input.twoProjects ?? false,
    initialInspector: input.initialInspector,
    pluginState: input.pluginState,
    installedPlugins: input.installedPlugins,
    agents: input.agents,
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
    async queueMessage(conversationId, content) {
      await input.queueMessage?.(conversationId, content);
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
    async continueConversation(conversationId) {
      await input.continueConversation?.(conversationId);
    },
    async retryInterruptedTurn(conversationId, turnId) {
      await input.retryInterruptedTurn?.(conversationId, turnId);
    },
    async openProject(path) {
      if (input.openProject) {
        return await input.openProject(path);
      }
      return {
        id: "project-opened",
        path,
        name: path.split("/").at(-1) || path,
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:00.000Z",
      };
    },
    async createConversation(settings) {
      if (input.createConversation) {
        return await input.createConversation(settings);
      }
      return {
        id: "conv-created",
        projectId: settings.projectId,
        agentProductId: settings.agentProductId,
        modelId: settings.modelId,
        permissionMode: settings.permissionMode ?? "request_approval",
        queuePaused: false,
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:00.000Z",
      };
    },
    async updateConversationSettings(conversationId, settings) {
      await input.updateConversationSettings?.(conversationId, settings);
    },
    async updateAgentExecutablePath() {
      return undefined;
    },
    async installPlugin() {
      return undefined;
    },
    async refreshPluginImports() {
      return undefined;
    },
    async acceptPluginCandidate() {
      return undefined;
    },
    async repairPluginMaterialization() {
      return undefined;
    },
    async getPluginEnablements(scope) {
      return await input.getPluginEnablements?.(scope) ?? [];
    },
    async setPluginEnablements(scope, versions) {
      await input.setPluginEnablements?.(scope, versions);
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
  recoveryTurn?: Pick<ConversationView, "latestTurnId" | "latestTurnStatus">;
  includeAllEventTypes: boolean;
  initialQueuedMessages: string[];
  permissionModes?: PermissionMode[];
  twoProjects: boolean;
  initialInspector?: InspectorState;
  pluginState?: Pick<ConversationView, "enabledPluginIds" | "availablePlugins">;
  installedPlugins?: WorkspaceState["installedPlugins"];
  agents?: WorkspaceState["agents"];
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
    enabledPluginIds: input.pluginState?.enabledPluginIds ?? [],
    availablePlugins: input.pluginState?.availablePlugins ?? [
      plugin("formatter@v2", "formatter", "v2"),
    ],
    activeTurnStatus: input.activeTurn ? "running" : null,
    latestTurnStatus: input.recoveryTurn?.latestTurnStatus
      ? input.recoveryTurn.latestTurnStatus
      : input.activeTurn
        ? "running"
        : "completed",
    latestTurnId:
      input.recoveryTurn?.latestTurnId ?? (input.activeTurn ? "turn-running" : "turn-completed"),
    queuePaused: Boolean(input.recoveryTurn),
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
    agents: input.agents ?? [
      {
        id: "codex",
        name: "Codex",
        status: "available",
        executablePath: "codex",
        catalog: {
          models: ["gpt-5", "gpt-5-mini"],
          permissionModes: ["request_approval", "full_access"],
        },
      },
      {
        id: "claude",
        name: "Claude Code",
        status: "available",
        executablePath: "claude",
        catalog: {
          models: ["sonnet"],
          permissionModes: ["request_approval"],
        },
      },
    ],
    installedPlugins: input.installedPlugins ?? [],
    pluginCandidates: [],
    pluginError: null,
  };
}

function agent(
  id: WorkspaceState["agents"][number]["id"],
  name: string,
  status: WorkspaceState["agents"][number]["status"],
  models: string[] = [],
): WorkspaceState["agents"][number] {
  return {
    id,
    name,
    status,
    executablePath: id === "trae" ? "traecli" : id,
    catalog: { models, permissionModes: ["request_approval"] },
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function selectOptions(select: HTMLSelectElement, values: string[]): void {
  for (const option of select.options) {
    option.selected = values.includes(option.value);
  }
  fireEvent.change(select);
}

function plugin(
  id: string,
  pluginId: string,
  versionId: string,
): ConversationView["availablePlugins"][number] {
  return {
    id,
    pluginId,
    versionId,
    name: `${pluginId} ${versionId}`,
    type: "skill",
    compatibleAgents: ["codex"],
    materializations: [],
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
