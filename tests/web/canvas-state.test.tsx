import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/web/app.js";
import type {
  AinOneApi,
  ConversationView,
  WorkspaceState,
} from "../../src/web/api.js";

describe("mounted canvas behavior", () => {
  it("keeps the conversation canvas mounted and preserves its draft while opening a graph", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<App api={api} />);

    await user.type(await screen.findByLabelText("Message"), "draft text");
    await user.click(screen.getByRole("button", { name: "Review workflow" }));
    await vi.waitFor(() => expect(api.getGraph).toHaveBeenCalledWith("graph-1"));

    const conversationCanvas = screen.getByTestId("conversation-canvas");
    const graphCanvas = screen.getByTestId("graph-canvas");
    const conversationContainer = conversationCanvas.closest(".workspace__canvas");
    const graphContainer = graphCanvas.closest(".workspace__canvas");
    expect(conversationCanvas).toBeInTheDocument();
    expect(graphCanvas).toBeInTheDocument();
    expect(conversationContainer).toHaveAttribute("hidden");
    expect(conversationContainer).toHaveAttribute("inert");
    expect(graphContainer).not.toHaveAttribute("hidden");

    await user.click(screen.getByRole("button", { name: "Main Conversation" }));
    expect(screen.getByLabelText("Message")).toHaveValue("draft text");
    expect(graphContainer).toHaveAttribute("hidden");
    expect(graphContainer).toHaveAttribute("inert");
  });
});

function fakeApi(): AinOneApi {
  const state = createWorkspaceState();
  return {
    async loadWorkspace() {
      return state;
    },
    async queueMessage() {
      return undefined;
    },
    async deletePendingMessage() {
      return undefined;
    },
    async resolveUncertainMessage() {
      return undefined;
    },
    async cancelActiveTurn() {
      return undefined;
    },
    async continueConversation() {
      return undefined;
    },
    async retryInterruptedTurn() {
      return undefined;
    },
    async respondToPermission() {
      return undefined;
    },
    subscribeConversationEvents() {
      return () => undefined;
    },
    async openProject() {
      return {
        id: "project-2",
        path: "/tmp/project-2",
        name: "Project Two",
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:00.000Z",
      };
    },
    async pickProject() {
      return null;
    },
    async createConversation() {
      return {
        id: "conv-2",
        projectId: "project-1",
        agentProductId: "codex",
        modelId: "gpt-5",
        permissionMode: "request_approval",
        queuePaused: false,
        createdAt: "2026-08-23T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:00.000Z",
      };
    },
    async updateConversationSettings() {
      return undefined;
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
    async repairPluginMaterialization() {
      return undefined;
    },
    async getPluginEnablements() {
      return [];
    },
    async setPluginEnablements() {
      return undefined;
    },
    listGraphs: vi.fn(async () => []),
    async createGraph() { throw new Error("not used"); },
    getGraph: vi.fn(async () => ({
      graph: createWorkspaceState().graphs![0]!,
      latestRun: null,
    })),
    async saveGraph() { throw new Error("not used"); },
    async deleteGraph() { return undefined; },
    async runGraph() { throw new Error("not used"); },
    async getGraphRun() { throw new Error("not used"); },
    async cancelGraphRun() { return false; },
  };
}

function createWorkspaceState(): WorkspaceState {
  const conversation: ConversationView = {
    id: "conv-1",
    projectId: "project-1",
    title: "Main Conversation",
    agentProductId: "codex",
    agentProductLabel: "Codex",
    modelId: "gpt-5",
    permissionMode: "request_approval",
    availableModels: ["gpt-5"],
    availablePermissionModes: ["request_approval", "full_access"],
    enabledPluginIds: [],
    availablePlugins: [],
    activeTurnStatus: null,
    latestTurnId: "turn-completed",
    latestTurnStatus: "completed",
    queuePaused: false,
    queuedMessages: [],
    events: [],
  };

  return {
    projects: [{ id: "project-1", name: "Ain One", path: "/tmp/ain-one" }],
    graphs: [{
      id: "graph-1",
      projectId: "project-1",
      name: "Review workflow",
      description: "",
      definition: { nodes: [], edges: [], start: [], end: [] },
      viewport: { x: 0, y: 0, zoom: 1 },
      positions: {},
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    }],
    selectedProjectId: "project-1",
    conversations: [conversation],
    selectedConversationId: "conv-1",
    conversation,
    agents: [],
    installedPlugins: [],
    pluginError: null,
  };
}
