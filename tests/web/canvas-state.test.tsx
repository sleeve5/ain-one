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

describe("mounted canvas behavior", () => {
  it("keeps both canvases mounted and preserves state while switching", async () => {
    const user = userEvent.setup();
    render(<App api={fakeApi()} />);

    await user.type(await screen.findByLabelText("Message"), "draft text");
    await user.click(screen.getByRole("button", { name: "Graph" }));

    const conversationCanvas = screen.getByTestId("conversation-canvas");
    const graphCanvas = screen.getByTestId("graph-canvas");
    const conversationContainer = conversationCanvas.closest(".workspace__canvas");
    const graphContainer = graphCanvas.closest(".workspace__canvas");
    expect(conversationCanvas).toBeInTheDocument();
    expect(graphCanvas).toBeInTheDocument();
    expect(conversationContainer).toHaveAttribute("hidden");
    expect(conversationContainer).toHaveAttribute("inert");
    expect(graphContainer).not.toHaveAttribute("hidden");

    await user.click(screen.getByRole("button", { name: "Conversation" }));
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
    async cancelActiveTurn() {
      return undefined;
    },
    async continueConversation() {
      return undefined;
    },
    async retryInterruptedTurn() {
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
    async acceptPluginCandidate() {
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
    async listProjectFiles() {
      return state.inspector;
    },
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

  const inspector: InspectorState = {
    currentPath: ".",
    selectedPath: "src/index.ts",
    files: [{ path: "src/index.ts", type: "file" }],
    preview: {
      path: "src/index.ts",
      language: "ts",
      content: "console.log('hi');",
    },
    gitStatus: {
      branch: "feature/ain-one-phase1",
      entries: [],
    },
    gitDiff: {
      path: "",
      content: "",
    },
  };

  return {
    projects: [{ id: "project-1", name: "Ain One", path: "/tmp/ain-one" }],
    selectedProjectId: "project-1",
    conversations: [conversation],
    selectedConversationId: "conv-1",
    conversation,
    inspector,
    agents: [],
    installedPlugins: [],
    pluginCandidates: [],
    pluginError: null,
  };
}
