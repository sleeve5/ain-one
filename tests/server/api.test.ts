import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConnector } from "../../src/shared/contracts.js";
import { createDatabase } from "../../src/server/db.js";
import { createRepositories } from "../../src/server/repositories.js";
import { createApiServer, InputError } from "../../src/server/api.js";
import { createProjectFilesService } from "../../src/server/files.js";
import { TurnCoordinator } from "../../src/server/turn-coordinator.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeHttpRequest(input: {
  url: URL;
  method: string;
  token: string;
  body?: string;
  agent?: Agent;
  beforeBodyEnd?: () => Promise<void>;
}): Promise<{
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  socketKey: string;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        protocol: input.url.protocol,
        hostname: input.url.hostname,
        port: input.url.port,
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        agent: input.agent,
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
          ...(input.body
            ? {
                "content-length": Buffer.byteLength(input.body),
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const socket = response.socket;
          resolvePromise({
            statusCode: response.statusCode ?? 0,
            headers: response.headers as Record<string, string | string[]>,
            body: Buffer.concat(chunks).toString("utf8"),
            socketKey: socket ? `${socket.remoteAddress}:${socket.remotePort}->${socket.localPort}` : "none",
          });
        });
      },
    );

    req.on("error", rejectPromise);
    if (input.body && input.beforeBodyEnd) {
      req.flushHeaders();
      void input.beforeBodyEnd().then(
        () => req.end(input.body),
        (error: unknown) => req.destroy(error instanceof Error ? error : new Error(String(error))),
      );
      return;
    }
    if (input.body) {
      req.write(input.body);
    }
    req.end();
  });
}

async function createFixture(input?: {
  permissionResponder?: (args: {
    conversationId: string;
    requestId: string;
    decision: "allow_once" | "deny_once";
  }) => Promise<void>;
  bodyLimitBytes?: number;
  catalog?: {
    models: string[];
    permissionModes: Array<"request_approval" | "help_me_approve" | "full_access">;
  };
  pickProjectDirectory?: () => Promise<string | null>;
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
  const recoveryCommands: string[] = [];
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
      continueConversation: async (conversationId) => {
        recoveryCommands.push(`continue:${conversationId}`);
        return true;
      },
      retryInterruptedTurn: async (conversationId, turnId) => {
        recoveryCommands.push(`retry:${conversationId}:${turnId}`);
        return true;
      },
    },
    permissionResponder: input?.permissionResponder,
    catalogProvider: async () => input?.catalog ?? ({
      models: ["gpt-test", "gpt-next"],
      permissionModes: ["request_approval", "full_access"],
    }),
    validatePluginVersions: (_scope, pluginVersions) => {
      if (pluginVersions.some(
        (plugin) => plugin.pluginId !== "formatter" || plugin.versionId !== "v1",
      )) {
        throw new InputError(400, "plugin_version_not_found", "Plugin version not found");
      }
    },
    pickProjectDirectory: input?.pickProjectDirectory,
    bodyLimitBytes: input?.bodyLimitBytes,
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
    recoveryCommands,
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
        continueConversation: async () => false,
        retryInterruptedTurn: async () => false,
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
        continueConversation: async () => false,
        retryInterruptedTurn: async () => false,
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

  it("opens a Project selected by the native folder picker and treats cancellation as a no-op", async () => {
    const selectedPath = mkdtempSync(join(tmpdir(), "ain-one-picked-project-"));
    tempDirs.push(selectedPath);
    const selections = [selectedPath, null];
    const fixture = await createFixture({
      pickProjectDirectory: async () => selections.shift() ?? null,
    });
    try {
      const opened = await fixture.request("/api/projects/pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(opened.status).toBe(201);
      expect(await readJson(opened)).toMatchObject({
        project: { path: realpathSync(selectedPath) },
      });

      const cancelled = await fixture.request("/api/projects/pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(cancelled.status).toBe(200);
      expect(await readJson(cancelled)).toEqual({ project: null });
    } finally {
      await fixture.stop();
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

  it("withholds terminal SSE events until the Turn state is committed", async () => {
    const fixture = await createFixture();
    try {
      fixture.repositories.enqueueMessage(fixture.conversation.id, "run");
      const claimed = fixture.repositories.claimNextMessage(fixture.conversation.id, {
        modelId: "gpt-test",
        permissionMode: "request_approval",
        pluginVersions: [],
      });
      if (!claimed) {
        throw new Error("expected active Turn");
      }
      fixture.repositories.markTurnRunning(claimed.turn.id, "native-turn");
      fixture.repositories.appendEvent(fixture.conversation.id, {
        type: "turn_status",
        payload: { turnId: claimed.turn.id, status: "failed" },
      });

      const response = await fixture.request(
        `/api/conversations/${fixture.conversation.id}/events`,
      );
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("expected stream reader");
      }
      const firstChunk = await reader.read();
      expect(new TextDecoder().decode(firstChunk.value)).not.toContain('"status":"failed"');

      fixture.repositories.finishTurn(claimed.turn.id, "failed");
      const deadline = Date.now() + 500;
      let output = "";
      while (Date.now() < deadline && !output.includes('"status":"failed"')) {
        const chunk = await reader.read();
        output += new TextDecoder().decode(chunk.value);
      }
      expect(output).toContain('"status":"failed"');
      await reader.cancel();
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
      expect(pluginsRead.status).toBe(501);
      expect(await readJson(pluginsRead)).toEqual({
        error: {
          code: "plugins_unsupported",
          message: "Plugin listing is not supported",
        },
      });
    } finally {
      await fixture.stop();
    }
  });

  it("stops cleanly with a connected SSE stream", async () => {
    const fixture = await createFixture();
    try {
      const stream = await fixture.request(`/api/conversations/${fixture.conversation.id}/events`);
      expect(stream.status).toBe(200);
      const reader = stream.body?.getReader();
      if (!reader) {
        throw new Error("expected stream reader");
      }

      await sleep(20);
      await expect(
        Promise.race([
          fixture.stop(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stop timeout")), 1000)),
        ]),
      ).resolves.toBeUndefined();

      const deadline = Date.now() + 1000;
      let ended = false;
      while (Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
        ]);
        if (next === null) {
          continue;
        }
        if (next.done) {
          ended = true;
          break;
        }
      }
      expect(ended).toBe(true);
    } catch (error) {
      await fixture.stop().catch(() => undefined);
      throw error;
    }
  });

  it("closes keep-alive connection after oversize body and does not poison next request", async () => {
    const fixture = await createFixture({ bodyLimitBytes: 512 });
    const keepAliveAgent = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const oversizedBody = JSON.stringify({ content: "x".repeat(5000) });
      const oversize = await makeHttpRequest({
        url: new URL(`${fixture.api.url}/api/conversations/${fixture.conversation.id}/messages`),
        method: "POST",
        token: TOKEN,
        body: oversizedBody,
        agent: keepAliveAgent,
      });

      expect(oversize.statusCode).toBe(413);
      expect(oversize.headers.connection).toBe("close");

      const followup = await makeHttpRequest({
        url: new URL(`${fixture.api.url}/api/projects`),
        method: "GET",
        token: TOKEN,
        agent: keepAliveAgent,
      });

      expect(followup.statusCode).toBe(200);
      expect(followup.socketKey).not.toBe(oversize.socketKey);
    } finally {
      keepAliveAgent.destroy();
      await fixture.stop();
    }
  });

  it("rejects malformed percent-encoding in file query paths", async () => {
    const fixture = await createFixture();
    try {
      const filesResponse = await fixture.request(
        `/api/projects/${fixture.project.id}/files?path=%E0%A4%A`,
      );
      expect(filesResponse.status).toBe(400);
      expect(await readJson(filesResponse)).toEqual({
        error: {
          code: "invalid_path_encoding",
          message: "Query parameter path must be valid URL encoding",
        },
      });

      const previewResponse = await fixture.request(
        `/api/projects/${fixture.project.id}/preview?path=%E0%A4%A`,
      );
      expect(previewResponse.status).toBe(400);

      const diffResponse = await fixture.request(
        `/api/projects/${fixture.project.id}/git/diff?path=%E0%A4%A`,
      );
      expect(diffResponse.status).toBe(400);
    } finally {
      await fixture.stop();
    }
  });

  it("supports valid percent-encoded file query paths", async () => {
    const fixture = await createFixture();
    try {
      const nestedDir = join(fixture.project.path, "nested");
      mkdirSync(nestedDir);
      const filePath = join(nestedDir, "hello world.txt");
      writeFileSync(filePath, "hi");

      const encoded = encodeURIComponent("nested/hello world.txt");
      const previewResponse = await fixture.request(
        `/api/projects/${fixture.project.id}/preview?path=${encoded}`,
      );
      expect(previewResponse.status).toBe(200);
      expect(await readJson(previewResponse)).toEqual(
        expect.objectContaining({
          path: "nested/hello world.txt",
          content: "hi",
        }),
      );
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

  it("exposes explicit continue and interrupted-Turn retry commands", async () => {
    const fixture = await createFixture();
    try {
      const continued = await fixture.request(
        `/api/conversations/${fixture.conversation.id}/continue`,
        { method: "POST", body: "{}" },
      );
      const retried = await fixture.request(
        `/api/conversations/${fixture.conversation.id}/turns/turn-1/retry`,
        { method: "POST", body: "{}" },
      );

      expect(continued.status).toBe(200);
      expect(retried.status).toBe(200);
      expect(fixture.recoveryCommands).toEqual([
        `continue:${fixture.conversation.id}`,
        `retry:${fixture.conversation.id}:turn-1`,
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("persists between-Turn conversation settings and rejects changes while active", async () => {
    const fixture = await createFixture();
    try {
      const update = await fixture.request(
        `/api/conversations/${fixture.conversation.id}/settings`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelId: "gpt-next",
            permissionMode: "full_access",
          }),
        },
      );
      expect(update.status).toBe(200);
      expect(fixture.repositories.getConversation(fixture.conversation.id)).toMatchObject({
        agentProductId: "codex",
        modelId: "gpt-next",
        permissionMode: "full_access",
      });
      expect(fixture.repositories.resolvePluginVersions(
        fixture.project.id,
        fixture.conversation.id,
      )).toEqual([]);

      const detail = await fixture.request(`/api/conversations/${fixture.conversation.id}`);
      expect(await readJson(detail)).toMatchObject({ pluginVersions: [] });

      fixture.repositories.enqueueMessage(fixture.conversation.id, "active");
      fixture.repositories.claimNextMessage(fixture.conversation.id, {
        modelId: "gpt-next",
        permissionMode: "full_access",
        pluginVersions: [],
      });
      const blocked = await fixture.request(
        `/api/conversations/${fixture.conversation.id}/settings`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelId: "forbidden",
            permissionMode: "request_approval",
          }),
        },
      );
      expect(blocked.status).toBe(409);
      expect(fixture.repositories.getConversation(fixture.conversation.id)?.modelId).toBe(
        "gpt-next",
      );
    } finally {
      await fixture.stop();
    }
  });

  it("returns 400 for invalid settings payloads", async () => {
    const fixture = await createFixture();
    try {
      const response = await fixture.request(
        `/api/conversations/${fixture.conversation.id}/settings`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelId: null, permissionMode: "invalid" }),
        },
      );

      expect(response.status).toBe(400);
      expect(await readJson(response)).toEqual({
        error: {
          code: "invalid_input",
          message: "Unsupported permission mode",
        },
      });
    } finally {
      await fixture.stop();
    }
  });

  it("rejects models and permission modes outside the Agent catalog", async () => {
    const fixture = await createFixture({
      catalog: {
        models: ["gpt-test"],
        permissionModes: ["request_approval"],
      },
    });
    try {
      const create = await fixture.request("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: fixture.project.id,
          agentProductId: "codex",
          modelId: "missing-model",
          permissionMode: "request_approval",
        }),
      });
      expect(create.status).toBe(400);
      expect(await readJson(create)).toMatchObject({
        error: { code: "unsupported_model" },
      });

      const update = await fixture.request(
        `/api/conversations/${fixture.conversation.id}/settings`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            modelId: "gpt-test",
            permissionMode: "help_me_approve",
          }),
        },
      );
      expect(update.status).toBe(400);
      expect(await readJson(update)).toMatchObject({
        error: { code: "unsupported_permission_mode" },
      });
    } finally {
      await fixture.stop();
    }
  });

  it("uses the Agent catalog default permission when create omits it", async () => {
    const fixture = await createFixture({
      catalog: {
        models: ["openai/gpt-5"],
        permissionModes: ["full_access"],
      },
    });
    try {
      const response = await fixture.request("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: fixture.project.id,
          agentProductId: "opencode",
          modelId: "openai/gpt-5",
        }),
      });

      expect(response.status).toBe(201);
      expect(await readJson(response)).toMatchObject({
        conversation: { permissionMode: "full_access" },
      });
    } finally {
      await fixture.stop();
    }
  });

  it("reads and replaces plugin enablements at each scope", async () => {
    const fixture = await createFixture();
    try {
      const put = await fixture.request("/api/plugins/enablements/global", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pluginVersions: [{ pluginId: "formatter", versionId: "v1" }],
        }),
      });
      expect(put.status).toBe(200);

      const get = await fixture.request("/api/plugins/enablements/global");
      expect(await readJson(get)).toEqual({
        pluginVersions: [{ pluginId: "formatter", versionId: "v1" }],
      });

      const invalid = await fixture.request("/api/plugins/enablements/global", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pluginVersions: [{ pluginId: "missing", versionId: "v2" }],
        }),
      });
      expect(invalid.status).toBe(400);
      expect(await readJson(invalid)).toEqual({
        error: {
          code: "plugin_version_not_found",
          message: "Plugin version not found",
        },
      });
      expect(fixture.repositories.listPluginEnablements({ type: "global" })).toEqual([
        { pluginId: "formatter", versionId: "v1" },
      ]);
    } finally {
      await fixture.stop();
    }
  });

  it("rejects plugin enablement changes that affect an active Turn", async () => {
    const fixture = await createFixture();
    try {
      fixture.repositories.enqueueMessage(fixture.conversation.id, "active");
      fixture.repositories.claimNextMessage(fixture.conversation.id, {
        modelId: "gpt-test",
        permissionMode: "request_approval",
        pluginVersions: [],
      });

      for (const path of [
        "/api/plugins/enablements/global",
        `/api/plugins/enablements/project/${fixture.project.id}`,
        `/api/plugins/enablements/conversation/${fixture.conversation.id}`,
      ]) {
        const response = await fixture.request(path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pluginVersions: [{ pluginId: "formatter", versionId: "v1" }],
          }),
        });
        expect(response.status).toBe(409);
      }
    } finally {
      await fixture.stop();
    }
  });

  it("returns turn_active when an Agent Turn starts while settings input is loading", async () => {
    const projectPath = mkdtempSync(join(tmpdir(), "ain-one-agent-settings-race-"));
    const executable = join(projectPath, "replacement-agent");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    tempDirs.push(projectPath);

    const db = createDatabase(":memory:");
    const repositories = createRepositories(db);
    const project = repositories.createProject(projectPath, "race");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "gpt-test",
    });
    const initial = { id: "codex" } as AgentConnector;
    const replacement = { id: "codex" } as AgentConnector;
    const coordinator = new TurnCoordinator({ repositories, connectors: { codex: initial } });
    let releaseInitialCheck = (): void => undefined;
    const initialCheck = new Promise<void>((resolvePromise) => {
      releaseInitialCheck = resolvePromise;
    });
    const hasActiveTurnForAgent = repositories.hasActiveTurnForAgent.bind(repositories);
    let checks = 0;
    repositories.hasActiveTurnForAgent = (agentProductId) => {
      const active = hasActiveTurnForAgent(agentProductId);
      if (checks++ === 0) {
        releaseInitialCheck();
      }
      return active;
    };
    const api = createApiServer({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      repositories,
      files: createProjectFilesService(),
      turnCoordinator: coordinator,
      updateAgentSettings: ({ agentProductId }) =>
        coordinator.setConnector(agentProductId, replacement),
    });
    await api.start();

    try {
      const body = JSON.stringify({ executablePath: executable });
      const response = await makeHttpRequest({
        url: new URL(`/api/agents/codex/settings`, api.url),
        method: "PUT",
        token: TOKEN,
        body,
        beforeBodyEnd: async () => {
          await initialCheck;
          repositories.enqueueMessage(conversation.id, "active");
          repositories.claimNextMessage(conversation.id, {
            modelId: "gpt-test",
            permissionMode: "request_approval",
            pluginVersions: [],
          });
        },
      });

      expect(response.statusCode).toBe(409);
      expect(JSON.parse(response.body)).toEqual({
        error: {
          code: "turn_active",
          message: "Agent settings can change only between Turns",
        },
      });
    } finally {
      await api.stop();
      db.close();
    }
  });
});
