import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveTurnStatus, AgentConnector, GraphDefinition } from "../../src/shared/contracts.js";
import { createDatabase } from "../../src/server/db.js";
import { startServer } from "../../src/server/main.js";
import { createPluginHub } from "../../src/server/plugins.js";
import { createRepositories } from "../../src/server/repositories.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("server composition", () => {
  it("shares one shutdown when stop is called concurrently", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-idempotent-stop-"));
    tempDirs.push(dataDir);
    let finishClose!: () => void;
    const closeStarted = vi.fn();
    const connector = {
      id: "codex",
      probe: async () => ({ status: "available", version: "test" }),
      fetchCatalog: async () => ({ models: ["test"], permissionModes: ["request_approval"] }),
      createOrResumeSession: async (input: { conversationId: string }) => ({
        id: input.conversationId, nativeSessionId: "native-session",
      }),
      startTurn: async () => ({ nativeTurnId: "native-turn" }),
      closeSession: async () => {
        closeStarted();
        await new Promise<void>((resolve) => { finishClose = resolve; });
      },
    } as unknown as AgentConnector;
    const server = await startServer({
      dataDir, port: 0, token: "idempotent-stop-token", connectors: { codex: connector },
      pluginHub: createPluginHub({ dataDir, skillRoots: {} }),
    });
    const projectDir = join(dataDir, "project");
    mkdirSync(projectDir);
    const headers = { authorization: "Bearer idempotent-stop-token", "content-type": "application/json" };
    const project = await fetch(`${server.url}/api/projects`, {
      method: "POST", headers, body: JSON.stringify({ path: projectDir }),
    }).then((response) => response.json()) as { project: { id: string } };
    const conversation = await fetch(`${server.url}/api/conversations`, {
      method: "POST", headers, body: JSON.stringify({
        projectId: project.project.id, agentProductId: "codex", modelId: "test",
      }),
    }).then((response) => response.json()) as { conversation: { id: string } };
    await fetch(`${server.url}/api/conversations/${conversation.conversation.id}/messages`, {
      method: "POST", headers, body: JSON.stringify({ content: "running" }),
    });

    const first = server.stop();
    const second = server.stop();
    await vi.waitFor(() => expect(closeStarted).toHaveBeenCalledOnce());
    finishClose();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(closeStarted).toHaveBeenCalledOnce();
  });

  it("wires Graph CRUD and runtime through startServer", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-graph-composition-"));
    const projectDir = join(dataDir, "project");
    mkdirSync(projectDir);
    tempDirs.push(dataDir);
    const token = "graph-composition-token";
    const server = await startServer({
      dataDir,
      port: 0,
      token,
      connectors: {},
      pluginHub: createPluginHub({ dataDir, skillRoots: {} }),
    });
    const request = (path: string, init: RequestInit = {}) => fetch(`${server.url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
    try {
      const projectResponse = await request("/api/projects", {
        method: "POST",
        body: JSON.stringify({ path: projectDir, name: "Graph project" }),
      });
      const project = (await projectResponse.json() as { project: { id: string } }).project;
      const definition: GraphDefinition = {
        nodes: [
          { id: "input", type: "input", name: "Input", config: { fields: [{ id: "input", name: "Input", description: "", required: true, multiline: true }] } },
          { id: "result", type: "output", name: "Result", config: { fields: [{ id: "result", name: "Result", required: true }] } },
        ],
        edges: [{ id: "pass", source: "input", sourcePort: "input", target: "result", targetPort: "result" }],
        start: ["input"],
        end: ["result"],
      };
      const graphResponse = await request(`/api/projects/${project.id}/graphs`, {
        method: "POST",
        body: JSON.stringify({
          name: "Pass through",
          description: "",
          definition,
          viewport: { x: 0, y: 0, zoom: 1 },
          positions: { result: { x: 0, y: 0 } },
        }),
      });
      expect(graphResponse.status).toBe(201);
      const graph = (await graphResponse.json() as { graph: { id: string } }).graph;
      const runResponse = await request(`/api/graphs/${graph.id}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: "hello graph" }),
      });
      expect(runResponse.status).toBe(202);
      const run = (await runResponse.json() as { run: { id: string } }).run;
      await expect(request(`/api/graph-runs/${run.id}`).then((response) => response.json()))
        .resolves.toMatchObject({ run: { status: "completed", output: "hello graph" } });
    } finally {
      await server.stop();
    }
  });

  it("recovers a persisted Trae waiting safe point as completed and unpaused", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-trae-waiting-recovery-"));
    const projectDir = join(dataDir, "project");
    mkdirSync(projectDir);
    tempDirs.push(dataDir);
    const databasePath = join(dataDir, "ain-one.sqlite");
    const database = createDatabase(databasePath);
    const repositories = createRepositories(database);
    const project = repositories.createProject(projectDir, "project");
    const conversation = repositories.createConversation({
      projectId: project.id, agentProductId: "trae", modelId: "test", autoQueue: true,
    });
    repositories.enqueueMessage(conversation.id, "finished before restart");
    const claimed = repositories.claimNextMessage(conversation.id, {
      modelId: "test", permissionMode: "request_approval", pluginVersions: [], autoQueue: true,
    })!;
    repositories.markTurnRunning(claimed.turn.id, "native-turn");
    repositories.appendEvent(conversation.id, {
      type: "queue_status", payload: { status: "waiting", hasPendingInput: false, acceptingInput: true },
    });
    database.close();

    const server = await startServer({
      dataDir, port: 0, token: "trae-waiting-recovery-token",
      connectors: { trae: {
        id: "trae",
        probe: async () => ({ status: "available", version: "test" }),
        fetchCatalog: async () => ({ models: ["test"], permissionModes: [] }),
        closeSession: async () => undefined,
      } as unknown as AgentConnector },
      pluginHub: createPluginHub({ dataDir, skillRoots: {} }),
    });
    await server.stop();

    const reopened = createDatabase(databasePath);
    const recovered = createRepositories(reopened);
    expect(recovered.getTurn(claimed.turn.id)?.status).toBe("completed");
    expect(recovered.getConversation(conversation.id)?.queuePaused).toBe(false);
    reopened.close();
  });

  it("interrupts active Turns from a reopened file database without redispatching pending work", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-active-recovery-"));
    const projectDir = join(dataDir, "project");
    mkdirSync(projectDir);
    tempDirs.push(dataDir);
    const databasePath = join(dataDir, "ain-one.sqlite");
    const database = createDatabase(databasePath);
    const repositories = createRepositories(database);
    const project = repositories.createProject(projectDir, "project");
    const activeTurns: Array<{
      status: ActiveTurnStatus;
      conversationId: string;
      turnId: string;
      pendingContent: string;
    }> = [];
    const snapshot = {
      modelId: "test",
      permissionMode: "request_approval" as const,
      pluginVersions: [],
    };

    for (const status of ["starting", "running", "cancelling"] as const) {
      const conversation = repositories.createConversation({
        projectId: project.id,
        agentProductId: "codex",
        modelId: "test",
      });
      repositories.enqueueMessage(conversation.id, `${status} active`);
      const claimed = repositories.claimNextMessage(conversation.id, snapshot);
      if (!claimed) {
        throw new Error(`expected ${status} Turn`);
      }
      if (status !== "starting") {
        repositories.markTurnRunning(claimed.turn.id, `${status}-native-turn`);
      }
      if (status === "cancelling") {
        repositories.markTurnCancelling(claimed.turn.id);
      }
      const pendingContent = `${status} pending`;
      repositories.enqueueMessage(conversation.id, pendingContent);
      activeTurns.push({
        status,
        conversationId: conversation.id,
        turnId: claimed.turn.id,
        pendingContent,
      });
    }
    database.close();

    const prompts: string[] = [];
    const connector = {
      id: "codex",
      probe: async () => ({ status: "available", version: "test" }),
      fetchCatalog: async () => ({ models: ["test"], permissionModes: [] }),
      createOrResumeSession: async (input: { conversationId: string }) => ({
        id: input.conversationId,
        nativeSessionId: "native-session",
      }),
      startTurn: async (_session: unknown, input: { content: string }) => {
        prompts.push(input.content);
        return { nativeTurnId: "native-turn" };
      },
      closeSession: async () => undefined,
    } as unknown as AgentConnector;
    const server = await startServer({
      dataDir,
      port: 0,
      token: "active-recovery-token",
      connectors: { codex: connector },
      pluginHub: createPluginHub({ dataDir, skillRoots: {} }),
    });
    await server.stop();

    expect(prompts).toEqual([]);
    const reopened = createDatabase(databasePath);
    const recovered = createRepositories(reopened);
    for (const active of activeTurns) {
      expect(recovered.getTurn(active.turnId)?.status).toBe("interrupted");
      expect(recovered.getConversation(active.conversationId)?.queuePaused).toBe(true);
      expect(recovered.listQueuedMessages(active.conversationId)).toEqual([
        expect.objectContaining({ content: active.pendingContent }),
      ]);
    }
    reopened.close();
  });

  it("dispatches unpaused pending messages on startup", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-pending-recovery-"));
    const projectDir = join(dataDir, "project");
    mkdirSync(projectDir);
    tempDirs.push(dataDir);
    const database = createDatabase(join(dataDir, "ain-one.sqlite"));
    const repositories = createRepositories(database);
    const project = repositories.createProject(projectDir, "project");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "test",
    });
    repositories.enqueueMessage(conversation.id, "resume after restart");
    database.close();

    const prompts: string[] = [];
    const connector = {
      id: "codex",
      probe: async () => ({ status: "available", version: "test" }),
      fetchCatalog: async () => ({ models: ["test"], permissionModes: [] }),
      createOrResumeSession: async (input: { conversationId: string }) => ({
        id: input.conversationId,
        nativeSessionId: "native-session",
      }),
      startTurn: async (_session: unknown, input: { content: string }) => {
        prompts.push(input.content);
        return { nativeTurnId: "native-turn" };
      },
      closeSession: async () => undefined,
    } as unknown as AgentConnector;
    const server = await startServer({
      dataDir,
      port: 0,
      token: "pending-recovery-token",
      connectors: { codex: connector },
      pluginHub: createPluginHub({ dataDir, skillRoots: {} }),
    });

    try {
      expect(prompts).toEqual(["resume after restart"]);
    } finally {
      await server.stop();
    }
  });

  it("does not redispatch a persisted OpenCode queue after the connector is retired", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-opencode-recovery-"));
    const projectDir = join(dataDir, "project");
    mkdirSync(projectDir);
    tempDirs.push(dataDir);
    const databasePath = join(dataDir, "ain-one.sqlite");
    const database = createDatabase(databasePath);
    database.prepare("INSERT INTO projects VALUES (?, ?, ?, NULL, ?, ?)")
      .run("project-1", projectDir, "Project", "created", "updated");
    database.exec(`
      INSERT INTO conversations (
        id, project_id, agent_product_id, model_id, permission_mode,
        queue_paused, auto_queue, title, archived_at, created_at, updated_at
      ) VALUES ('opencode-conversation', 'project-1', 'opencode', NULL, 'request_approval', 0, 0, 'Legacy OpenCode', NULL, 'created', 'updated');
      INSERT INTO queued_messages (
        id, conversation_id, enqueue_seq, content, status, claimed_turn_id,
        retry_of_turn_id, created_at, updated_at, delivery_id
      ) VALUES ('pending-message', 'opencode-conversation', 1, 'must remain durable', 'pending', NULL, NULL, 'created', 'updated', NULL);
    `);
    database.close();

    const server = await startServer({
      dataDir,
      port: 0,
      token: "opencode-recovery-token",
      connectors: {},
      discoverLocalPlugins: false,
    });
    await server.stop();

    const reopened = createDatabase(databasePath);
    expect(reopened.prepare(`
      SELECT queue_paused, archived_at
      FROM conversations WHERE id = 'opencode-conversation'
    `).get()).toEqual({ queue_paused: 1, archived_at: expect.any(String) });
    expect(reopened.prepare(`
      SELECT content, status
      FROM queued_messages WHERE id = 'pending-message'
    `).get()).toEqual({ content: "must remain durable", status: "pending" });
    expect(reopened.prepare(`
      SELECT code FROM migration_diagnostics
      WHERE entity_type = 'conversation' AND entity_id = 'opencode-conversation'
    `).get()).toEqual({ code: "opencode_connector_retired" });
    reopened.close();
  });

  it("closes recovered Agent sessions when the API port cannot bind", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-startup-bind-failure-"));
    const projectDir = join(dataDir, "project");
    mkdirSync(projectDir);
    tempDirs.push(dataDir);
    const database = createDatabase(join(dataDir, "ain-one.sqlite"));
    const repositories = createRepositories(database);
    const project = repositories.createProject(projectDir, "project");
    const conversation = repositories.createConversation({
      projectId: project.id,
      agentProductId: "codex",
      modelId: "test",
    });
    repositories.enqueueMessage(conversation.id, "resume before bind");
    database.close();

    const closeSession = vi.fn(async () => undefined);
    const connector = {
      id: "codex",
      probe: async () => ({ status: "available", version: "test" }),
      fetchCatalog: async () => ({ models: ["test"], permissionModes: [] }),
      createOrResumeSession: async (input: { conversationId: string }) => ({
        id: input.conversationId,
        nativeSessionId: "native-session",
      }),
      startTurn: async () => ({ nativeTurnId: "native-turn" }),
      closeSession,
    } as unknown as AgentConnector;
    const blocker = createHttpServer();
    await new Promise<void>((resolvePromise) => blocker.listen(0, "127.0.0.1", resolvePromise));
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("expected blocker TCP address");
    }

    try {
      await expect(startServer({
        dataDir,
        port: address.port,
        token: "bind-failure-token",
        connectors: { codex: connector },
        pluginHub: createPluginHub({ dataDir, skillRoots: {} }),
      })).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(closeSession).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        blocker.close((error) => error ? rejectPromise(error) : resolvePromise());
      });
    }
  });

  it("wires the native Agent registry into the running API", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-startup-"));
    tempDirs.push(dataDir);
    const token = "startup-token";
    const connector = {
      id: "codex",
      probe: async () => ({ status: "available", version: "wired-test" }),
      fetchCatalog: async () => ({ models: ["wired-model"], permissionModes: [] }),
    } as unknown as AgentConnector;
    const server = await startServer({
      dataDir,
      port: 0,
      token,
      connectors: { codex: connector },
      discoverLocalPlugins: false,
    });

    try {
      const response = await fetch(`${server.url}/api/agents`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        agents: Array<{ agentProductId: string; probe: { status: string } }>;
      };
      expect(payload.agents).toEqual([
        {
          agentProductId: "codex",
          executablePath: "codex",
          executablePathOverride: null,
          enabled: true,
          probe: { status: "available", version: "wired-test" },
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("serves installed plugins from the composed PluginHub", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-plugins-"));
    const skillDir = join(dataDir, "formatter");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "# Formatter\n");
    tempDirs.push(dataDir);
    const token = "plugin-token";
    const server = await startServer({ dataDir, port: 0, token, discoverLocalPlugins: false });

    try {
      const install = await fetch(`${server.url}/api/plugins/install`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: skillDir,
          compatibility: { codex: { kind: "skill" } },
        }),
      });
      expect(install.status).toBe(201);

      const list = await fetch(`${server.url}/api/plugins`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.status).toBe(200);
      const payload = (await list.json()) as {
        plugins: Array<{ pluginId: string; compatibleAgents: string[] }>;
      };
      expect(payload.plugins).toEqual([
        expect.objectContaining({ pluginId: "formatter", compatibleAgents: ["codex"] }),
      ]);
    } finally {
      await server.stop();
    }
  });

  it("filters enabled plugins by the Conversation Agent before dispatch and detail reads", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-plugin-resolution-"));
    const projectDir = join(dataDir, "project");
    const skillDir = join(dataDir, "codex-only");
    mkdirSync(projectDir);
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "# Codex only\n");
    tempDirs.push(dataDir);
    const pluginHub = createPluginHub({ dataDir, skillRoots: {} });
    const installed = await pluginHub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });
    const started: Array<{ pluginVersions: Array<{ pluginId: string; versionId: string }> }> = [];
    const connector = {
      id: "claude",
      probe: async () => ({ status: "available", version: "test" }),
      fetchCatalog: async () => ({ models: ["test"], permissionModes: ["request_approval"] }),
      createOrResumeSession: async (input: { conversationId: string }) => ({
        id: input.conversationId,
        nativeSessionId: "native-session",
      }),
      startTurn: async (_session: unknown, input: { snapshot: typeof started[number] }) => {
        started.push(input.snapshot);
        return { nativeTurnId: "native-turn" };
      },
      closeSession: async () => undefined,
    } as unknown as AgentConnector;
    const token = "plugin-resolution-token";
    const server = await startServer({
      dataDir,
      port: 0,
      token,
      connectors: { claude: connector },
      pluginHub,
    });
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    try {
      const projectResponse = await fetch(`${server.url}/api/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: projectDir }),
      });
      const project = (await projectResponse.json()) as { project: { id: string } };
      await fetch(`${server.url}/api/plugins/enablements/global`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          pluginVersions: [{ pluginId: installed.pluginId, versionId: installed.versionId }],
        }),
      });
      const conversationResponse = await fetch(`${server.url}/api/conversations`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectId: project.project.id,
          agentProductId: "claude",
          modelId: "test",
        }),
      });
      const conversation = (await conversationResponse.json()) as {
        conversation: { id: string };
      };

      const incompatible = await fetch(
        `${server.url}/api/plugins/enablements/conversation/${conversation.conversation.id}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            pluginVersions: [{ pluginId: installed.pluginId, versionId: installed.versionId }],
          }),
        },
      );
      expect(incompatible.status).toBe(400);

      const detail = await fetch(
        `${server.url}/api/conversations/${conversation.conversation.id}`,
        { headers },
      );
      expect(await detail.json()).toMatchObject({ pluginVersions: [] });

      await fetch(`${server.url}/api/conversations/${conversation.conversation.id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "start without codex plugin" }),
      });
      expect(started).toEqual([expect.objectContaining({ pluginVersions: [] })]);
    } finally {
      await server.stop();
    }
  });

  it("imports configured native Skills at startup and on server-owned refresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "ain-one-plugin-discovery-"));
    const dataDir = join(root, "data");
    const skillRoot = join(root, "codex-skills");
    const first = join(skillRoot, "first-skill");
    mkdirSync(first, { recursive: true });
    writeFileSync(join(first, "SKILL.md"), "# First\n");
    tempDirs.push(root);
    const token = "plugin-discovery-token";
    const pluginHub = createPluginHub({ dataDir, skillRoots: { codex: skillRoot } });
    const server = await startServer({ dataDir, port: 0, token, pluginHub });
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    try {
      const startup = await fetch(`${server.url}/api/plugins`, { headers });
      expect(await startup.json()).toMatchObject({
        plugins: [expect.objectContaining({ pluginId: "first-skill" })],
      });
      const startupEnablements = await fetch(`${server.url}/api/plugins/enablements/global`, { headers });
      expect(await startupEnablements.json()).toMatchObject({
        pluginVersions: [expect.objectContaining({ pluginId: "first-skill" })],
      });

      const second = join(skillRoot, "second-skill");
      mkdirSync(second);
      writeFileSync(join(second, "SKILL.md"), "# Second\n");
      const arbitrary = join(root, "outside-skill");
      mkdirSync(arbitrary);
      writeFileSync(join(arbitrary, "SKILL.md"), "# Outside\n");

      const refresh = await fetch(`${server.url}/api/plugins/scan`, {
        method: "POST",
        headers,
        body: JSON.stringify({ items: [{ agentProductId: "codex", path: arbitrary }] }),
      });
      expect(refresh.status).toBe(200);
      const refreshed = (await refresh.json()) as {
        plugins: Array<{ pluginId: string }>;
      };
      expect(refreshed.plugins).toEqual(
        expect.arrayContaining([expect.objectContaining({ pluginId: "second-skill" })]),
      );
      const refreshedEnablements = await fetch(`${server.url}/api/plugins/enablements/global`, { headers });
      expect(await refreshedEnablements.json()).toMatchObject({
        pluginVersions: expect.arrayContaining([
          expect.objectContaining({ pluginId: "first-skill" }),
          expect.objectContaining({ pluginId: "second-skill" }),
        ]),
      });

      const list = await fetch(`${server.url}/api/plugins`, { headers });
      const payload = (await list.json()) as { plugins: Array<{ pluginId: string }> };
      expect(payload.plugins.map((plugin) => plugin.pluginId).sort()).toEqual([
        "first-skill",
        "second-skill",
      ]);
    } finally {
      await server.stop();
    }
  });

  it("enables only the latest semantic version when discovery finds multiple versions", async () => {
    const root = mkdtempSync(join(tmpdir(), "ain-one-plugin-latest-"));
    const dataDir = join(root, "data");
    const oldRoot = join(root, "old");
    const newRoot = join(root, "new");
    const oldSkill = join(oldRoot, "shared-skill");
    const newSkill = join(newRoot, "shared-skill");
    for (const [skillPath, version, content] of [
      [oldSkill, "1.9.0", "old"],
      [newSkill, "1.10.0", "new"],
    ] as const) {
      mkdirSync(join(skillPath, ".codex-plugin"), { recursive: true });
      writeFileSync(join(skillPath, "SKILL.md"), `# Shared\n\n${content}\n`);
      writeFileSync(
        join(skillPath, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: "shared-skill", version }),
      );
    }
    tempDirs.push(root);
    const token = "plugin-latest-token";
    const pluginHub = createPluginHub({
      dataDir,
      skillRoots: {},
      discoverSkillRoots: async () => [
        { agentProductId: "codex", path: oldRoot },
        { agentProductId: "codex", path: newRoot },
      ],
    });
    const server = await startServer({ dataDir, port: 0, token, pluginHub });
    const headers = { authorization: `Bearer ${token}` };

    try {
      const plugins = await fetch(`${server.url}/api/plugins`, { headers })
        .then((response) => response.json()) as {
          plugins: Array<{ pluginId: string; versionId: string; version?: string }>;
        };
      const latest = plugins.plugins.find((plugin) => plugin.version === "1.10.0");
      const enablements = await fetch(`${server.url}/api/plugins/enablements/global`, { headers })
        .then((response) => response.json()) as {
          pluginVersions: Array<{ pluginId: string; versionId: string }>;
        };

      expect(enablements.pluginVersions).toEqual([{
        pluginId: "shared-skill",
        versionId: latest?.versionId,
      }]);
    } finally {
      await server.stop();
    }
  });

  it("enables newly discovered unversioned content even when its hash is smaller", async () => {
    const root = mkdtempSync(join(tmpdir(), "ain-one-plugin-refresh-order-"));
    const dataDir = join(root, "data");
    const skillRoot = join(root, "codex-skills");
    const skillPath = join(skillRoot, "shared-skill");
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(join(skillPath, "SKILL.md"), "# Shared\n\nold-2\n");
    tempDirs.push(root);
    const token = "plugin-refresh-order-token";
    const pluginHub = createPluginHub({ dataDir, skillRoots: { codex: skillRoot } });
    const server = await startServer({ dataDir, port: 0, token, pluginHub });
    const headers = { authorization: `Bearer ${token}` };

    try {
      const oldVersion = pluginHub.listInstalled()[0]!;
      writeFileSync(join(skillPath, "SKILL.md"), "# Shared\n\nnew-2\n");

      const refresh = await fetch(`${server.url}/api/plugins/scan`, { method: "POST", headers });
      expect(refresh.status).toBe(200);
      const newVersion = pluginHub.listInstalled().find(
        (plugin) => plugin.versionId !== oldVersion.versionId,
      )!;
      expect(newVersion.versionId.localeCompare(oldVersion.versionId)).toBeLessThan(0);

      const enablements = await fetch(`${server.url}/api/plugins/enablements/global`, { headers })
        .then((response) => response.json()) as {
          pluginVersions: Array<{ pluginId: string; versionId: string }>;
        };
      expect(enablements.pluginVersions).toEqual([{
        pluginId: "shared-skill",
        versionId: newVersion.versionId,
      }]);
    } finally {
      await server.stop();
    }
  });

  it("keeps the later discovered unversioned root enabled when an earlier root changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ain-one-plugin-root-order-"));
    const dataDir = join(root, "data");
    const earlierRoot = join(root, "earlier");
    const laterRoot = join(root, "later");
    const earlierSkill = join(earlierRoot, "shared-skill");
    const laterSkill = join(laterRoot, "shared-skill");
    mkdirSync(earlierSkill, { recursive: true });
    mkdirSync(laterSkill, { recursive: true });
    writeFileSync(join(earlierSkill, "SKILL.md"), "# Shared\n\nearlier-v1\n");
    writeFileSync(join(laterSkill, "SKILL.md"), "# Shared\n\nlater-wins\n");
    tempDirs.push(root);
    const token = "plugin-root-order-token";
    const pluginHub = createPluginHub({
      dataDir,
      skillRoots: {},
      discoverSkillRoots: async () => [
        { agentProductId: "codex", path: earlierRoot },
        { agentProductId: "codex", path: laterRoot },
      ],
    });
    const server = await startServer({ dataDir, port: 0, token, pluginHub });
    const headers = { authorization: `Bearer ${token}` };

    try {
      const laterVersion = pluginHub.listInstalled().find((plugin) =>
        readFileSync(join(plugin.canonicalPath, "SKILL.md"), "utf8").includes("later-wins"),
      )!;
      writeFileSync(join(earlierSkill, "SKILL.md"), "# Shared\n\nearlier-v2\n");

      const refresh = await fetch(`${server.url}/api/plugins/scan`, { method: "POST", headers });
      expect(refresh.status).toBe(200);
      const enablements = await fetch(`${server.url}/api/plugins/enablements/global`, { headers })
        .then((response) => response.json()) as {
          pluginVersions: Array<{ pluginId: string; versionId: string }>;
        };
      expect(enablements.pluginVersions).toEqual([{
        pluginId: "shared-skill",
        versionId: laterVersion.versionId,
      }]);
    } finally {
      await server.stop();
    }
  });

  it("repairs a missing managed Skill materialization through the control API", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-plugin-repair-"));
    const skillDir = join(dataDir, "formatter");
    const skillRoot = join(dataDir, "codex-skills");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "# Formatter\n");
    tempDirs.push(dataDir);
    const token = "plugin-repair-token";
    const pluginHub = createPluginHub({ dataDir, skillRoots: { codex: skillRoot } });
    const server = await startServer({ dataDir, port: 0, token, pluginHub });

    try {
      const install = await fetch(`${server.url}/api/plugins/install`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: skillDir,
          compatibility: { codex: { kind: "skill" } },
        }),
      });
      const installed = (await install.json()) as {
        plugin: { pluginId: string; versionId: string };
      };

      const repair = await fetch(
        `${server.url}/api/plugins/${installed.plugin.pluginId}/versions/${installed.plugin.versionId}/materializations/codex/repair`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      expect(repair.status).toBe(200);

      const list = await fetch(`${server.url}/api/plugins`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await list.json()).toMatchObject({
        plugins: [
          {
            pluginId: installed.plugin.pluginId,
            materializations: [
              { agentProductId: "codex", status: "materialized", repairable: false },
            ],
          },
        ],
      });
    } finally {
      await server.stop();
    }
  });

  it("rejects Skill materialization repair while the Agent has an active Turn", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-plugin-repair-active-"));
    const projectDir = join(dataDir, "project");
    const skillDir = join(dataDir, "formatter");
    const skillRoot = join(dataDir, "codex-skills");
    mkdirSync(projectDir);
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "# Formatter\n");
    tempDirs.push(dataDir);

    const pluginHub = createPluginHub({ dataDir, skillRoots: { codex: skillRoot } });
    const installed = await pluginHub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });
    const repair = vi.spyOn(pluginHub, "repairMaterialization");
    const connector = {
      id: "codex",
      probe: async () => ({ status: "available", version: "test" }),
      fetchCatalog: async () => ({ models: ["test"], permissionModes: ["request_approval"] }),
      createOrResumeSession: async (input: { conversationId: string }) => ({
        id: input.conversationId,
        nativeSessionId: "native-session",
      }),
      startTurn: async () => ({ nativeTurnId: "native-turn" }),
      closeSession: async () => undefined,
    } as unknown as AgentConnector;
    const token = "plugin-repair-active-token";
    const server = await startServer({
      dataDir,
      port: 0,
      token,
      connectors: { codex: connector },
      pluginHub,
    });
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    try {
      const projectResponse = await fetch(`${server.url}/api/projects`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: projectDir }),
      });
      const project = (await projectResponse.json()) as { project: { id: string } };
      const conversationResponse = await fetch(`${server.url}/api/conversations`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectId: project.project.id,
          agentProductId: "codex",
          modelId: "test",
        }),
      });
      const conversation = (await conversationResponse.json()) as {
        conversation: { id: string };
      };
      await fetch(`${server.url}/api/conversations/${conversation.conversation.id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "keep running" }),
      });

      const response = await fetch(
        `${server.url}/api/plugins/${installed.pluginId}/versions/${installed.versionId}/materializations/codex/repair`,
        { method: "POST", headers, body: "{}" },
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: "turn_active",
          message: "Plugin materialization can change only between Turns",
        },
      });
      expect(repair).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("rejects malformed external compatibility declarations before persistence", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-plugin-validation-"));
    const skillDir = join(dataDir, "formatter");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "# Formatter\n");
    tempDirs.push(dataDir);
    const token = "plugin-validation-token";
    const server = await startServer({ dataDir, port: 0, token, discoverLocalPlugins: false });

    try {
      const install = await fetch(`${server.url}/api/plugins/install`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          path: skillDir,
          compatibility: { codex: { kind: "future-format" } },
        }),
      });
      expect(install.status).toBe(400);

      const list = await fetch(`${server.url}/api/plugins`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await list.json()).toMatchObject({ plugins: [] });
    } finally {
      await server.stop();
    }
  });

  it.each([
    ["array payload", []],
    ["empty path", { path: "   " }],
    [
      "unknown Agent compatibility",
      { path: "PLUGIN_PATH", compatibility: { unknown: { kind: "skill" } } },
    ],
  ])("returns 400 for %s without installing a plugin", async (_name, rawBody) => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-plugin-invalid-input-"));
    const skillDir = join(dataDir, "formatter");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "# Formatter\n");
    tempDirs.push(dataDir);
    const token = "plugin-invalid-input-token";
    const server = await startServer({ dataDir, port: 0, token, discoverLocalPlugins: false });

    try {
      const body = JSON.stringify(
        rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
          ? JSON.parse(JSON.stringify(rawBody).replace("PLUGIN_PATH", skillDir))
          : rawBody,
      );
      const install = await fetch(`${server.url}/api/plugins/install`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
      });
      expect(install.status).toBe(400);

      const list = await fetch(`${server.url}/api/plugins`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await list.json()).toMatchObject({ plugins: [] });
    } finally {
      await server.stop();
    }
  });

  it("validates and reloads a persisted Agent executable override", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-agent-settings-"));
    const executable = join(dataDir, "fake-codex");
    writeFileSync(executable, "#!/bin/sh\nprintf 'codex-cli 9.9.9\\n'\n");
    chmodSync(executable, 0o755);
    tempDirs.push(dataDir);
    const token = "agent-settings-token";

    const first = await startServer({
      dataDir,
      port: 0,
      token,
      pluginHub: createPluginHub({ dataDir, skillRoots: {} }),
    });
    const saved = await fetch(`${first.url}/api/agents/codex/settings`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ executablePath: executable }),
    });
    expect(saved.status).toBe(200);
    await first.stop();

    const second = await startServer({
      dataDir,
      port: 0,
      token,
      pluginHub: createPluginHub({ dataDir, skillRoots: {} }),
    });
    try {
      const response = await fetch(`${second.url}/api/agents`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const payload = (await response.json()) as {
        agents: Array<{
          agentProductId: string;
          executablePath: string;
          executablePathOverride: string | null;
          probe: { status: string; version?: string };
        }>;
      };
      expect(payload.agents.find((agent) => agent.agentProductId === "codex")).toEqual({
        agentProductId: "codex",
        executablePath: realpathSync(executable),
        executablePathOverride: realpathSync(executable),
        enabled: true,
        probe: expect.objectContaining({ version: "9.9.9" }),
      });
    } finally {
      await second.stop();
    }
  });

  it("rejects an executable override that does not identify the Agent Product", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-agent-identity-"));
    tempDirs.push(dataDir);
    const token = "agent-identity-token";
    const server = await startServer({
      dataDir,
      port: 0,
      token,
      pluginHub: createPluginHub({ dataDir, skillRoots: {} }),
    });

    try {
      const saved = await fetch(`${server.url}/api/agents/codex/settings`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ executablePath: "/usr/bin/true" }),
      });
      expect(saved.status).toBe(400);
      expect(await saved.json()).toEqual({
        error: {
          code: "agent_identity_mismatch",
          message: "Executable did not identify as codex",
        },
      });

      const agents = await fetch(`${server.url}/api/agents`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const payload = (await agents.json()) as {
        agents: Array<{ agentProductId: string; executablePathOverride: string | null }>;
      };
      expect(payload.agents.find((agent) => agent.agentProductId === "codex")?.executablePathOverride)
        .toBeNull();
    } finally {
      await server.stop();
    }
  });

  it("rejects enabling a plugin version with no compatible Agent Product", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ain-one-plugin-no-compat-"));
    const skillDir = join(dataDir, "unavailable-skill");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "# Unavailable\n");
    tempDirs.push(dataDir);
    const pluginHub = createPluginHub({ dataDir, skillRoots: {} });
    const installed = await pluginHub.installLocal({ path: skillDir });
    const token = "plugin-no-compat-token";
    const server = await startServer({ dataDir, port: 0, token, pluginHub });

    try {
      const response = await fetch(`${server.url}/api/plugins/enablements/global`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          pluginVersions: [{ pluginId: installed.pluginId, versionId: installed.versionId }],
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "plugin_incompatible",
          message: "Plugin has no compatible Agent Product",
        },
      });
    } finally {
      await server.stop();
    }
  });
});
