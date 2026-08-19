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
          return jsonResponse({ plugins: [] });
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
              models: ["gpt-5"],
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
    await loading;

    expect(
      requested.filter((path) => path.startsWith("/api/agents/codex/catalog?projectId=project-1")),
    ).toHaveLength(1);
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

function jsonResponse(body: unknown): Response {
  return Response.json(body);
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
    latestTurnStatus: null,
    queuePaused: false,
    queuedMessages: [],
    events,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Condition was not met");
}
