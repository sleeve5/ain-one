import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../src/server/db.js";
import { createRepositories } from "../../src/server/repositories.js";
import { createApiServer } from "../../src/server/api.js";
import { createProjectFilesService } from "../../src/server/files.js";

const TOKEN = "task-3-token";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text()) as unknown;
}

async function createFixture(input?: {
  permissionResponder?: (args: {
    conversationId: string;
    requestId: string;
    decision: "allow_once" | "deny_once";
  }) => Promise<void>;
}) {
  const projectPath = mkdtempSync(join(tmpdir(), "ain-one-task3-api-"));
  tempDirs.push(projectPath);

  const db = createDatabase(":memory:");
  const repositories = createRepositories(db);
  const project = repositories.createProject(projectPath, "demo");
  const conversation = repositories.createConversation({
    projectId: project.id,
    agentProductId: "codex",
    modelId: "gpt-test",
  });

  const queuedByCoordinator: string[] = [];
  const api = createApiServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    repositories,
    files: createProjectFilesService(),
    turnCoordinator: {
      enqueueMessage: async (conversationId, content) => {
        queuedByCoordinator.push(content);
        repositories.enqueueMessage(conversationId, content);
      },
      cancelActiveTurn: async () => false,
    },
    permissionResponder: input?.permissionResponder,
    ssePollMs: 5,
    sseHeartbeatMs: 50,
  });

  await api.start();

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${TOKEN}`);
    return fetch(`${api.url}${path}`, { ...init, headers });
  }

  return {
    api,
    repositories,
    project,
    conversation,
    queuedByCoordinator,
    request,
    stop: async () => {
      await api.stop();
      db.close();
    },
  };
}

async function readSseEvents(response: Response, count: number): Promise<unknown[]> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected SSE body");
  }
  const decoder = new TextDecoder();
  const parsed: unknown[] = [];
  let buffer = "";

  while (parsed.length < count) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });

    for (;;) {
      const separator = buffer.indexOf("\n\n");
      if (separator === -1) {
        break;
      }
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      if (frame.startsWith(":")) {
        continue;
      }

      const lines = frame.split("\n");
      const idLine = lines.find((line) => line.startsWith("id: "));
      const dataLine = lines.find((line) => line.startsWith("data: "));
      if (!idLine || !dataLine) {
        continue;
      }

      const payload = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
      payload.eventId = Number(idLine.slice(4));
      parsed.push(payload);
    }
  }

  await reader.cancel();
  return parsed;
}

describe("loopback api", () => {
  it("rejects requests without the installation token", async () => {
    const fixture = await createFixture();
    try {
      const response = await fetch(`${fixture.api.url}/api/projects`);
      expect(response.status).toBe(401);
    } finally {
      await fixture.stop();
    }
  });

  it("rejects non-loopback bind hosts before listen", async () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const api = createApiServer({
      host: "0.0.0.0",
      port: 0,
      token: TOKEN,
      repositories,
      turnCoordinator: {
        enqueueMessage: async () => undefined,
        cancelActiveTurn: async () => false,
      },
      files: createProjectFilesService(),
    });

    await expect(api.start()).rejects.toThrow("Loopback host required");
    db.close();
  });

  it("validates Origin when present", async () => {
    const fixture = await createFixture();
    try {
      const response = await fixture.request("/api/projects", {
        headers: {
          origin: "https://evil.example",
        },
      });
      expect(response.status).toBe(403);
    } finally {
      await fixture.stop();
    }
  });

  it("accepts ephemeral loopback allowedOrigins when the server port is dynamic", async () => {
    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const projectPath = mkdtempSync(join(tmpdir(), "ain-one-task3-api-origin-"));
    tempDirs.push(projectPath);
    repositories.createProject(projectPath, "demo");

    const api = createApiServer({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      repositories,
      turnCoordinator: {
        enqueueMessage: async () => undefined,
        cancelActiveTurn: async () => false,
      },
      files: createProjectFilesService(),
      allowedOrigins: ["http://127.0.0.1:0", "http://localhost:0", "http://[::1]:0"],
    });

    await api.start();
    try {
      const response = await fetch(`${api.url}/api/projects`, {
        headers: {
          authorization: `Bearer ${TOKEN}`,
          origin: api.url,
        },
      });
      expect(response.status).toBe(200);
    } finally {
      await api.stop();
      db.close();
    }
  });

  it("replays events strictly after the supplied sequence", async () => {
    const fixture = await createFixture();
    try {
      fixture.repositories.appendEvent(fixture.conversation.id, {
        type: "assistant_message",
        payload: { text: "one" },
      });
      fixture.repositories.appendEvent(fixture.conversation.id, {
        type: "assistant_message",
        payload: { text: "two" },
      });
      fixture.repositories.appendEvent(fixture.conversation.id, {
        type: "assistant_message",
        payload: { text: "three" },
      });

      const response = await fixture.request(
        `/api/conversations/${fixture.conversation.id}/events?after=1`,
      );

      expect(response.status).toBe(200);
      const replay = await readSseEvents(response, 2);
      expect(replay).toEqual([
        expect.objectContaining({ sequence: 2, eventId: 2 }),
        expect.objectContaining({ sequence: 3, eventId: 3 }),
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("rejects non-integer replay cursors", async () => {
    const fixture = await createFixture();
    try {
      const response = await fixture.request(
        `/api/conversations/${fixture.conversation.id}/events?after=1x`,
      );
      if (response.status !== 400) {
        await response.body?.cancel();
      }
      expect(response.status).toBe(400);
      if (response.status === 400) {
        expect(await readJson(response)).toEqual({
          error: {
            code: "invalid_after",
            message: "after must be a non-negative integer",
          },
        });
      }
    } finally {
      await fixture.stop();
    }
  });

  it("maps malformed URL path encoding to 400", async () => {
    const fixture = await createFixture();
    try {
      const response = await fixture.request("/api/conversations/%E0%A4%A/events");
      expect(response.status).toBe(400);
      expect(await readJson(response)).toEqual({
        error: {
          code: "invalid_path_encoding",
          message: "Route parameters must be valid URL encoding",
        },
      });
    } finally {
      await fixture.stop();
    }
  });

  it("only deletes pending queued messages", async () => {
    const fixture = await createFixture();
    try {
      const snapshot = {
        modelId: "gpt-test",
        permissionMode: "request_approval" as const,
        pluginVersions: [],
      };
      fixture.repositories.enqueueMessage(fixture.conversation.id, "claimed");
      const claimed = fixture.repositories.claimNextMessage(fixture.conversation.id, snapshot);
      if (!claimed) {
        throw new Error("expected claimed message");
      }
      const pending = fixture.repositories.enqueueMessage(fixture.conversation.id, "pending");

      const deleted = await fixture.request(
        `/api/conversations/${fixture.conversation.id}/messages/${pending.id}`,
        { method: "DELETE" },
      );
      expect(deleted.status).toBe(204);

      const rejected = await fixture.request(
        `/api/conversations/${fixture.conversation.id}/messages/${claimed.message.id}`,
        { method: "DELETE" },
      );
      expect(rejected.status).toBe(409);
    } finally {
      await fixture.stop();
    }
  });

  it("returns explicit 501 for unsupported permission and plugin mutations", async () => {
    const fixture = await createFixture();
    try {
      const permissionResponse = await fixture.request(
        `/api/conversations/${fixture.conversation.id}/permissions/${randomUUID()}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: "allow_once" }),
        },
      );
      expect(permissionResponse.status).toBe(501);

      const pluginMutation = await fixture.request("/api/plugins/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pluginId: "x" }),
      });
      expect(pluginMutation.status).toBe(501);

      const pluginsRead = await fixture.request("/api/plugins");
      expect(pluginsRead.status).toBe(200);
      expect(await readJson(pluginsRead)).toEqual({
        plugins: [],
        source: "ain_one",
        note: "no installed plugins",
      });
    } finally {
      await fixture.stop();
    }
  });

  it("returns metadata-only settings without token", async () => {
    const fixture = await createFixture();
    try {
      const response = await fixture.request("/api/settings");
      expect(response.status).toBe(200);
      const bodyText = await response.text();
      expect(JSON.parse(bodyText)).toEqual(
        expect.objectContaining({
          host: "127.0.0.1",
          port: expect.any(Number),
          securityMode: "bearer_token_with_origin_check",
        }),
      );
      expect(bodyText).not.toContain(TOKEN);
    } finally {
      await fixture.stop();
    }
  });

  it("supports conversation creation and queued message submission", async () => {
    const fixture = await createFixture();
    try {
      const secondProjectDir = mkdtempSync(join(tmpdir(), "ain-one-task3-api-project-"));
      tempDirs.push(secondProjectDir);
      mkdirSync(join(secondProjectDir, "nested"));

      const projectResponse = await fixture.request("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: secondProjectDir, name: "second" }),
      });
      expect(projectResponse.status).toBe(201);
      const projectBody = (await readJson(projectResponse)) as { project: { id: string } };

      const conversationResponse = await fixture.request("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: projectBody.project.id,
          agentProductId: "codex",
          modelId: "gpt-test",
        }),
      });
      expect(conversationResponse.status).toBe(201);
      const conversationBody = (await readJson(conversationResponse)) as {
        conversation: { id: string };
      };

      const queueResponse = await fixture.request(
        `/api/conversations/${conversationBody.conversation.id}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "hello" }),
        },
      );
      expect(queueResponse.status).toBe(202);
      expect(fixture.queuedByCoordinator).toContain("hello");
    } finally {
      await fixture.stop();
    }
  });
});
