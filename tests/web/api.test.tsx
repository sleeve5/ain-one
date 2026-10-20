import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../../src/shared/contracts.js";
import {
  createHttpAinOneApi,
  type ConversationView,
} from "../../src/web/api.js";
import { applyConversationEvent, coalesceConversationEvents } from "../../src/web/store.js";

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

  it("posts an explicit permission decision", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const api = createHttpAinOneApi({
      baseUrl: "http://127.0.0.1:3000",
      token: "token",
      fetchFn: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return Response.json({ accepted: true });
      },
    });

    await api.respondToPermission("conv-1", "approval-1", "deny_once");

    expect(calls).toEqual([{
      url: "http://127.0.0.1:3000/api/conversations/conv-1/permissions/approval-1",
      method: "POST",
      body: { decision: "deny_once" },
    }]);
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
        return Response.json({ plugins: [], candidates: [] });
      },
    });

    await api.refreshPluginImports();

    expect(calls).toEqual([{ url: "/api/plugins/scan", body: "{}" }]);
  });

  it("uses native host pickers for plugin and Agent paths", async () => {
    const calls: string[] = [];
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input) => {
        calls.push(String(input));
        const url = String(input);
        return Response.json({ path: url.includes("purpose=agent") ? "/tmp/chosen" : url.includes("kind=file") ? "/tmp/mcp.json" : "/tmp/chosen" });
      },
    });

    await expect(api.pickLocalPath!("directory")).resolves.toBe("/tmp/chosen");
    await expect(api.pickLocalPath!("file")).resolves.toBe("/tmp/mcp.json");
    await expect(api.pickAgentExecutable!("codex")).resolves.toBe("/tmp/chosen");
    expect(calls).toEqual([
      "/api/host/pick-path?kind=directory&purpose=plugin",
      "/api/host/pick-path?kind=file&purpose=plugin",
      "/api/host/pick-path?kind=file&purpose=agent&agentProductId=codex",
    ]);
  });

  it("deduplicates archived projects and conversations by id", async () => {
    const projectOne = project("project-1", "One");
    const archivedProject = { ...projectOne, archivedAt: "2026-08-24T00:00:00.000Z" };
    const archivedConversation = { ...conversation("conv-1", "project-1"), archivedAt: "2026-08-24T00:00:00.000Z" };
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input) => {
        const url = String(input);
        if (url.endsWith("/api/projects")) return jsonResponse({ projects: [projectOne] });
        if (url.endsWith("/api/projects?archived=true")) return jsonResponse({ projects: [archivedProject, archivedProject] });
        return jsonResponse({ conversations: [archivedConversation, archivedConversation] });
      },
    });

    const archived = await api.loadArchived!();
    expect(archived.projects).toHaveLength(1);
    expect(archived.conversations).toHaveLength(1);
  });

  it("includes active resources owned by an archived Project", async () => {
    const activeProject = project("active-project", "Active");
    const archivedProject = {
      ...project("archived-project", "Archived"),
      archivedAt: "2026-08-24T00:00:00.000Z",
    };
    const activeConversation = conversation("active-conversation", "archived-project");
    const archivedConversation = {
      ...conversation("archived-conversation", "active-project"),
      archivedAt: "2026-08-24T00:00:00.000Z",
    };
    const activeGraph = graph("active-graph", "archived-project");
    const archivedGraph = {
      ...graph("archived-graph", "active-project"),
      archivedAt: "2026-08-24T00:00:00.000Z",
    };
    const requests: string[] = [];
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url === "/api/projects") return jsonResponse({ projects: [activeProject] });
        if (url === "/api/projects?archived=true") return jsonResponse({ projects: [archivedProject] });
        if (url === "/api/projects/active-project/conversations?archived=true") return jsonResponse({ conversations: [archivedConversation] });
        if (url === "/api/projects/archived-project/conversations") return jsonResponse({ conversations: [activeConversation] });
        if (url === "/api/projects/archived-project/conversations?archived=true") return jsonResponse({ conversations: [] });
        if (url === "/api/projects/active-project/graphs?archived=true") return jsonResponse({ graphs: [archivedGraph] });
        if (url === "/api/projects/archived-project/graphs") return jsonResponse({ graphs: [activeGraph] });
        if (url === "/api/projects/archived-project/graphs?archived=true") return jsonResponse({ graphs: [] });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    const archived = await api.loadArchived!();

    expect(archived.conversations.map((item) => item.id).sort()).toEqual([
      "active-conversation",
      "archived-conversation",
    ]);
    expect(archived.graphs?.map((item) => item.id).sort()).toEqual([
      "active-graph",
      "archived-graph",
    ]);
    expect(requests).not.toContain("/api/projects/active-project/conversations");
    expect(requests).not.toContain("/api/projects/active-project/graphs");
  });

  it("deletes an archived Conversation with an authenticated DELETE", async () => {
    const calls: Array<{ url: string; method: string | undefined; authorization: string | null }> = [];
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), method: init?.method, authorization: new Headers(init?.headers).get("authorization") });
        return new Response(null, { status: 204 });
      },
    });

    await api.deleteArchivedConversation!("conversation / 1");
    expect(calls).toEqual([{ url: "/api/conversations/conversation%20%2F%201", method: "DELETE", authorization: "Bearer token" }]);
  });

  it("deletes an archived Project with an authenticated DELETE", async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return new Response(null, { status: 204 });
      },
    });

    await api.deleteArchivedProject!("project / 1");
    expect(calls).toEqual([{ url: "/api/projects/project%20%2F%201", method: "DELETE" }]);
  });

  it("loads workspace summaries first and hydrates one Conversation on demand", async () => {
    const requested: string[] = [];
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
          const id = url.pathname.endsWith("conv-1") ? "conv-1" : "conv-2";
          return jsonResponse({
            ...conversationDetail(id, "project-1"),
            events: id === "conv-1"
              ? [
                  normalizedEvent({ id: "delta-1", sequence: 1, conversationId: id, payload: { text: "Hello", streamId: "stream-1", delta: true } }),
                  normalizedEvent({ id: "final-1", sequence: 2, conversationId: id, payload: { text: "Hello world", streamId: "stream-1", final: true } }),
                ]
              : [normalizedEvent({ id: "event-" + id, sequence: 1, conversationId: id })],
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

    const workspace = await api.loadWorkspace();

    expect(
      requested.filter((path) => path.startsWith("/api/agents/codex/catalog?projectId=project-1")),
    ).toHaveLength(1);
    expect(
      requested.filter((path) => path.startsWith("/api/agents/codex/catalog?projectId=project-2")),
    ).toHaveLength(0);
    expect(requested.some((path) => path.startsWith("/api/conversations/"))).toBe(false);
    expect(workspace.agents[0]?.executablePathOverride).toBe("/custom/codex");
    expect(workspace.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "conv-1", hydrated: false, events: [] }),
      expect.objectContaining({ id: "conv-2", hydrated: false, events: [] }),
    ]));

    const hydrated = await api.loadConversation!("conv-1");
    expect(hydrated).toMatchObject({
      id: "conv-1",
      hydrated: true,
      events: [expect.objectContaining({ id: "final-1", payload: expect.objectContaining({ text: "Hello world" }) })],
      rawEvents: [expect.objectContaining({ id: "delta-1" }), expect.objectContaining({ id: "final-1" })],
    });
    expect(
      requested.filter((path) => path.startsWith("/api/agents/codex/catalog?projectId=project-1")),
    ).toHaveLength(1);
    await expect(api.loadAgentCatalog!("codex", "project-2")).resolves.toEqual({
      models: ["gpt-5-project-2"],
      permissionModes: ["request_approval"],
    });
    await api.loadAgentCatalog!("codex", "project-2");
    expect(
      requested.filter((path) => path.startsWith("/api/agents/codex/catalog?projectId=project-2")),
    ).toHaveLength(1);
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

  it("retries an Agent catalog after a transient failure", async () => {
    let catalogRequests = 0;
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input) => {
        const url = new URL(String(input), "http://local");
        if (url.pathname === "/api/agents/codex/catalog") {
          catalogRequests += 1;
          return catalogRequests === 1
            ? jsonResponse({ error: { code: "catalog_failed" } }, { status: 503 })
            : jsonResponse({
                catalog: {
                  models: ["gpt-5"],
                  permissionModes: ["request_approval"],
                },
              });
        }
        throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
      },
    });

    await expect(api.loadAgentCatalog!("codex", "project-1")).resolves.toMatchObject({
      error: "Could not load Agent catalog",
    });
    await expect(api.loadAgentCatalog!("codex", "project-1")).resolves.toEqual({
      models: ["gpt-5"],
      permissionModes: ["request_approval"],
    });
    expect(catalogRequests).toBe(2);
  });

  it("reloads Agent catalogs after restarting the Project", async () => {
    let catalogRequests = 0;
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input) => {
        const url = new URL(String(input), "http://local");
        if (url.pathname === "/api/agents/codex/catalog") {
          catalogRequests += 1;
          return jsonResponse({
            catalog: {
              models: [`gpt-${catalogRequests}`],
              permissionModes: ["request_approval"],
            },
          });
        }
        if (url.pathname === "/api/workspace/restart") {
          return jsonResponse({ restarted: true });
        }
        throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
      },
    });

    await expect(api.loadAgentCatalog!("codex", "project-1")).resolves.toMatchObject({
      models: ["gpt-1"],
    });
    await api.restartWorkspace!();
    await expect(api.loadAgentCatalog!("codex", "project-1")).resolves.toMatchObject({
      models: ["gpt-2"],
    });
    expect(catalogRequests).toBe(2);
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
      pluginError: "plugins_failed: Plugin inventory is unavailable",
    });
  });

  it("keeps workspace loading usable while exposing Graph inventory failures", async () => {
    const api = createHttpAinOneApi({
      token: "token",
      fetchFn: async (input) => {
        const url = new URL(String(input), "http://local");
        if (url.pathname === "/api/projects") return jsonResponse({ projects: [project("project-1", "One")] });
        if (url.pathname === "/api/agents") return jsonResponse({ agents: [] });
        if (url.pathname === "/api/plugins") return jsonResponse({ plugins: [], candidates: [] });
        if (url.pathname === "/api/projects/project-1/conversations") return jsonResponse({ conversations: [] });
        if (url.pathname === "/api/projects/project-1/graphs") return jsonResponse({ error: { code: "graphs_failed", message: "Graph inventory is unavailable" } }, { status: 503 });
        throw new Error(`Unexpected request: ${url.pathname}`);
      },
    });

    await expect(api.loadWorkspace()).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: "project-1" })],
      conversations: [],
      graphs: [],
      graphError: "graphs_failed: Graph inventory is unavailable",
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
    expect(workspace).not.toHaveProperty("pluginCandidates");
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

});
describe("conversation event reducer", () => {
  it("coalesces persisted assistant streams during conversation hydration", () => {
    const events = [
      normalizedEvent({
        id: "question", sequence: 1, type: "user_message",
        payload: { text: "你是什么模型", role: "user" },
      }),
      normalizedEvent({
        id: "delta-1", sequence: 2, type: "assistant_message",
        payload: { text: "我是", role: "assistant", streamId: "message-1", delta: true },
      }),
      normalizedEvent({
        id: "delta-2", sequence: 3, type: "assistant_message",
        payload: { text: " **Codex**", role: "assistant", streamId: "message-1", delta: true },
      }),
      normalizedEvent({
        id: "final", sequence: 4, type: "assistant_message",
        payload: { text: "我是 **Codex**。", role: "assistant", streamId: "message-1", final: true },
      }),
    ];

    const projected = coalesceConversationEvents(events);

    expect(projected).toHaveLength(2);
    expect(projected[1]).toMatchObject({
      id: "final",
      sequence: 4,
      payload: { text: "我是 **Codex**。", final: true },
    });
    expect(projected[1]?.payload).not.toHaveProperty("delta");
  });

  it("coalesces assistant deltas into one live message and replaces it with the final text", () => {
    const conversation = conversationView([]);
    const first = applyConversationEvent(conversation, normalizedEvent({
      id: "delta-1", sequence: 1, type: "assistant_message",
      payload: { text: "Hello", role: "assistant", streamId: "message-1", delta: true },
    }));
    const second = applyConversationEvent(first, normalizedEvent({
      id: "delta-2", sequence: 2, type: "assistant_message",
      payload: { text: " world", role: "assistant", streamId: "message-1", delta: true },
    }));
    const completed = applyConversationEvent(second, normalizedEvent({
      id: "final-1", sequence: 3, type: "assistant_message",
      payload: { text: "Hello world!", role: "assistant", streamId: "message-1", final: true },
    }));

    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.payload.text).toBe("Hello world");
    expect(completed.events).toHaveLength(1);
    expect(completed.events[0]?.payload.text).toBe("Hello world!");
    expect(completed.events[0]?.sequence).toBe(3);
  });

  it("keeps live status events in the raw trajectory stream", () => {
    const running = applyConversationEvent(conversationView([]), normalizedEvent({
      id: "status-1", sequence: 1, type: "turn_status",
      payload: { turnId: "turn-1", status: "running" },
    }));

    expect(running.rawEvents).toEqual([expect.objectContaining({ id: "status-1" })]);
  });

  it("starts a new assistant message when Trae reuses a stream id after a user follow-up", () => {
    const previousAnswer = normalizedEvent({
      id: "answer-1", sequence: 1, type: "assistant_message",
      payload: { text: "我是 TraeCode", role: "assistant", streamId: "item-4", final: true },
    });
    const followUp = normalizedEvent({
      id: "question-2", sequence: 2, type: "user_message",
      payload: { text: "介绍一下你可用的所有模型", role: "user" },
    });

    const updated = applyConversationEvent(
      conversationView([previousAnswer, followUp]),
      normalizedEvent({
        id: "answer-2", sequence: 3, type: "assistant_message",
        payload: { text: "可用模型如下", role: "assistant", streamId: "item-4", final: true },
      }),
    );

    expect(updated.events.map((event) => event.payload.text)).toEqual([
      "我是 TraeCode",
      "介绍一下你可用的所有模型",
      "可用模型如下",
    ]);
  });

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

  it("advances the replay cursor when an SSE event is applied", () => {
    const updated = applyConversationEvent(
      { ...conversationView([]), latestEventSequence: 3 },
      normalizedEvent({ id: "event-4", sequence: 4 }),
    );

    expect(updated.latestEventSequence).toBe(4);
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

function graph(id: string, projectId: string) {
  return {
    id,
    projectId,
    name: id,
    description: "",
    definition: { nodes: [], edges: [], start: [], end: [] },
    viewport: { x: 0, y: 0, zoom: 1 },
    positions: {},
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

function normalizedEvent(input: Partial<NormalizedEvent> & { sequence: number; id: string }): NormalizedEvent {
  return {
    conversationId: "conv-1",
    type: "assistant_message",
    payload: { text: "hello" },
    createdAt: "2026-08-19T00:00:00.000Z",
    ...input,
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
