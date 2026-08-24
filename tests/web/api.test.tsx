import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../../src/shared/contracts.js";
import {
  createHttpAinOneApi,
  type ConversationView,
} from "../../src/web/api.js";
import { applyConversationEvent } from "../../src/web/store.js";

describe("HTTP AinOneApi", () => {
  it("replays from zero when this app instance has no hydrated history", async () => {
    const storage = memoryStorage({ "ain-one:event-sequence:conv-1": "9" });
    const requests: string[] = [];
    const event = normalizedEvent({ sequence: 1, id: "event-1" });
    let stop: () => void = () => {};

    const api = createHttpAinOneApi({
      baseUrl: "http://127.0.0.1:3000",
      token: "token",
      storage,
      reconnectBaseDelayMs: 1,
      fetchFn: async (input) => {
        requests.push(String(input));
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`id: 1\ndata: ${JSON.stringify(event)}\n\n`),
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    await new Promise<void>((resolve) => {
      stop = api.subscribeConversationEvents("conv-1", 0, () => {
        stop();
        resolve();
      });
    });

    expect(requests[0]).toContain("/api/conversations/conv-1/events?after=0");
    expect(storage.getItem("ain-one:event-sequence:conv-1")).toBe("1");
  });

  it("parses CRLF-delimited SSE frames", async () => {
    const event = normalizedEvent({ sequence: 1, id: "event-1" });
    const api = createHttpAinOneApi({
      token: "token",
      reconnectBaseDelayMs: 1,
      fetchFn: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`id: 1\r\ndata: ${JSON.stringify(event)}\r\n\r\n`),
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    let stop: () => void = () => undefined;
    const received = new Promise<NormalizedEvent>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CRLF SSE event was not emitted")), 50);
      stop = api.subscribeConversationEvents("conv-1", 0, (nextEvent) => {
        clearTimeout(timeout);
        resolve(nextEvent);
      });
    });

    try {
      await expect(received).resolves.toEqual(event);
    } finally {
      stop();
    }
  });

  it("posts cancellation without replaying another command", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    const api = createHttpAinOneApi({
      baseUrl: "http://127.0.0.1:3000",
      token: "token",
      fetchFn: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return Response.json({ cancelled: true });
      },
    });

    await api.cancelActiveTurn("conv-1");

    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:3000/api/conversations/conv-1/cancel",
        method: "POST",
        body: "{}",
      },
    ]);
  });

  it("posts explicit recovery commands once", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    const api = createHttpAinOneApi({
      baseUrl: "http://127.0.0.1:3000",
      token: "token",
      fetchFn: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return Response.json({ accepted: true });
      },
    });

    await api.continueConversation("conv-1");
    await api.retryInterruptedTurn("conv-1", "turn-1");

    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:3000/api/conversations/conv-1/continue",
        method: "POST",
        body: "{}",
      },
      {
        url: "http://127.0.0.1:3000/api/conversations/conv-1/turns/turn-1/retry",
        method: "POST",
        body: "{}",
      },
    ]);
  });

  it("persists exact conversation settings without local draft storage", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const storage = memoryStorage();
    const api = createHttpAinOneApi({
      token: "token",
      storage,
      fetchFn: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return jsonResponse({ conversation: conversation("conv-1", "project-1") });
      },
    });

    await api.updateConversationSettings("conv-1", {
      modelId: "gpt-5.1",
      permissionMode: "full_access",
    });

    expect(calls).toEqual([
      {
        url: "/api/conversations/conv-1/settings",
        method: "PUT",
        body: {
          modelId: "gpt-5.1",
          permissionMode: "full_access",
        },
      },
    ]);
    expect(storage.getItem("ain-one:draft-settings:conv-1")).toBeNull();
  });

  it("opens or picks a Project and creates a Conversation through the control API", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input, init) => {
        calls.push({
          url: String(input),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return String(input).endsWith("/api/projects") || String(input).endsWith("/api/projects/pick")
          ? jsonResponse({ project: project("project-1", "One") })
          : jsonResponse({ conversation: conversation("conv-1", "project-1") });
      },
    });

    const opened = await api.openProject("/tmp/one");
    const picked = await api.pickProject();
    const created = await api.createConversation({
      projectId: "project-1",
      agentProductId: "codex",
      modelId: "gpt-5",
      permissionMode: "request_approval",
    });

    expect(opened.id).toBe("project-1");
    expect(picked?.id).toBe("project-1");
    expect(created.id).toBe("conv-1");

    expect(calls).toEqual([
      { url: "/api/projects", body: { path: "/tmp/one", name: null } },
      { url: "/api/projects/pick", body: {} },
      {
        url: "/api/conversations",
        body: {
          projectId: "project-1",
          agentProductId: "codex",
          modelId: "gpt-5",
          permissionMode: "request_approval",
        },
      },
    ]);
  });

  it("requests plugin materialization repair for one exact Agent version", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), method: init?.method ?? "GET" });
        return Response.json({ repaired: true });
      },
    });

    await api.repairPluginMaterialization("claude", {
      pluginId: "review skill",
      versionId: "sha/1",
    });

    expect(calls).toEqual([
      {
        url: "/api/plugins/review%20skill/versions/sha%2F1/materializations/claude/repair",
        method: "POST",
      },
    ]);
  });

  it("installs a local Skill with an explicit compatibility matrix", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input, init) => {
        calls.push({
          url: String(input),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return Response.json({ plugin: {} }, { status: 201 });
      },
    });

    await api.installPlugin("/tmp/my-skill", "skill", ["codex", "claude"]);

    expect(calls).toEqual([
      {
        url: "/api/plugins/install",
        body: {
          path: "/tmp/my-skill",
          compatibility: {
            codex: { kind: "skill" },
            claude: { kind: "skill" },
          },
        },
      },
    ]);
  });

  it("installs an MCP definition without a fake Skill compatibility matrix", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input, init) => {
        calls.push({
          url: String(input),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return Response.json({ plugin: {} }, { status: 201 });
      },
    });

    await api.installPlugin("/tmp/mcp.json", "mcp", []);

    expect(calls).toEqual([
      { url: "/api/plugins/install", body: { path: "/tmp/mcp.json" } },
    ]);
  });

  it("refreshes native imports without sending filesystem paths", async () => {
    const calls: Array<{ url: string; body: string | null }> = [];
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input, init) => {
        calls.push({
          url: String(input),
          body: typeof init?.body === "string" ? init.body : null,
        });
        return Response.json({ candidates: [] });
      },
    });

    await api.refreshPluginImports();

    expect(calls).toEqual([{ url: "/api/plugins/scan", body: "{}" }]);
  });

  it("loads conversation details in parallel and shares catalog requests", async () => {
    const requested: string[] = [];
    const detailResolvers = new Map<string, (response: Response) => void>();
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input) => {
        const url = new URL(String(input), "http://local");
        requested.push(`${url.pathname}${url.search}`);

        if (url.pathname === "/api/projects") {
          return jsonResponse({
            projects: [project("project-1", "One"), project("project-2", "Two")],
          });
        }
        if (url.pathname === "/api/plugins") {
          return jsonResponse({ plugins: [], candidates: [] });
        }
        if (url.pathname === "/api/agents") {
          return jsonResponse({
            agents: [
              {
                agentProductId: "codex",
                executablePath: "codex",
                executablePathOverride: "/custom/codex",
                probe: { status: "available", version: "1.0" },
              },
            ],
          });
        }
        if (url.pathname === "/api/projects/project-1/conversations") {
          return jsonResponse({
            conversations: [
              conversation("conv-1", "project-1"),
              conversation("conv-2", "project-1"),
            ],
          });
        }
        if (url.pathname === "/api/projects/project-2/conversations") {
          return jsonResponse({ conversations: [] });
        }
        if (url.pathname.startsWith("/api/conversations/")) {
          return await new Promise<Response>((resolve) => {
            detailResolvers.set(url.pathname, resolve);
          });
        }
        if (url.pathname === "/api/agents/codex/catalog") {
          return jsonResponse({
            catalog: {
              models: [url.searchParams.get("projectId") === "project-2" ? "gpt-5-project-2" : "gpt-5"],
              permissionModes: ["request_approval"],
            },
          });
        }
        if (url.pathname === "/api/projects/project-1/files") {
          return jsonResponse({ path: ".", entries: [] });
        }
        if (url.pathname === "/api/projects/project-1/git/status") {
          return jsonResponse({ output: "## feature/ain-one-phase1\n" });
        }
        throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
      },
    });

    const loading = api.loadWorkspace();
    await waitFor(() => detailResolvers.size === 2);

    for (const [path, resolve] of detailResolvers) {
      const id = path.endsWith("conv-1") ? "conv-1" : "conv-2";
      resolve(jsonResponse(conversationDetail(id, "project-1")));
    }
    const workspace = await loading;

    expect(
      requested.filter((path) => path.startsWith("/api/agents/codex/catalog?projectId=project-1")),
    ).toHaveLength(1);
    expect(
      requested.filter((path) => path.startsWith("/api/agents/codex/catalog?projectId=project-2")),
    ).toHaveLength(1);
    expect(workspace.agents[0]?.projectCatalogs?.["project-2"]?.models).toEqual([
      "gpt-5-project-2",
    ]);
    expect(workspace.agents[0]?.executablePathOverride).toBe("/custom/codex");
  });

  it("keeps catalog request failures explicit for the affected Project", async () => {
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input) => {
        const url = new URL(String(input), "http://local");
        if (url.pathname === "/api/projects") {
          return jsonResponse({ projects: [project("project-1", "One")] });
        }
        if (url.pathname === "/api/plugins") {
          return jsonResponse({ plugins: [], candidates: [] });
        }
        if (url.pathname === "/api/agents") {
          return jsonResponse({
            agents: [{
              agentProductId: "codex",
              executablePath: "codex",
              probe: { status: "available", version: "1.0" },
            }],
          });
        }
        if (url.pathname === "/api/agents/codex/catalog") {
          return jsonResponse({ error: { code: "catalog_failed" } }, { status: 503 });
        }
        if (url.pathname === "/api/projects/project-1/conversations") {
          return jsonResponse({ conversations: [] });
        }
        if (url.pathname === "/api/projects/project-1/files") {
          return jsonResponse({ path: ".", entries: [] });
        }
        if (url.pathname === "/api/projects/project-1/git/status") {
          return jsonResponse({ output: "## main\n" });
        }
        throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
      },
    });

    const workspace = await api.loadWorkspace();

    expect(workspace.agents[0]?.catalog).toMatchObject({
      models: [],
      permissionModes: [],
      error: "Could not load Agent catalog",
    });
  });

  it("keeps workspace loading usable while exposing plugin inventory failures", async () => {
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input) => {
        const url = new URL(String(input), "http://local");
        if (url.pathname === "/api/projects") {
          return jsonResponse({ projects: [] });
        }
        if (url.pathname === "/api/agents") {
          return jsonResponse({ agents: [] });
        }
        if (url.pathname === "/api/plugins") {
          return jsonResponse({
            error: {
              code: "plugins_failed",
              message: "Plugin inventory is unavailable",
            },
          }, { status: 503 });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
    });

    await expect(api.loadWorkspace()).resolves.toMatchObject({
      projects: [],
      agents: [],
      installedPlugins: [],
      pluginCandidates: [],
      pluginError: "plugins_failed: Plugin inventory is unavailable",
    });
  });

  it("keeps deferred OpenCode capability out of the Phase 1 workspace", async () => {
    const requested: string[] = [];
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input) => {
        const url = new URL(String(input), "http://local");
        requested.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/api/projects") {
          return jsonResponse({ projects: [] });
        }
        if (url.pathname === "/api/agents") {
          return jsonResponse({
            agents: [
              {
                agentProductId: "codex",
                executablePath: "codex",
                probe: { status: "available" },
              },
              {
                agentProductId: "opencode",
                executablePath: "opencode",
                probe: { status: "available" },
              },
            ],
          });
        }
        if (url.pathname === "/api/plugins") {
          return jsonResponse({
            plugins: [
              {
                pluginId: "shared",
                versionId: "v1",
                type: "skill",
                compatibleAgents: ["codex", "opencode"],
                materializations: [
                  { agentProductId: "codex", status: "materialized", repairable: false },
                  { agentProductId: "opencode", status: "materialized", repairable: false },
                ],
              },
              {
                pluginId: "opencode-only-installed",
                versionId: "v1",
                type: "skill",
                compatibleAgents: ["opencode"],
                materializations: [],
              },
              {
                pluginId: "agent-agnostic-mcp",
                versionId: "v1",
                type: "mcp",
                compatibleAgents: [],
                materializations: [],
              },
            ],
            candidates: [{
              id: "candidate-opencode",
              pluginId: "opencode-only",
              versionId: "v1",
              type: "skill",
              compatibleAgents: ["opencode"],
              materializations: [],
              agentProductId: "opencode",
            }],
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
      },
    });

    const workspace = await api.loadWorkspace();

    expect(workspace.agents.map((agent) => agent.id)).toEqual(["codex"]);
    expect(workspace.installedPlugins.map((plugin) => plugin.pluginId)).toEqual([
      "shared",
      "agent-agnostic-mcp",
    ]);
    expect(workspace.installedPlugins[0]?.compatibleAgents).toEqual(["codex"]);
    expect(workspace.installedPlugins[0]?.materializations).toEqual([
      { agentProductId: "codex", status: "materialized", repairable: false },
    ]);
    expect(workspace.pluginCandidates).toEqual([]);
    expect(requested.some((path) => path.includes("opencode"))).toBe(false);
  });

  it("preserves normalized server errors for actionable settings feedback", async () => {
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async () => jsonResponse({
        error: {
          code: "turn_active",
          message: "Settings can change only between Turns",
        },
      }, { status: 409 }),
    });

    await expect(api.updateConversationSettings("conv-1", {
      modelId: "gpt-5",
      permissionMode: "request_approval",
    })).rejects.toThrow("turn_active: Settings can change only between Turns");
  });

  it("loads directories without requesting file preview or diff", async () => {
    const requested: string[] = [];
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input) => {
        const url = new URL(String(input), "http://local");
        requested.push(`${url.pathname}${url.search}`);
        if (url.pathname.endsWith("/files")) {
          return jsonResponse({
            path: "src",
            entries: [{ path: "src/web", type: "directory" }],
          });
        }
        if (url.pathname.endsWith("/git/status")) {
          return jsonResponse({ output: "## feature/ain-one-phase1\n" });
        }
        throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
      },
    });

    const inspector = await api.listProjectFiles("project-1", {
      path: "src",
      type: "directory",
    });

    expect(inspector.currentPath).toBe("src");
    expect(requested).toContain("/api/projects/project-1/files?path=src");
    expect(requested.some((path) => path.includes("/preview"))).toBe(false);
    expect(requested.some((path) => path.includes("/git/diff"))).toBe(false);
  });
});

describe("conversation event reducer", () => {
  it("deduplicates replayed events by id or sequence", () => {
    const first = normalizedEvent({ sequence: 1, id: "event-1" });
    const conversation = conversationView([first]);

    const duplicateId = applyConversationEvent(
      conversation,
      normalizedEvent({ sequence: 2, id: "event-1" }),
    );
    const duplicateSequence = applyConversationEvent(
      duplicateId,
      normalizedEvent({ sequence: 1, id: "event-2" }),
    );

    expect(duplicateSequence.events).toEqual([first]);
  });

  it("pauses recovery immediately when a Turn fails", () => {
    const conversation = {
      ...conversationView([]),
      activeTurnStatus: "running" as const,
      latestTurnId: "turn-running",
      latestTurnStatus: "running" as const,
    };

    const failed = applyConversationEvent(conversation, {
      id: "event-failed",
      conversationId: conversation.id,
      sequence: 1,
      type: "turn_status",
      payload: { turnId: "turn-failed", status: "failed" },
      createdAt: "2026-08-20T00:00:00.000Z",
    });

    expect(failed).toMatchObject({
      activeTurnStatus: null,
      latestTurnId: "turn-failed",
      latestTurnStatus: "failed",
      queuePaused: true,
    });
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function project(id: string, name: string) {
  return {
    id,
    name,
    path: `/tmp/${name.toLowerCase()}`,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}

function conversation(id: string, projectId: string) {
  return {
    id,
    projectId,
    agentProductId: "codex",
    modelId: "gpt-5",
    permissionMode: "request_approval",
    queuePaused: false,
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}

function conversationDetail(id: string, projectId: string) {
  return {
    conversation: conversation(id, projectId),
    pluginVersions: [],
    queuedMessages: [],
    activeTurn: null,
    latestTurn: null,
  };
}

function normalizedEvent(input: { sequence: number; id: string }): NormalizedEvent {
  return {
    id: input.id,
    conversationId: "conv-1",
    sequence: input.sequence,
    type: "assistant_message",
    payload: { text: "hello" },
    createdAt: "2026-08-19T00:00:00.000Z",
  };
}

function conversationView(events: NormalizedEvent[]): ConversationView {
  return {
    id: "conv-1",
    projectId: "project-1",
    title: "Conversation",
    agentProductId: "codex",
    agentProductLabel: "Codex",
    modelId: "gpt-5",
    permissionMode: "request_approval",
    availableModels: ["gpt-5"],
    availablePermissionModes: ["request_approval"],
    enabledPluginIds: [],
    availablePlugins: [],
    activeTurnStatus: null,
    latestTurnId: null,
    latestTurnStatus: null,
    queuePaused: false,
    queuedMessages: [],
    events,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not met");
}
