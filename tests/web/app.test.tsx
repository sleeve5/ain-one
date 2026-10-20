import { readFileSync } from "node:fs";
import { act, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/web/app.js";
import type {
  AinOneApi,
  ConversationView,
  WorkspaceState,
} from "../../src/web/api.js";
import type {
  Conversation,
  NormalizedEventType,
  PermissionMode,
  Project,
} from "../../src/shared/contracts.js";

describe("web app", () => {
  it("disables sending while a Turn is active along with Turn settings", async () => {
    const user = userEvent.setup();
    const queueMessage = vi.fn(async () => undefined);
    render(<App api={fakeApi({ activeTurn: true, queueMessage })} />);

    expect(await screen.findByLabelText("Model")).toBeDisabled();
    expect(screen.getByLabelText("Permission mode")).toBeDisabled();

    await user.type(screen.getByLabelText("Message"), "next task");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await user.keyboard("{enter}");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("cancels an active Turn from the Stop button", async () => {
    const user = userEvent.setup();
    const cancelActiveTurn = vi.fn(async () => undefined);
    render(<App api={fakeApi({ activeTurn: true, cancelActiveTurn })} />);

    await user.click(await screen.findByRole("button", { name: "Stop" }));

    expect(cancelActiveTurn).toHaveBeenCalledWith("conv-1");
  });

  it("restarts the workspace from the sidebar instead of showing an inline recovery banner", async () => {
    const user = userEvent.setup();
    const restartWorkspace = vi.fn(async () => undefined);
    render(
      <App
        api={fakeApi({
          recoveryTurn: {
            latestTurnId: "turn-interrupted",
            latestTurnStatus: "interrupted",
          },
          initialQueuedMessages: ["next task"],
          restartWorkspace,
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Restart project" }));
    expect(restartWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/confirm native work is inactive/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue sending" })).toBeNull();
    expect(screen.getByRole("button", { name: "Restart project" })).toHaveAttribute("data-tooltip");
    expect(screen.getByRole("button", { name: "Search projects" })).toHaveAttribute("data-tooltip");
    expect(screen.getByRole("button", { name: "Open Project Folder" })).toHaveAttribute("data-tooltip");
  });

  it("uses the latest Agent capabilities after restarting a hydrated Conversation", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const initial = await api.loadWorkspace();
    const hydrated = {
      ...initial.conversation!,
      hydrated: true,
      availableModels: ["old-model"],
      availablePermissionModes: ["request_approval" as const],
    };
    const refreshed = {
      ...hydrated,
      hydrated: false,
      modelId: "new-model",
      permissionMode: "full_access" as const,
      availableModels: ["new-model"],
      availablePermissionModes: ["full_access" as const],
      events: [],
      rawEvents: [],
    };
    api.loadWorkspace = vi.fn()
      .mockResolvedValueOnce({
        ...initial,
        conversation: hydrated,
        conversations: [hydrated],
      })
      .mockResolvedValueOnce({
        ...initial,
        conversation: refreshed,
        conversations: [refreshed],
      });
    api.loadConversation = vi.fn(async () => ({
      ...refreshed,
      hydrated: true,
      latestTurnStatus: "completed" as const,
    }));

    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: "Restart project" }));

    await vi.waitFor(() => expect(api.loadConversation).toHaveBeenCalledWith("conv-1"));
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("menuitemradio", { name: "new-model" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio", { name: "old-model" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Model" }));
    await user.click(screen.getByRole("button", { name: "Permission mode" }));
    expect(screen.getByRole("menuitemradio", { name: "Full access" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio", { name: "Ask for approval" })).toBeNull();
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

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not send message");
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
        type: "assistant_message" as const,
        payload: { text: "live before refresh" },
        createdAt: new Date().toISOString(),
      });
    };
    render(<App api={api} />);

    await user.type(await screen.findByRole("textbox", { name: "Message" }), "start");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await within(screen.getByTestId("conversation-canvas")).findByText("live before refresh")).toBeVisible();
  });

  it("hydrates missing events when a workspace summary advances beyond local SSE state", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const initial = await api.loadWorkspace();
    const hydrated = {
      ...initial.conversation!,
      hydrated: true,
      latestEventSequence: 0,
    };
    const advanced = {
      ...hydrated,
      hydrated: false,
      latestEventSequence: 2,
      events: [],
      rawEvents: [],
    };
    api.loadWorkspace = vi.fn()
      .mockResolvedValueOnce({
        ...initial,
        conversation: hydrated,
        conversations: [hydrated],
      })
      .mockResolvedValueOnce({
        ...initial,
        conversation: advanced,
        conversations: [advanced],
      });
    api.loadConversation = vi.fn(async () => ({
      ...advanced,
      hydrated: true,
      events: [{
        id: "missed-output",
        conversationId: "conv-1",
        sequence: 2,
        type: "assistant_message" as const,
        payload: { text: "Recovered missed output" },
        createdAt: "2026-08-24T00:00:02.000Z",
      }],
    }));
    render(<App api={api} />);

    await user.type(await screen.findByRole("textbox", { name: "Message" }), "start");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(
      await within(screen.getByTestId("conversation-canvas")).findByText("Recovered missed output"),
    ).toBeVisible();
    expect(api.loadConversation).toHaveBeenCalledWith("conv-1");
  });

  it("hydrates the selected Conversation after loading workspace summaries", async () => {
    const api = fakeApi();
    const workspace = await api.loadWorkspace();
    const summary = {
      ...workspace.conversation!,
      hydrated: false,
      events: [],
      rawEvents: [],
    };
    api.loadWorkspace = vi.fn(async () => ({
      ...workspace,
      conversations: [summary],
      conversation: summary,
    }));
    api.loadConversation = vi.fn(async (): Promise<ConversationView> => ({
      ...summary,
      hydrated: true,
      events: [{
        id: "hydrated-answer",
        conversationId: summary.id,
        sequence: 1,
        type: "assistant_message",
        payload: { text: "Loaded on demand" },
        createdAt: "2026-08-24T00:00:00.000Z",
      }],
    }));

    render(<App api={api} />);

    const canvas = await screen.findByTestId("conversation-canvas");
    expect(await within(canvas).findByText("Loaded on demand")).toBeVisible();
    expect(api.loadConversation).toHaveBeenCalledOnce();
    expect(api.loadConversation).toHaveBeenCalledWith("conv-1");
  });

  it("retries failed Conversation hydration when the same Conversation is selected again", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const workspace = await api.loadWorkspace();
    const summary = {
      ...workspace.conversation!,
      hydrated: false,
      events: [],
      rawEvents: [],
    };
    api.loadWorkspace = vi.fn(async () => ({
      ...workspace,
      conversations: [summary],
      conversation: summary,
    }));
    api.loadConversation = vi.fn()
      .mockRejectedValueOnce(new Error("detail unavailable"))
      .mockResolvedValueOnce({
        ...summary,
        hydrated: true,
        events: [{
          id: "hydrated-after-retry",
          conversationId: summary.id,
          sequence: 1,
          type: "assistant_message",
          payload: { text: "Loaded after retry" },
          createdAt: "2026-08-24T00:00:00.000Z",
        }],
      });

    render(<App api={api} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load Conversation");
    await user.click(screen.getByRole("button", { name: "Main Conversation" }));

    expect(
      await within(screen.getByTestId("conversation-canvas")).findByText("Loaded after retry"),
    ).toBeVisible();
    expect(api.loadConversation).toHaveBeenCalledTimes(2);
  });

  it("refreshes persisted Turn state from Conversation detail after a terminal SSE event", async () => {
    const api = fakeApi({ activeTurn: true });
    const initial = await api.loadWorkspace();
    api.loadConversation = vi.fn(async () => ({
      ...initial.conversation!,
      activeTurnStatus: null,
      latestTurnStatus: "failed" as const,
      hydrated: true,
    }));
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

    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull()
    );
    expect(api.loadConversation).toHaveBeenCalledWith("conv-1");
  });

  it("reconciles the durable queue after a delivery acknowledgement", async () => {
    const api = fakeApi({ initialQueuedMessages: ["follow up"] });
    const initial = await api.loadWorkspace();
    api.loadConversation = vi.fn(async () => ({
      ...initial.conversation!,
      queuedMessages: [],
      hydrated: true,
    }));
    let onEvent: (event: ConversationView["events"][number]) => void = () => undefined;
    api.subscribeConversationEvents = (_conversationId, _afterSequence, callback) => {
      onEvent = callback;
      return () => undefined;
    };
    render(<App api={api} />);
    expect(await screen.findByText("follow up")).toBeVisible();

    onEvent({
      id: "event-ack", conversationId: "conv-1", sequence: 1, type: "queue_status",
      payload: {
        status: "processing", acceptingInput: true, hasPendingInput: false,
        acknowledged: { messageId: "msg-1", deliveryId: "delivery-1" },
      },
      createdAt: new Date().toISOString(),
    });

    await vi.waitFor(() => expect(screen.queryByText("follow up")).toBeNull());
    expect(api.loadConversation).toHaveBeenCalledWith("conv-1");
  });

  it("applies the terminal refresh when the next queued Turn emits an ordinary event", async () => {
    const api = fakeApi({ activeTurn: true, initialQueuedMessages: ["next task"] });
    const initial = await api.loadWorkspace();
    const refresh = deferred<ConversationView>();
    let onEvent: (event: ConversationView["events"][number]) => void = () => undefined;
    api.loadConversation = vi.fn(async () => refresh.promise);
    api.subscribeConversationEvents = (_conversationId, _afterSequence, callback) => {
      onEvent = callback;
      return () => undefined;
    };
    render(<App api={api} />);
    await screen.findByRole("button", { name: "Stop" });

    onEvent({
      id: "event-first-terminal",
      conversationId: "conv-1",
      sequence: 1,
      type: "turn_status",
      payload: { turnId: "turn-first", status: "completed" },
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(() => expect(api.loadConversation).toHaveBeenCalledWith("conv-1"));
    onEvent({
      id: "event-next-output",
      conversationId: "conv-1",
      sequence: 2,
      type: "assistant_message",
      payload: { text: "continuing queued work" },
      createdAt: new Date().toISOString(),
    });

    const continuedConversation = {
      ...initial.conversation!,
      activeTurnStatus: null,
      latestTurnId: "turn-first",
      latestTurnStatus: "completed" as const,
      queuedMessages: [],
      latestEventSequence: 1,
    };
    onEvent({
      id: "event-next-running",
      conversationId: "conv-1",
      sequence: 3,
      type: "turn_status",
      payload: { turnId: "turn-next", status: "running" },
      createdAt: new Date().toISOString(),
    });
    await act(async () => refresh.resolve(continuedConversation));

    expect(await screen.findByRole("button", { name: "Stop" })).toBeVisible();
    expect(screen.queryByText("next task")).toBeNull();
    expect(
      within(screen.getByTestId("conversation-canvas")).getByText("continuing queued work"),
    ).toBeVisible();
  });

  it("does not duplicate streamed output when Conversation detail resolves late", async () => {
    const api = fakeApi();
    const initial = await api.loadWorkspace();
    const summary = {
      ...initial.conversation!,
      hydrated: false,
      latestEventSequence: 0,
      events: [],
      rawEvents: [],
    };
    const refresh = deferred<ConversationView>();
    let onEvent: (event: ConversationView["events"][number]) => void = () => undefined;
    api.loadWorkspace = vi.fn(async () => ({
      ...initial,
      conversations: [summary],
      conversation: summary,
    }));
    api.loadConversation = vi.fn(async () => refresh.promise);
    api.subscribeConversationEvents = (_conversationId, _afterSequence, callback) => {
      onEvent = callback;
      return () => undefined;
    };
    render(<App api={api} />);
    await vi.waitFor(() => expect(api.loadConversation).toHaveBeenCalledWith("conv-1"));

    await act(async () => {
      onEvent({
        id: "delta-1",
        conversationId: "conv-1",
        sequence: 1,
        type: "assistant_message",
        payload: { text: "Hello", streamId: "answer", delta: true },
        createdAt: new Date().toISOString(),
      });
      onEvent({
        id: "delta-2",
        conversationId: "conv-1",
        sequence: 2,
        type: "assistant_message",
        payload: { text: " world", streamId: "answer", delta: true },
        createdAt: new Date().toISOString(),
      });
    });
    expect(
      await within(screen.getByTestId("conversation-canvas")).findByText("Hello world"),
    ).toBeVisible();
    await act(async () => refresh.resolve({
      ...initial.conversation!,
      modelId: "gpt-late",
      availableModels: ["gpt-late"],
      hydrated: true,
      latestEventSequence: 0,
      events: [],
      rawEvents: [],
    }));

    await vi.waitFor(() => {
      expect(
        within(screen.getByTestId("conversation-canvas")).getByText("Hello world"),
      ).toBeVisible();
      expect(screen.queryByText("HelloHello world")).toBeNull();
    });
  });

  it("keeps the selected Chat canvas mounted when terminal detail reconciliation fails", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ activeTurn: true });
    let onEvent: (event: ConversationView["events"][number]) => void = () => undefined;
    api.loadConversation = vi.fn(async () => {
      throw new Error("detail unavailable");
    });
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

    await vi.waitFor(() => expect(api.loadConversation).toHaveBeenCalledWith("conv-1"));
    expect(screen.getByTestId("conversation-canvas")).toBeInTheDocument();
    expect(screen.queryByTestId("graph-canvas")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toHaveValue("draft survives refresh");
  });

  it("marks completed background Conversations unread and clears the dot when opened", async () => {
    const user = userEvent.setup();
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
      id: "event-background-complete",
      conversationId: "conv-2",
      sequence: 1,
      type: "turn_status",
      payload: { turnId: "turn-background", status: "completed" },
      createdAt: new Date().toISOString(),
    });

    const backgroundButton = screen.getByRole("button", { name: "Conversation Two" });
    await vi.waitFor(() => expect(within(backgroundButton).getByLabelText("Unread")).toBeVisible());
    await user.click(backgroundButton);
    expect(within(backgroundButton).queryByLabelText("Unread")).toBeNull();
  });

  it("shows starting feedback before queueMessage resolves", async () => {
    const user = userEvent.setup();
    const queued = deferred<void>();
    render(<App api={fakeApi({ queueMessage: async () => queued.promise })} />);

    await user.type(await screen.findByLabelText("Message"), "start slowly");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Connecting");
    await act(async () => queued.resolve());
  });

  it("keeps the current running status and blocks follow-up submission", async () => {
    const user = userEvent.setup();
    const queueMessage = vi.fn(async () => undefined);
    render(<App api={fakeApi({ activeTurn: true, queueMessage })} />);

    await user.type(await screen.findByLabelText("Message"), "follow up");
    await user.keyboard("{enter}");

    expect(screen.getByRole("status")).toHaveTextContent("Analyzing");
    expect(screen.getByRole("status")).not.toHaveTextContent("Connecting");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("shows starting feedback for a newly created Conversation before its first queue resolves", async () => {
    const user = userEvent.setup();
    const created = deferred<Conversation>();
    render(<App api={fakeApi({ createConversation: async () => created.promise })} />);

    await user.click(await screen.findByRole("button", { name: /New chat/ }));
    await user.type(screen.getByLabelText("Message"), "first message");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Connecting");
    await act(async () => created.resolve(conversationDto("conv-created", null)));
  });

  it("clears starting feedback when a new Conversation cannot queue its first message", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi({ queueMessage: async () => { throw new Error("offline"); } })} />);

    await user.click(await screen.findByRole("button", { name: /New chat/ }));
    await user.type(screen.getByLabelText("Message"), "first message");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not create Conversation");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByLabelText("Message")).toHaveValue("first message");
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
    expect(screen.getByRole("heading", { name: "New conversation" })).toBeVisible();
    expect(screen.getByLabelText("Message")).toBeVisible();
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

  it("adds and selects a newly opened Project without reloading the workspace", async () => {
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
    api.pickProject = (async () => opened) as AinOneApi["pickProject"];
    api.loadWorkspace = vi.fn().mockResolvedValue(initial);
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Open Project Folder" }));

    expect(await screen.findByRole("button", { name: "New Project" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByRole("heading", { name: "New conversation" })).toBeVisible();
    expect(screen.getByLabelText("Message")).toBeVisible();
    expect(api.loadWorkspace).toHaveBeenCalledOnce();
  });

  it("does not let a pending Project import replace a newer Project selection", async () => {
    const user = userEvent.setup();
    const catalog = deferred<{
      models: string[];
      permissionModes: PermissionMode[];
    }>();
    const codex = agent("codex", "Codex", "available", ["first-model"]);
    codex.projectCatalogs = { "project-1": codex.catalog };
    render(<App api={fakeApi({
      agents: [codex],
      pickProject: async () => ({
        id: "project-new",
        path: "/tmp/new-project",
        name: "New Project",
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z",
      }),
      loadAgentCatalog: async () => catalog.promise,
    })} />);

    await user.click(await screen.findByRole("button", { name: "Open Project Folder" }));
    await user.click(screen.getByRole("button", { name: "Main Conversation" }));
    await act(async () => catalog.resolve({
      models: ["new-model"],
      permissionModes: ["request_approval"],
    }));

    expect(screen.getByRole("heading", { name: "Main Conversation" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Ain One" })).toHaveAttribute("data-active", "true");
  });

  it("leaves the selected Graph when opening another Project", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const initial = await api.loadWorkspace();
    const graph = {
      id: "graph-1", projectId: "project-1", name: "Current graph", description: "",
      definition: { nodes: [], edges: [], start: [], end: [] },
      viewport: { x: 0, y: 0, zoom: 1 }, positions: {},
      createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
    };
    api.loadWorkspace = vi.fn(async () => ({ ...initial, graphs: [graph] }));
    api.getGraph = vi.fn(async () => ({ graph, latestRun: null }));
    api.pickProject = vi.fn(async () => ({
      id: "project-new", path: "/tmp/new-project", name: "New Project",
      createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
    }));
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Current graph" }));
    expect(await screen.findByTestId("graph-canvas")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Open Project Folder" }));

    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeVisible();
    expect(screen.queryByTestId("graph-canvas")).not.toBeInTheDocument();
  });

  it("opens the portable Graph configuration from the Graph toolbar", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const initial = await api.loadWorkspace();
    const graph = {
      id: "graph-1", projectId: "project-1", name: "Current graph", description: "",
      definition: { nodes: [], edges: [], start: [], end: [] },
      viewport: { x: 0, y: 0, zoom: 1 }, positions: {},
      createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
    };
    api.loadWorkspace = vi.fn(async () => ({ ...initial, graphs: [graph] }));
    api.getGraph = vi.fn(async () => ({ graph, latestRun: null }));
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Current graph" }));
    await user.click(await screen.findByRole("button", { name: "Latest run" }));
    await user.click(await screen.findByRole("button", { name: "Open Graph configuration" }));

    expect(screen.getByRole("dialog", { name: "Graph configuration" })).toBeVisible();
    expect(screen.queryByText("Runnable")).toBeNull();
    expect(screen.queryByText("Incomplete")).toBeNull();
  });

  it("opens a new Conversation draft when the selected Project has no Conversations", async () => {
    const api = fakeApi();
    const workspace = await api.loadWorkspace();
    api.loadWorkspace = async () => ({
      ...workspace,
      conversations: [],
      selectedConversationId: null,
      conversation: null,
    });

    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeVisible();
    expect(screen.getByLabelText("Message")).toBeVisible();
    expect(screen.queryByText("Create a conversation to start.")).toBeNull();
  });

  it("keeps the new Conversation draft visible when the local Agent is unavailable", async () => {
    const api = fakeApi({ agents: [agent("codex", "Codex", "not_installed")] });
    const workspace = await api.loadWorkspace();
    api.loadWorkspace = async () => ({
      ...workspace,
      conversations: [],
      selectedConversationId: null,
      conversation: null,
    });

    render(<App api={api} />);

    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeVisible();
    expect(screen.getByLabelText("Message")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.queryByText("Create a conversation to start.")).toBeNull();
  });

  it("shows an import action in the main empty state when no Project exists", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const workspace = await api.loadWorkspace();
    const pickProject = vi.fn(async () => null);
    api.pickProject = pickProject;
    api.loadWorkspace = async () => ({
      ...workspace,
      projects: [],
      selectedProjectId: null,
      conversations: [],
      selectedConversationId: null,
      conversation: null,
    });

    render(<App api={api} />);

    expect(await screen.findByText("Import a project to start a conversation.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Import project" }));
    expect(pickProject).toHaveBeenCalledOnce();
  });

  it("shows progress while the native Project folder picker is open", async () => {
    const user = userEvent.setup();
    const picked = deferred<Project | null>();
    render(<App api={fakeApi({ pickProject: async () => picked.promise })} />);

    const button = await screen.findByRole("button", { name: "Open Project Folder" });
    await user.click(button);

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Opening…")).toBeVisible();
    await act(async () => picked.resolve(null));
  });

  it("keeps the current workspace when the native folder picker is cancelled", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ pickProject: async () => null });
    const loadWorkspace = vi.spyOn(api, "loadWorkspace");
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Open Project Folder" }));

    expect(loadWorkspace).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Ain One" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("adds and selects a newly created Conversation without reloading the workspace", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const initial = await api.loadWorkspace();
    const created: Conversation = {
      id: "conv-new",
      projectId: "project-1",
      title: "New Conversation",
      agentProductId: "codex",
      modelId: "gpt-5",
      permissionMode: "request_approval",
      queuePaused: false,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    };
    api.createConversation = (async () => created) as unknown as AinOneApi["createConversation"];
    api.loadWorkspace = vi.fn().mockResolvedValue(initial);
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: /New chat/ }));
    await user.type(screen.getByLabelText("Message"), "start");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    const sidebar = await screen.findByRole("navigation", { name: "Projects and conversations" });
    expect(within(sidebar).getByText("New Conversation").closest("button")).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(api.loadWorkspace).toHaveBeenCalledOnce();
  });

  it("keeps a newly created Conversation selected across a background terminal refresh", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const initial = await api.loadWorkspace();
    const created: Conversation = {
      id: "conv-new",
      projectId: "project-1",
      title: "New Conversation",
      agentProductId: "codex",
      modelId: "gpt-5",
      permissionMode: "request_approval",
      queuePaused: false,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const terminalRefresh = deferred<ConversationView>();
    let onEvent: (event: ConversationView["events"][number]) => void = () => undefined;
    api.createConversation = async () => created;
    api.loadWorkspace = vi.fn().mockResolvedValue(initial);
    api.loadConversation = vi.fn(async () => terminalRefresh.promise);
    api.subscribeConversationEvents = (_conversationId, _afterSequence, callback) => {
      onEvent = callback;
      return () => undefined;
    };
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: /New chat/ }));
    await user.type(screen.getByLabelText("Message"), "start");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(api.loadWorkspace).toHaveBeenCalledOnce();
    onEvent({
      id: "event-background-terminal",
      conversationId: "conv-1",
      sequence: 1,
      type: "turn_status",
      payload: { turnId: "turn-background", status: "completed" },
      createdAt: "2026-08-24T00:00:00.000Z",
    });
    await vi.waitFor(() => expect(api.loadConversation).toHaveBeenCalledWith("conv-1"));

    await act(async () => terminalRefresh.resolve({
      ...initial.conversation!,
      activeTurnStatus: null,
      latestTurnStatus: "completed",
      hydrated: true,
    }));
    expect(await screen.findByRole("button", { name: "New Conversation" })).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("submits Conversation creation only once while the request is in flight", async () => {
    const user = userEvent.setup();
    const created = deferred<Conversation>();
    const createConversation = vi.fn(async () => created.promise);
    render(<App api={fakeApi({ createConversation })} />);

    await user.click(await screen.findByRole("button", { name: /New chat/ }));
    await user.type(screen.getByLabelText("Message"), "start");
    const sendButton = screen.getByRole("button", { name: "Send message" });
    await user.click(sendButton);
    await user.click(sendButton);

    expect(createConversation).toHaveBeenCalledOnce();
    expect(sendButton).toBeDisabled();
  });

  it("shows Conversation creation failures without an unhandled rejection", async () => {
    const user = userEvent.setup();
    const createConversation = vi.fn(async () => {
      throw new Error("creation unavailable");
    });
    render(<App api={fakeApi({ createConversation })} />);

    await user.click(await screen.findByRole("button", { name: /New chat/ }));
    await user.type(screen.getByLabelText("Message"), "start");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not create Conversation: creation unavailable",
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("surfaces Project rename failures from the sidebar", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi({ renameProject: async () => {
      throw new Error("rename unavailable");
    } })} />);

    await user.click(await screen.findByRole("button", { name: "Manage project Ain One" }));
    await user.click(screen.getByRole("button", { name: "Rename project" }));
    const dialog = screen.getByRole("dialog", { name: "Rename project" });
    const input = within(dialog).getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Renamed project");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("rename unavailable");
    expect(screen.getByRole("button", { name: "Ain One" })).toBeVisible();
  });

  it("surfaces Conversation branch failures from the message actions", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi({
      includeAllEventTypes: true,
      forkConversation: async () => { throw new Error("branch unavailable"); },
    })} />);

    await user.click(await screen.findByRole("button", { name: "Branch conversation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("branch unavailable");
  });

  it("adds and selects a branched Conversation without reloading the workspace", async () => {
    const user = userEvent.setup();
    const api = fakeApi({ includeAllEventTypes: true, forkConversation: async () => ({ ...conversationDto("conv-branch", null), title: "Main Conversation (branch)" }) });
    const loadWorkspace = vi.spyOn(api, "loadWorkspace");
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Branch conversation" }));

    expect(await screen.findByRole("button", { name: "Main Conversation (branch)" })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("heading", { name: "Main Conversation (branch)" })).toBeVisible();
    expect(loadWorkspace).toHaveBeenCalledOnce();
  });

  it("surfaces archived Conversation restore failures", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi({
      archiveConversation: async () => { throw new Error("restore unavailable"); },
      loadArchived: async () => ({
        projects: [],
        conversations: [{
          id: "archived-conversation",
          projectId: "project-1",
          title: "Archived conversation",
          agentProductId: "codex",
          modelId: null,
          permissionMode: "request_approval",
          queuePaused: false,
          archivedAt: "2026-08-24T00:00:00.000Z",
          createdAt: "2026-08-23T00:00:00.000Z",
          updatedAt: "2026-08-24T00:00:00.000Z",
        }],
      }),
    })} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Archived" }));
    await user.click(await screen.findByRole("button", { name: "Restore" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("restore unavailable");
  });

  it("keeps the workspace refresh error after a successful archive", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const initial = await api.loadWorkspace();
    api.loadWorkspace = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Manage conversation Main Conversation" }));
    await user.click(screen.getByRole("button", { name: "Archive conversation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("refresh unavailable");
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
    api.pickAgentExecutable = async (agentId) => `/tmp/${agentId}`;
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Agent" }));
    await user.click(screen.getByRole("button", { name: "Import another Codex path" }));
    await user.click(screen.getByRole("button", { name: "Import another Claude Code path" }));
    await vi.waitFor(() => expect(api.loadWorkspace).toHaveBeenCalledTimes(3));

    second.resolve(newer);
    expect(await screen.findByRole("button", { name: "Newer Project" })).toBeVisible();
    first.resolve(older);
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Older Project" })).toBeNull());
    expect(screen.getByRole("button", { name: "Newer Project" })).toBeVisible();
  });

  it("serializes executable path saves for the same Agent so the newest value wins", async () => {
    const user = userEvent.setup();
    const firstSave = deferred<void>();
    const updateAgentExecutablePath = vi.fn(async (_agentId, executablePath) => {
      if (executablePath === "/old/codex") {
        await firstSave.promise;
      }
    });
    const api = fakeApi({
      agents: [agent("codex", "Codex", "available")],
      updateAgentExecutablePath,
    });
    api.pickAgentExecutable = vi.fn()
      .mockResolvedValueOnce("/old/codex")
      .mockResolvedValueOnce("/new/codex");
    render(
      <App
        api={api}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Agent" }));
    await user.click(screen.getByRole("button", { name: "Import another Codex path" }));
    await user.click(screen.getByRole("button", { name: "Import another Codex path" }));

    expect(updateAgentExecutablePath).toHaveBeenCalledOnce();
    firstSave.resolve();
    await vi.waitFor(() => expect(updateAgentExecutablePath).toHaveBeenCalledTimes(2));
    expect(updateAgentExecutablePath).toHaveBeenNthCalledWith(2, "codex", "/new/codex");
  });

  it("reports an Agent executable picker failure", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.pickAgentExecutable = async () => {
      throw new Error("picker unavailable");
    };
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Agent" }));
    await user.click(screen.getByRole("button", { name: "Import another Codex path" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not select Agent executable: picker unavailable",
    );
  });

  it("reports a plugin path picker failure", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.pickLocalPath = async () => {
      throw new Error("picker unavailable");
    };
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Plugins" }));
    await user.click(screen.getByRole("button", { name: "Add Skill" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not select plugin path: picker unavailable",
    );
  });

  it("does not let an in-flight workspace refresh overwrite newer local Conversation state", async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      initialQueuedMessages: ["keep deleted"],
      agents: [agent("codex", "Codex", "available")],
    });
    const initial = await api.loadWorkspace();
    const staleRefresh = deferred<WorkspaceState>();
    let onEvent: (event: ConversationView["events"][number]) => void = () => undefined;
    api.loadWorkspace = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(async () => staleRefresh.promise);
    api.subscribeConversationEvents = (_conversationId, _afterSequence, callback) => {
      onEvent = callback;
      return () => undefined;
    };
    api.pickAgentExecutable = async () => "/tmp/codex";
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Agent" }));
    await user.click(screen.getByRole("button", { name: "Import another Codex path" }));
    await vi.waitFor(() => expect(api.loadWorkspace).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Close Settings" }));
    await chooseModel(user, "gpt-5-mini");
    await user.click(
      screen.getByRole("button", { name: "Delete pending message 1: keep deleted" }),
    );
    onEvent({
      id: "event-newer-running",
      conversationId: "conv-1",
      sequence: 1,
      type: "turn_status",
      payload: { turnId: "turn-newer", status: "running" },
      createdAt: "2026-08-24T00:00:00.000Z",
    });
    expect(await screen.findByRole("button", { name: "Stop" })).toBeVisible();

    await act(async () => staleRefresh.resolve(initial));

    expect(screen.getByLabelText("Model")).toHaveTextContent("gpt-5-mini");
    expect(screen.queryByText("keep deleted")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
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
    expect(projectDrawer).toHaveAttribute("inert");
    expect(projectDrawer).toHaveAttribute("aria-hidden", "true");
  });

  it("uses shrinkable columns between 961px and 1139px", () => {
    const css = readFileSync("src/web/styles.css", "utf8");

    expect(css).toContain("@media (min-width: 961px) and (max-width: 1139px)");
    expect(css).toContain("grid-template-columns: 224px minmax(0, 1fr);");
    expect(css).toMatch(/\.workspace__center\s*\{[^}]*min-width:\s*0;/s);
  });

  it("uses the approved DSH visual tokens and settings geometry", () => {
    const css = readFileSync("src/web/styles.css", "utf8");

    expect(css).toContain("--accent: #4d6bfe;");
    expect(css).toContain("-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\"");
    expect(css).toContain("--background: #f4f8fc;");
    expect(css).toContain("grid-template-columns: 280px minmax(480px, 1fr);");
    expect(css).toMatch(/\.app-settings__dialog\s*\{[^}]*width:\s*min\(960px,/s);
    expect(css).toMatch(/\.app-settings__dialog\s*\{[^}]*height:\s*min\(720px,/s);
    expect(css).toMatch(/\.app-settings__dialog\s*\{[^}]*border-radius:\s*20px;/s);
    expect(css).toMatch(/\.app-settings__nav\s*\{[^}]*width:\s*188px;/s);
    expect(css).not.toMatch(/background:\s*#fafdff|background:\s*#edf4fb|background:\s*#f8fbfe/);
  });

  it("renders all normalized event types in timeline", async () => {
    render(<App api={fakeApi({ includeAllEventTypes: true })} />);

    const conversationCanvas = await screen.findByTestId("conversation-canvas");
    expect(await within(conversationCanvas).findByText("Assistant says hi")).toBeVisible();
    expect(within(conversationCanvas).getByText("User sent hello")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Expand activity" }));
    expect(within(conversationCanvas).getByText("Thought summary")).toBeVisible();
    expect(within(conversationCanvas).getByText("list_files")).toBeVisible();
    expect(within(conversationCanvas).getByText("pnpm test")).toBeVisible();
    expect(within(conversationCanvas).getByText("src/web/app.tsx")).toBeVisible();
    expect(within(conversationCanvas).getByText("Write outside workspace")).toBeVisible();
    expect(within(conversationCanvas).getByText("33 tokens")).toBeVisible();
    expect(within(conversationCanvas).getByText("Rate limit near cap")).toBeVisible();
    expect(within(conversationCanvas).getByText("Ended: failed")).toBeVisible();
    expect(within(conversationCanvas).getByText("Spawn failed")).toBeVisible();
  });

  it("deletes a pending message", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi({ initialQueuedMessages: ["delete me"] })} />);

    expect(await screen.findByText("delete me")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Delete pending message 1: delete me" }));
    expect(screen.queryByText("delete me")).toBeNull();
  });

  it("applies a delayed pending-message deletion to its original Conversation", async () => {
    const user = userEvent.setup();
    const deletion = deferred<void>();
    render(
      <App
        api={fakeApi({
          twoProjects: true,
          initialQueuedMessages: ["shared pending"],
          deletePendingMessage: async () => deletion.promise,
        })}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Delete pending message 1: shared pending" }),
    );
    await user.click(screen.getByText("Conversation Two").closest("button")!);
    await act(async () => deletion.resolve());

    expect(screen.getByText("shared pending")).toBeVisible();
    await user.click(screen.getByText("Main Conversation").closest("button")!);
    expect(screen.queryByText("shared pending")).toBeNull();
  });

  it("gives every pending-message Delete button a unique accessible name", async () => {
    render(<App api={fakeApi({ initialQueuedMessages: ["duplicate", "duplicate"] })} />);

    expect(
      await screen.findByRole("button", { name: "Delete pending message 1: duplicate" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Delete pending message 2: duplicate" }),
    ).toBeVisible();
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

    expect((await screen.findByRole("heading", { name: "Main Conversation" })).parentElement?.querySelector(".agent-badge")).toHaveTextContent("Codex");
    expect(screen.queryByLabelText("Agent product")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Permission mode" }));
    expect(screen.getByRole("menuitemradio", { name: "Ask for approval" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "Full access" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio", { name: "Auto approve" })).toBeNull();
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

  it("chooses an Agent only while composing a new Conversation", async () => {
    const user = userEvent.setup();
    const queueMessage = vi.fn(async () => undefined);
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
          queueMessage,
          agents: [
            agent("codex", "Codex", "authentication_required"),
            agent("claude", "Claude Code", "capability_limited", ["sonnet"]),
            agent("trae", "Trae", "runtime_error"),
          ],
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /New chat/ }));
    expect(createConversation).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("menuitemradio", { name: "Codex" })).toBeVisible();
    await user.click(screen.getByRole("menuitemradio", { name: "Claude Code" }));
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("sonnet");
    await user.type(screen.getByLabelText("Message"), "start with Claude");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ agentProductId: "claude", modelId: "sonnet" }),
    );
    expect(queueMessage).toHaveBeenCalledWith("conv-2", "start with Claude");
    expect(screen.getByRole("button", { name: "Agent" })).toBeDisabled();
  });

  it("persists model changes from the composer", async () => {
    const user = userEvent.setup();
    const updateConversationSettings = vi.fn(async () => undefined);
    render(<App api={fakeApi({ updateConversationSettings })} />);

    await chooseModel(user, "gpt-5-mini");

    expect(updateConversationSettings).toHaveBeenCalledWith("conv-1", {
      modelId: "gpt-5-mini",
      permissionMode: "request_approval",
    });
  });

  it("serializes model and permission writes through one queue", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const second = deferred<void>();
    const updateConversationSettings = vi
      .fn<AinOneApi["updateConversationSettings"]>()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    render(<App api={fakeApi({ updateConversationSettings })} />);

    await chooseModel(user, "gpt-5-mini");
    await user.click(screen.getByRole("button", { name: "Permission mode" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Full access" }));

    expect(updateConversationSettings).toHaveBeenCalledTimes(1);
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
    second.resolve();
    await second.promise;
  });

  it("waits for every queued configuration write before sending a message", async () => {
    const user = userEvent.setup();
    const settingsWrite = deferred<void>();
    const updateConversationSettings = vi.fn(async () => settingsWrite.promise);
    const queueMessage = vi.fn(async () => undefined);
    render(<App api={fakeApi({ updateConversationSettings, queueMessage })} />);

    await chooseModel(user, "gpt-5-mini");
    await user.type(screen.getByLabelText("Message"), "use current settings");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(queueMessage).not.toHaveBeenCalled();
    settingsWrite.resolve();
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

    await chooseModel(user, "gpt-5-mini");
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

  it("keeps the draft and does not send when a global Plugin write fails", async () => {
    const user = userEvent.setup();
    const setPluginEnablements = vi.fn(async () => {
      throw new Error("plugin settings unavailable");
    });
    const queueMessage = vi.fn(async () => undefined);
    render(<App api={fakeApi({
      setPluginEnablements,
      queueMessage,
      installedPlugins: [plugin("formatter@v2", "formatter", "v2")],
    })} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    await user.click(screen.getByRole("checkbox", { name: "Enable formatter" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("plugin settings unavailable");
    await user.click(screen.getByRole("button", { name: "Close Settings" }));

    const message = screen.getByLabelText("Message");
    await user.type(message, "keep after plugin failure");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(queueMessage).not.toHaveBeenCalled();
    expect(message).toHaveValue("keep after plugin failure");
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

    await chooseModel(user, "gpt-5-mini");
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

  it("does not let one Conversation's pending settings write block another Conversation", async () => {
    const user = userEvent.setup();
    const firstConversationWrite = deferred<void>();
    const updateConversationSettings = vi.fn(async (conversationId: string) => {
      if (conversationId === "conv-1") {
        await firstConversationWrite.promise;
      }
    });
    const queueMessage = vi.fn(async () => undefined);
    render(
      <App
        api={fakeApi({ twoProjects: true, updateConversationSettings, queueMessage })}
      />,
    );

    await chooseModel(user, "gpt-5-mini");
    await user.click(screen.getByRole("button", { name: "Conversation Two" }));
    await user.type(screen.getByLabelText("Message"), "send while one is pending");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await vi.waitFor(() =>
      expect(queueMessage).toHaveBeenCalledWith("conv-2", "send while one is pending"),
    );
    firstConversationWrite.resolve();
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

    await chooseModel(user, "gpt-5-mini");
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

    await chooseModel(user, "gpt-5-mini");
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

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    await user.click(screen.getByRole("checkbox", { name: "Enable formatter" }));
    await user.click(screen.getByRole("checkbox", { name: "Enable reviewer" }));

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

  it("changes future Plugin enablements while a Turn is active", async () => {
    const user = userEvent.setup();
    const setPluginEnablements = vi.fn(async () => undefined);
    render(<App api={fakeApi({
      activeTurn: true,
      setPluginEnablements,
      installedPlugins: [plugin("formatter@v2", "formatter", "v2")],
    })} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    const toggle = screen.getByRole("checkbox", { name: "Enable formatter" });
    expect(toggle).toBeEnabled();
    await user.click(toggle);
    await vi.waitFor(() => expect(setPluginEnablements).toHaveBeenCalledWith(
      { type: "global" },
      [{ pluginId: "formatter", versionId: "v2" }],
    ));
  });

  it("reconciles the latest same-scope Plugin state after an earlier write fails", async () => {
    const user = userEvent.setup();
    const first = deferred<void>();
    const second = deferred<void>();
    let persisted: Array<{ pluginId: string; versionId: string }> = [];
    const setPluginEnablements = vi
      .fn<AinOneApi["setPluginEnablements"]>()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async (_scope, versions) => {
        await second.promise;
        persisted = versions;
      });
    render(<App api={fakeApi({
      installedPlugins: [
        plugin("formatter@v2", "formatter", "v2"),
        plugin("reviewer@v1", "reviewer", "v1"),
      ],
      getPluginEnablements: async () => persisted,
      setPluginEnablements,
    })} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    await user.click(screen.getByRole("checkbox", { name: "Enable formatter" }));
    await user.click(screen.getByRole("checkbox", { name: "Enable reviewer" }));
    first.reject(new Error("first write failed"));
    await vi.waitFor(() => expect(setPluginEnablements).toHaveBeenCalledTimes(2));
    second.resolve();

    await vi.waitFor(() => {
      expect(screen.getByRole("checkbox", { name: "Enable formatter" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Enable reviewer" })).toBeChecked();
    });
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

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    await user.selectOptions(screen.getByLabelText("Plugin scope"), "project");

    expect(screen.getByRole("checkbox", { name: "Enable formatter" })).toBeDisabled();
    expect(setPluginEnablements).not.toHaveBeenCalled();

    projectEnablements.resolve([{ pluginId: "formatter", versionId: "v2" }]);
    await vi.waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Enable formatter" })).toBeChecked(),
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

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("enablements unavailable");

    const checkbox = screen.getByRole("checkbox", { name: "Enable formatter" });
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

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    await user.click(screen.getByRole("checkbox", { name: "Enable formatter" }));
    await user.selectOptions(screen.getByLabelText("Plugin scope"), "project");
    await vi.waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Enable reviewer" })).toBeChecked(),
    );

    globalWrite.reject(new Error("global write failed"));
    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeVisible());
    expect(screen.getByRole("checkbox", { name: "Enable reviewer" })).toBeChecked();
  });

  it("keeps only one enabled version of a plugin", async () => {
    const user = userEvent.setup();
    const setPluginEnablements = vi.fn(async () => undefined);
    render(
      <App
        api={fakeApi({
          setPluginEnablements,
          installedPlugins: [
            plugin("formatter@v1", "formatter", "v1", "skill", "1.0.0"),
            plugin("formatter@v2", "formatter", "v2", "skill", "2.0.0"),
          ],
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    expect(screen.getAllByText("formatter")).toHaveLength(1);
    expect(screen.getByText("2.0.0")).toBeVisible();
    expect(screen.queryByText("1.0.0")).toBeNull();
    expect(screen.queryByRole("combobox", { name: /Version for formatter/ })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Enable formatter" }));

    await vi.waitFor(() => expect(setPluginEnablements).toHaveBeenCalledTimes(1));
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

  it("opens Agent and Plugin settings from the single bottom Settings entry", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} />);

    const settingsButtons = await screen.findAllByRole("button", { name: "Settings" });
    expect(settingsButtons).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Agent Settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Plugin Settings" })).toBeNull();

    await user.click(settingsButtons[0]!);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "General settings" })).toBeVisible();

    await user.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("heading", { name: "Agent Products" })).toBeVisible();
    expect(screen.getByTestId("conversation-canvas")).toBeInTheDocument();
    expect(screen.queryByTestId("graph-canvas")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Plugins" }));
    expect(screen.getByRole("heading", { name: "Plugins" })).toBeVisible();
  });

  it("uses readable icons for workspace search and project creation", async () => {
    render(<App api={fakeApi()} />);

    expect((await screen.findByRole("button", { name: "Search projects" })).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Open Project Folder" }).querySelector("svg")).not.toBeNull();
  });

  it("closes Settings when clicking its backdrop", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await user.pointer({ keys: "[MouseLeft]", target: screen.getByRole("button", { name: "Dismiss Settings" }) });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });

  it("switches the workspace language and persists the preference", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.selectOptions(screen.getByLabelText("Language"), "zh");

    expect(globalThis.localStorage.getItem("ain-one:language")).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(screen.getByRole("dialog", { name: "设置" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "通用设置" })).toBeVisible();
    expect(screen.getByRole("button", { name: /新对话/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "项目" })).toBeVisible();
    expect(screen.getByRole("button", { name: "对话" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Main Conversation" }).parentElement?.querySelector(".agent-badge")).toHaveTextContent("Codex");

    await user.click(within(screen.getByRole("navigation", { name: "设置分类" })).getByRole("button", { name: "Agent" }));
    expect(screen.getByRole("heading", { name: "Agent 设置" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "插件" }));
    expect(screen.getByRole("heading", { name: "插件" })).toBeVisible();
  });

  it("uses the preferred default permission for new conversations when supported", async () => {
    const user = userEvent.setup();
    const createConversation = vi.fn(async () => ({
      id: "created",
      projectId: "project-1",
      agentProductId: "codex" as const,
      modelId: null,
      permissionMode: "full_access" as const,
      queuePaused: false,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    }));
    render(<App api={fakeApi({ createConversation })} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.selectOptions(screen.getByLabelText("Default permission mode"), "full_access");
    await user.click(screen.getByRole("button", { name: "Close Settings" }));
    await user.click(screen.getByRole("button", { name: /New chat/ }));
    await user.type(screen.getByLabelText("Message"), "start");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "full_access" }),
    );
  });

  it("applies appearance and blocks busy Enter while analyzing", async () => {
    const user = userEvent.setup();
    const queueMessage = vi.fn(async () => undefined);
    render(<App api={fakeApi({ activeTurn: true, queueMessage })} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(globalThis.localStorage.getItem("ain-one:appearance")).toBe("dark");
    await user.click(screen.getByRole("button", { name: "Close Settings" }));

    const message = screen.getByLabelText("Message");
    await user.type(message, "next task{enter}");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("keeps Graph parallel to Chat instead of exposing it as a Chat canvas tab", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} />);

    expect(await screen.findByRole("button", { name: "Conversation" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Trajectory" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Graph" })).not.toBeInTheDocument();
    expect(screen.getByTestId("conversation-canvas")).toBeInTheDocument();
    expect(screen.getByTestId("trajectory-canvas")).toBeInTheDocument();
    expect(screen.queryByTestId("graph-canvas")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Trajectory" }));
    expect(within(screen.getByTestId("trajectory-canvas")).getByRole("region", { name: "Trajectory timeline" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New graph" })).toBeVisible();
  });

  it("creates one Graph per click sequence and does not override a later Chat selection", async () => {
    const user = userEvent.setup();
    const created = deferred<Awaited<ReturnType<AinOneApi["createGraph"]>>>();
    const api = fakeApi();
    api.createGraph = vi.fn(async () => created.promise);
    render(<App api={api} />);

    const create = await screen.findByRole("button", { name: "New graph" });
    await user.dblClick(create);
    expect(api.createGraph).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Main Conversation" }));
    created.resolve({
      id: "graph-late", projectId: "project-1", name: "Late graph", description: "",
      definition: { nodes: [], edges: [], start: [], end: [] }, viewport: { x: 0, y: 0, zoom: 1 }, positions: {},
      createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z",
    });

    expect(await screen.findByRole("button", { name: "Late graph" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Main Conversation" })).toBeVisible();
  });

  it("collapses and restores the desktop sidebar", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} />);

    const sidebar = (await screen.findByLabelText("Projects and conversations")).closest(
      ".workspace__left",
    );
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("button", { name: "New chat" })).toHaveTextContent(/^＋$/);
    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(sidebar).toHaveAttribute("data-collapsed", "false");
  });

  it("collapses and expands a Project's Conversation list from its name", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} />);

    const project = await screen.findByRole("button", { name: "Ain One" });
    expect(project).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Main Conversation" })).toBeVisible();

    await user.click(project);
    expect(project).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Main Conversation" })).toBeNull();

    await user.click(project);
    expect(project).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Main Conversation" })).toBeVisible();
  });

  it("places Archived after Plugins in settings navigation", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} />);
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "General", "Agent", "Plugins", "Archived",
    ]);
    expect(within(nav).getByRole("button", { name: "Archived" })).toHaveClass(
      "app-settings__nav-item",
    );
  });

  it("closes project and conversation menus when clicking outside them", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} />);

    await user.click(await screen.findByRole("button", { name: "Manage project Ain One" }));
    expect(screen.getByRole("button", { name: "Archive project" })).toBeVisible();
    await user.click(screen.getByRole("heading", { name: "Projects" }));
    expect(screen.queryByRole("button", { name: "Archive project" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Manage conversation Main Conversation" }));
    expect(screen.getByRole("button", { name: "Archive conversation" })).toBeVisible();
    await user.click(screen.getByTestId("conversation-canvas"));
    expect(screen.queryByRole("button", { name: "Archive conversation" })).toBeNull();
  });

  it("removes an archived Conversation immediately after a successful action", async () => {
    const user = userEvent.setup();
    const archiveConversation = vi.fn(async (id: string, archived: boolean) => conversationDto(id, archived ? new Date().toISOString() : null));
    render(<App api={fakeApi({ archiveConversation })} />);
    await user.click(await screen.findByRole("button", { name: /Manage conversation Main Conversation/ }));
    await user.click(screen.getByRole("button", { name: "Archive conversation" }));
    expect(archiveConversation).toHaveBeenCalledWith("conv-1", true);
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Main Conversation" })).toBeNull());
  });

  it("permanently deletes an archived Conversation from Archived settings", async () => {
    const user = userEvent.setup();
    const deleteArchivedConversation = vi.fn(async () => undefined);
    render(<App api={fakeApi({
      loadArchived: async () => ({
        projects: [],
        conversations: [conversationDto("archived-conversation", "2026-08-24T00:00:00.000Z")],
      }),
      deleteArchivedConversation,
    })} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Archived" }));
    await user.click(await screen.findByRole("button", { name: "Delete Main Conversation permanently" }));
    await user.click(screen.getByRole("button", { name: "Confirm permanent deletion" }));
    expect(deleteArchivedConversation).toHaveBeenCalledWith("archived-conversation");
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Delete Main Conversation permanently" })).toBeNull());
  });

  it("separates Skills and MCP inside Plugin settings", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi({
      installedPlugins: [
        plugin("reviewer@v1", "reviewer", "v1", "skill"),
        plugin("filesystem@v1", "filesystem", "v1", "mcp"),
      ],
    })} />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Plugins" }));
    expect(screen.getByText("reviewer")).toBeVisible();
    expect(screen.queryByText("filesystem")).toBeNull();
    await user.click(screen.getByRole("button", { name: "MCP" }));
    expect(screen.getByText("filesystem")).toBeVisible();
    expect(screen.queryByText("reviewer")).toBeNull();
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
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Agent" }));

    expect(
      within(screen.getByRole("region", { name: "Codex catalog models" })).getByText(
        "second-model",
      ),
    ).toBeVisible();
    expect(screen.queryByText("first-model")).toBeNull();
  });

  it("loads the selected Project catalog before composing a new Conversation", async () => {
    const user = userEvent.setup();
    const loadAgentCatalog = vi.fn(async () => ({
      models: ["second-model"],
      permissionModes: ["full_access" as const],
    }));
    const codex = agent("codex", "Codex", "available", ["first-model"]);
    render(<App api={fakeApi({ twoProjects: true, agents: [codex], loadAgentCatalog })} />);

    await user.click(await screen.findByRole("button", { name: "Project Two" }));
    await user.click(screen.getByRole("button", { name: "New chat" }));

    expect(loadAgentCatalog).toHaveBeenCalledWith("codex", "project-2");
    await user.click(await screen.findByRole("button", { name: "Model" }));
    expect(screen.getByRole("menuitemradio", { name: "second-model" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio", { name: "first-model" })).toBeNull();
  });

  it("reloads the selected Project catalog after a workspace refresh replaces Agent summaries", async () => {
    const user = userEvent.setup();
    const codex = agent("codex", "Codex", "available", ["first-model"]);
    codex.projectCatalogs = { "project-1": codex.catalog };
    const loadAgentCatalog = vi.fn(async () => ({
      models: ["second-model"],
      permissionModes: ["full_access" as const],
    }));
    render(<App api={fakeApi({
      twoProjects: true,
      agents: [codex],
      loadAgentCatalog,
      restartWorkspace: async () => undefined,
    })} />);

    await user.click(await screen.findByRole("button", { name: "Project Two" }));
    await vi.waitFor(() => expect(loadAgentCatalog).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Restart project" }));

    await vi.waitFor(() => expect(loadAgentCatalog).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("menuitemradio", { name: "second-model" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio", { name: "first-model" })).toBeNull();
  });

  it("does not let a pending new Conversation selection replace a newer Project selection", async () => {
    const user = userEvent.setup();
    const catalog = deferred<{
      models: string[];
      permissionModes: PermissionMode[];
    }>();
    const codex = agent("codex", "Codex", "available", ["first-model"]);
    codex.projectCatalogs = { "project-1": codex.catalog };
    render(<App api={fakeApi({
      twoProjects: true,
      agents: [codex],
      loadAgentCatalog: async () => catalog.promise,
    })} />);

    await user.click(await screen.findByRole("button", { name: "Project Two" }));
    await user.click(screen.getByRole("button", { name: "New chat" }));
    await user.click(screen.getByRole("button", { name: "Project One" }));
    await act(async () => catalog.resolve({
      models: ["second-model"],
      permissionModes: ["request_approval"],
    }));

    expect(screen.getByRole("heading", { name: "Main Conversation" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Main Conversation" })).toHaveAttribute("data-active", "true");
  });

  it("reports a selected Project catalog failure without an unhandled rejection", async () => {
    const user = userEvent.setup();
    const codex = agent("codex", "Codex", "available", ["first-model"]);
    codex.projectCatalogs = {
      "project-1": codex.catalog,
    };
    render(<App api={fakeApi({
      twoProjects: true,
      agents: [codex],
      loadAgentCatalog: async () => {
        throw new Error("catalog unavailable");
      },
    })} />);

    await user.click(await screen.findByRole("button", { name: "Project Two" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load Agent catalog: catalog unavailable",
    );
    expect(screen.getByRole("button", { name: "New chat" })).toBeVisible();
  });

  it("retries a catalog response that reports a transient error", async () => {
    const user = userEvent.setup();
    const codex = agent("codex", "Codex", "available", ["first-model"]);
    codex.projectCatalogs = { "project-1": codex.catalog };
    const failedCatalog = deferred<{
      models: string[];
      permissionModes: PermissionMode[];
      error: string;
    }>();
    const loadAgentCatalog = vi.fn()
      .mockImplementationOnce(async () => failedCatalog.promise)
      .mockResolvedValueOnce({
        models: ["recovered-model"],
        permissionModes: ["request_approval" as const],
      });
    render(<App api={fakeApi({
      twoProjects: true,
      agents: [codex],
      loadAgentCatalog,
    })} />);

    await user.click(await screen.findByRole("button", { name: "Project Two" }));
    await vi.waitFor(() => expect(loadAgentCatalog).toHaveBeenCalledOnce());
    await act(async () => failedCatalog.resolve({
      models: [],
      permissionModes: [],
      error: "Could not load Agent catalog",
    }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(loadAgentCatalog).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Project One" }));
    await user.click(screen.getByRole("button", { name: "Project Two" }));

    await vi.waitFor(() => expect(loadAgentCatalog).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Agent" }));
    expect(within(screen.getByRole("region", { name: "Codex catalog models" })).getByText("recovered-model")).toBeVisible();
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
    restartWorkspace?: () => Promise<void>;
    queueError?: Error;
    twoProjects?: boolean;
    pickProject?: AinOneApi["pickProject"];
    createConversation?: AinOneApi["createConversation"];
    renameProject?: NonNullable<AinOneApi["renameProject"]>;
    archiveProject?: NonNullable<AinOneApi["archiveProject"]>;
    archiveConversation?: NonNullable<AinOneApi["archiveConversation"]>;
    deleteArchivedConversation?: NonNullable<AinOneApi["deleteArchivedConversation"]>;
    forkConversation?: NonNullable<AinOneApi["forkConversation"]>;
    loadArchived?: NonNullable<AinOneApi["loadArchived"]>;
    loadAgentCatalog?: NonNullable<AinOneApi["loadAgentCatalog"]>;
    queueMessage?: AinOneApi["queueMessage"];
    deletePendingMessage?: AinOneApi["deletePendingMessage"];
    updateConversationSettings?: AinOneApi["updateConversationSettings"];
    updateAgentExecutablePath?: AinOneApi["updateAgentExecutablePath"];
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
    loadAgentCatalog: input.loadAgentCatalog,
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
    async deletePendingMessage(conversationId, messageId) {
      await input.deletePendingMessage?.(conversationId, messageId);
      const index = queued.findIndex((message) => message.id === messageId);
      if (index >= 0) {
        queued.splice(index, 1);
      }
    },
    async resolveUncertainMessage() {
      return undefined;
    },
    async respondToPermission() {
      return undefined;
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
    async restartWorkspace() {
      await input.restartWorkspace?.();
    },
    async openProject(path) {
      return {
        id: "project-opened",
        path,
        name: path.split("/").at(-1) || path,
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:00.000Z",
      };
    },
    async pickProject() {
      return await input.pickProject?.() ?? null;
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
    async renameProject(projectId, name) {
      if (input.renameProject) return input.renameProject(projectId, name);
      return {
        id: projectId,
        path: "/tmp/ain-one",
        name,
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:00.000Z",
      };
    },
    async archiveProject(projectId, archived) {
      if (input.archiveProject) return input.archiveProject(projectId, archived);
      return {
        id: projectId,
        path: "/tmp/ain-one",
        name: "Ain One",
        archivedAt: archived ? new Date().toISOString() : null,
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
      };
    },
    async archiveConversation(conversationId, archived) {
      if (input.archiveConversation) return input.archiveConversation(conversationId, archived);
      return conversationDto(conversationId, archived ? new Date().toISOString() : null);
    },
    async deleteArchivedConversation(conversationId) {
      await input.deleteArchivedConversation?.(conversationId);
    },
    async forkConversation(conversationId) {
      if (input.forkConversation) return input.forkConversation(conversationId);
      return {
        ...conversationDto(`${conversationId}-branch`, null),
        title: `${conversation.title} (branch)`,
      };
    },
    async loadArchived() {
      return await input.loadArchived?.() ?? { projects: [], conversations: [] };
    },
    async updateConversationSettings(conversationId, settings) {
      await input.updateConversationSettings?.(conversationId, settings);
    },
    async updateAgentExecutablePath(agentProductId, executablePath) {
      await input.updateAgentExecutablePath?.(agentProductId, executablePath);
    },
    async installPlugin() {
      return undefined;
    },
    async refreshPluginImports() {
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
    async listGraphs() { return []; },
    async createGraph() { throw new Error("not used"); },
    async getGraph() { throw new Error("not used"); },
    async saveGraph() { throw new Error("not used"); },
    async deleteGraph() { return undefined; },
    async runGraph() { throw new Error("not used"); },
    async getGraphRun() { throw new Error("not used"); },
    async cancelGraphRun() { return false; },
  };
}

function conversationDto(id: string, archivedAt: string | null): Conversation {
  return {
    id,
    projectId: "project-1",
    title: "Main Conversation",
    agentProductId: "codex",
    modelId: "gpt-5",
    permissionMode: "request_approval",
    queuePaused: false,
    archivedAt,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function createWorkspaceState(input: {
  activeTurn: boolean;
  recoveryTurn?: Pick<ConversationView, "latestTurnId" | "latestTurnStatus">;
  includeAllEventTypes: boolean;
  initialQueuedMessages: string[];
  permissionModes?: PermissionMode[];
  twoProjects: boolean;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function chooseModel(user: ReturnType<typeof userEvent.setup>, model: string): Promise<void> {
  await user.click(await screen.findByRole("button", { name: "Model" }));
  await user.click(screen.getByRole("menuitemradio", { name: model }));
}

function plugin(
  id: string,
  pluginId: string,
  versionId: string,
  type: "skill" | "mcp" = "skill",
  version?: string,
): ConversationView["availablePlugins"][number] {
  return {
    id,
    pluginId,
    versionId,
    version,
    name: `${pluginId} ${versionId}`,
    type,
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
