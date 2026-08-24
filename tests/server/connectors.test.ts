import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentCatalog,
  AgentConnector,
  AgentProductId,
  AgentProbe,
  ConnectorEvent,
  LiveSession,
  NormalizedError,
  PermissionMode,
  SessionInput,
  TerminalTurnStatus,
} from "../../src/shared/contracts.js";
import { UnsupportedCapabilityError } from "../../src/server/connectors/base.js";
import { ClaudeConnector } from "../../src/server/connectors/claude.js";
import { CodexConnector } from "../../src/server/connectors/codex.js";
import { OpenCodeConnector } from "../../src/server/connectors/opencode.js";
import { createOfficialOpenCodeSdkAdapter } from "../../src/server/connectors/opencode-sdk.js";
import { createConnectorRegistry } from "../../src/server/connectors/registry.js";
import { TraeConnector } from "../../src/server/connectors/trae.js";

const opencodeSdk = vi.hoisted(() => ({
  createOpencode: vi.fn(),
  createOpencodeClient: vi.fn(),
}));

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencode: opencodeSdk.createOpencode,
  createOpencodeClient: opencodeSdk.createOpencodeClient,
}));

type SpawnCall = {
  command: string;
  args: string[];
  shell: boolean | undefined;
  detached: boolean | undefined;
  killSignals: Array<NodeJS.Signals | number | undefined>;
};

type TerminalCall = {
  conversationId: string;
  turnId: string;
  nativeTurnId: string | null;
  status: TerminalTurnStatus;
  error?: NormalizedError;
};

type FixtureContext = {
  root: string;
  projectPath: string;
  recordPath: string;
  modelsCachePath: string;
  spawnCalls: SpawnCall[];
};

type ConnectorFactory = (ctx: FixtureContext, env?: NodeJS.ProcessEnv) => AgentConnector;

const roots: string[] = [];

afterEach(() => {
  opencodeSdk.createOpencode.mockReset();
  opencodeSdk.createOpencodeClient.mockReset();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("native agent connectors", () => {
  const matrix: Array<{
    id: AgentProductId;
    factory: ConnectorFactory;
    probeStatus: AgentProbe["status"];
    catalog: AgentCatalog;
    startArgs: string[] | ((args: string[]) => void);
    resumeArgs: string[];
  }> = [
    {
      id: "codex",
      factory: (ctx, env) =>
        new CodexConnector({
          executable: fixtureBinary("fake-codex.mjs"),
          spawn: spawnRecorder(ctx.spawnCalls),
          modelsCachePath: ctx.modelsCachePath,
          env: env ?? fixtureEnv(ctx.recordPath),
          killTimeoutMs: 50,
        }),
      probeStatus: "capability_limited",
      catalog: {
        models: ["gpt-5", "gpt-5-mini"],
        permissionModes: ["request_approval", "help_me_approve", "full_access"],
      },
      startArgs: ["exec", "--json", "--skip-git-repo-check", "--approve-for-me"],
      resumeArgs: [
        "exec",
        "resume",
        "native-session-codex",
        "--json",
        "--skip-git-repo-check",
        "-c",
        'approvals_reviewer="auto_review"',
      ],
    },
    {
      id: "claude",
      factory: (ctx, env) =>
        new ClaudeConnector({
          executable: fixtureBinary("fake-claude.mjs"),
          spawn: spawnRecorder(ctx.spawnCalls),
          env: { ...(env ?? fixtureEnv(ctx.recordPath)), HOME: ctx.root },
          killTimeoutMs: 50,
        }),
      probeStatus: "capability_limited",
      catalog: {
        models: ["sonnet", "opus", "haiku", "fable"],
        permissionModes: ["request_approval", "help_me_approve", "full_access"],
      },
      startArgs: (args) => {
        expect(args.slice(0, 5)).toEqual([
          "--print",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
        ]);
        expect(args).toContain("--session-id");
        expect(args).toContain("--permission-mode");
        expect(args).toContain("auto");
      },
      resumeArgs: [
        "--print",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--resume",
        "native-session-claude",
        "--permission-mode",
        "auto",
      ],
    },
    {
      id: "trae",
      factory: (ctx, env) =>
        new TraeConnector({
          executable: fixtureBinary("fake-traecli.mjs"),
          spawn: spawnRecorder(ctx.spawnCalls),
          env: env ?? fixtureEnv(ctx.recordPath),
          killTimeoutMs: 50,
        }),
      probeStatus: "capability_limited",
      catalog: {
        models: ["trae-sonnet", "trae-opus"],
        permissionModes: ["request_approval", "help_me_approve", "full_access"],
      },
      startArgs: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--permission-mode",
        "default",
      ],
      resumeArgs: [
        "exec",
        "resume",
        "native-session-trae",
        "--json",
        "--skip-git-repo-check",
        "--permission-mode",
        "default",
      ],
    },
  ];

  for (const fixture of matrix) {
    it(`${fixture.id} probes, catalogs, starts, resumes, normalizes, and reports terminal status once`, async () => {
      const ctx = createFixtureContext();
      const connector = fixture.factory(ctx);
      const terminalCalls: TerminalCall[] = [];
      setTurnCallbacks(connector, terminalCalls);

      expect(await connector.probe()).toMatchObject({ status: fixture.probeStatus });
      expect(await connector.fetchCatalog(ctx.projectPath)).toEqual(fixture.catalog);

      const first = await startTurn(connector, fixture.id, ctx.projectPath, null);
      await waitForSettled(first.session);
      const resumed = await startTurn(
        connector,
        fixture.id,
        ctx.projectPath,
        `native-session-${fixture.id}`,
      );
      await waitForSettled(resumed.session);

      expect(first.nativeTurnId).toBe(`native-turn-${fixture.id}`);
      if (fixture.id === "claude") {
        expect(first.session.nativeSessionId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      } else {
        expect(first.session.nativeSessionId).toBe(`native-session-${fixture.id}`);
        expect(first.nativeSessionIds).toContain(`native-session-${fixture.id}`);
      }
      expect(first.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "assistant_message",
          "reasoning",
          "tool",
          "shell",
          "file",
          "usage",
          "warning",
          "turn_status",
        ]),
      );
      expect(first.events.find((event) => event.type === "assistant_message")?.payload).toEqual(
        expect.objectContaining({ text: `hello from ${fixture.id}` }),
      );
      expect(first.events.find((event) => event.type === "reasoning")?.payload).toEqual(
        expect.objectContaining({ summary: `reasoning from ${fixture.id}` }),
      );
      expect(first.events.find((event) => event.type === "tool")?.payload).toEqual(
        expect.objectContaining({ name: "search" }),
      );
      expect(first.events.find((event) => event.type === "usage")?.payload).toEqual(
        expect.objectContaining({ summary: "10 input / 20 output tokens" }),
      );
      expect(terminalCalls).toHaveLength(2);
      expect(terminalCalls.every((call) => call.status === "completed")).toBe(true);
      expect(ctx.spawnCalls.every((call) => call.shell === false)).toBe(true);

      const execRecords = readRecords(ctx.recordPath).filter((record) => record.commandType === "exec");
      expect(execRecords).toHaveLength(2);
      assertArgs(execRecords[0]?.args as string[], fixture.startArgs);
      expect(execRecords[0]?.args).not.toContain("say hello");
      expect(execRecords[0]?.stdin).toBe("say hello");
      expect(execRecords[1]?.args).toEqual(fixture.resumeArgs);
    });

    it(`${fixture.id} confirms cancellation only after the child closes`, async () => {
      const ctx = createFixtureContext();
      const connector = fixture.factory(ctx, {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "cancel",
      });
      const terminalCalls: TerminalCall[] = [];
      setTurnCallbacks(connector, terminalCalls);

      const started = await startTurn(connector, fixture.id, ctx.projectPath, null);
      expect(await connector.cancelTurn(started.session, started.nativeTurnId)).toEqual({
        confirmed: true,
      });
      await waitForSettled(started.session);

      expect(terminalCalls).toHaveLength(1);
      expect(terminalCalls[0]?.status).toBe("cancelled");
      await connector.closeSession(started.session);
      await connector.closeSession(started.session);
    });
  }

  it("surfaces malformed JSON as a warning instead of crashing", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "malformed-json",
      },
      killTimeoutMs: 50,
    });

    const started = await startTurn(connector, "codex", ctx.projectPath, null);
    await waitForSettled(started.session);

    expect(started.events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        payload: expect.objectContaining({ code: "malformed_json" }),
      }),
    );
  });

  it("supports current Codex thread and item JSONL without a native Turn ID", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "codex-modern-jsonl",
      },
      killTimeoutMs: 50,
    });
    setTurnCallbacks(connector, terminalCalls);

    const started = await startTurn(connector, "codex", ctx.projectPath, null);
    await waitForSettled(started.session);

    expect(started.session.nativeSessionId).toBe("native-session-codex");
    expect(started.nativeTurnId).toBeNull();
    expect(started.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "assistant_message",
          payload: expect.objectContaining({ text: "/tmp/project" }),
        }),
        expect.objectContaining({
          type: "reasoning",
          payload: expect.objectContaining({ summary: "confirmed working directory" }),
        }),
        expect.objectContaining({
          type: "shell",
          payload: expect.objectContaining({ command: "/bin/zsh -c pwd", exit_code: 0 }),
        }),
        expect.objectContaining({
          type: "file",
          payload: expect.objectContaining({ type: "file_change" }),
        }),
        expect.objectContaining({
          type: "tool",
          payload: expect.objectContaining({ type: "mcp_tool_call", name: "docs.search" }),
        }),
        expect.objectContaining({
          type: "tool",
          payload: expect.objectContaining({ type: "web_search", name: "web_search" }),
        }),
        expect.objectContaining({
          type: "warning",
          payload: expect.objectContaining({ code: "unknown_native_event" }),
        }),
        expect.objectContaining({
          type: "warning",
          payload: expect.objectContaining({ message: "skills context shortened" }),
        }),
        expect.objectContaining({
          type: "usage",
          payload: expect.objectContaining({ summary: "12 input / 4 output tokens" }),
        }),
        expect.objectContaining({
          type: "turn_status",
          payload: expect.objectContaining({ status: "completed", nativeTurnId: null }),
        }),
      ]),
    );
    expect(terminalCalls).toEqual([
      expect.objectContaining({ status: "completed", nativeTurnId: null }),
    ]);
    expect(JSON.stringify(started.events)).not.toContain("sk-secret-value");
  });

  it("normalizes current Claude stream JSON and ignores partial duplicates", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new ClaudeConnector({
      executable: fixtureBinary("fake-claude.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: {
        ...fixtureEnv(ctx.recordPath),
        HOME: ctx.root,
        AIN_FIXTURE_SCENARIO: "claude-modern-jsonl",
      },
      killTimeoutMs: 50,
    });
    setTurnCallbacks(connector, terminalCalls);

    const started = await startTurn(connector, "claude", ctx.projectPath, null);
    await waitForSettled(started.session);

    expect(started.nativeTurnId).toBeNull();
    expect(started.nativeSessionIds).toEqual([started.session.nativeSessionId]);
    expect(started.events.filter((event) => event.type === "assistant_message")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ text: "/tmp/project" }) }),
    ]);
    expect(started.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          payload: expect.objectContaining({ summary: "checking the working directory" }),
        }),
        expect.objectContaining({
          type: "tool",
          payload: expect.objectContaining({ name: "Bash", status: "started" }),
        }),
        expect.objectContaining({
          type: "tool",
          payload: expect.objectContaining({ status: "completed", result: "/tmp/project" }),
        }),
        expect.objectContaining({
          type: "usage",
          payload: expect.objectContaining({ summary: "42 input / 7 output tokens" }),
        }),
        expect.objectContaining({
          type: "turn_status",
          payload: expect.objectContaining({ status: "completed", nativeTurnId: null }),
        }),
      ]),
    );
    expect(started.events.some((event) => event.type === "warning")).toBe(false);
    expect(terminalCalls).toEqual([
      expect.objectContaining({ status: "completed", nativeTurnId: null }),
    ]);
  });

  it("maps a Claude error result to a failed Turn", async () => {
    const ctx = createFixtureContext();
    const connector = new ClaudeConnector({
      executable: fixtureBinary("fake-claude.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: {
        ...fixtureEnv(ctx.recordPath),
        HOME: ctx.root,
        AIN_FIXTURE_SCENARIO: "claude-error-result",
      },
      killTimeoutMs: 50,
    });
    const harness = await createSessionHarness(connector, "claude", ctx.projectPath, null);

    await expect(connector.startTurn(harness.session, turnInput("claude", null))).resolves.toEqual({
      nativeTurnId: null,
    });
    await waitForSettled(harness.session);

    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "turn_status",
        payload: expect.objectContaining({
          status: "failed",
          error: expect.objectContaining({ message: "model denied" }),
        }),
      }),
    );
  });

  it("classifies Claude session-id persistence failure as definite before process start", async () => {
    const ctx = createFixtureContext();
    const connector = new ClaudeConnector({
      executable: fixtureBinary("fake-claude.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: fixtureEnv(ctx.recordPath),
    });

    await expect(
      connector.createOrResumeSession({
        projectPath: ctx.projectPath,
        conversationId: "conversation-claude",
        nativeSessionId: null,
        onNativeSessionId: async () => {
          throw new Error("persist failed");
        },
      }),
    ).rejects.toMatchObject({ definiteSessionFailure: true });
    expect(ctx.spawnCalls).toHaveLength(0);
  });

  it("keeps the highest-precedence configured Claude model without hiding standard aliases", async () => {
    const ctx = createFixtureContext();
    mkdirSync(join(ctx.root, ".claude"), { recursive: true });
    mkdirSync(join(ctx.projectPath, ".claude"), { recursive: true });
    writeFileSync(join(ctx.root, ".claude", "settings.json"), JSON.stringify({ model: "user-model" }));
    writeFileSync(
      join(ctx.projectPath, ".claude", "settings.json"),
      JSON.stringify({ model: "project-model" }),
    );
    writeFileSync(
      join(ctx.projectPath, ".claude", "settings.local.json"),
      JSON.stringify({ model: "local-model" }),
    );
    const connector = new ClaudeConnector({ env: { HOME: ctx.root } });

    await expect(connector.fetchCatalog(ctx.projectPath)).resolves.toEqual({
      models: ["local-model", "sonnet", "opus", "haiku", "fable"],
      permissionModes: ["request_approval", "help_me_approve", "full_access"],
    });
  });

  it("maps request approval explicitly for Codex", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: fixtureEnv(ctx.recordPath),
      killTimeoutMs: 50,
    });
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null);

    await connector.startTurn(harness.session, {
      ...turnInput("codex", null),
      snapshot: {
        modelId: null,
        permissionMode: "request_approval",
        pluginVersions: [],
      },
    });
    await waitForSettled(harness.session);

    const execRecord = readRecords(ctx.recordPath).find((record) => record.commandType === "exec");
    expect(execRecord?.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'approval_policy="on-request"',
    ]);
  });

  it("maps request approval explicitly for Trae", async () => {
    const ctx = createFixtureContext();
    const connector = new TraeConnector({
      executable: fixtureBinary("fake-traecli.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: fixtureEnv(ctx.recordPath),
      killTimeoutMs: 50,
    });
    const harness = await createSessionHarness(connector, "trae", ctx.projectPath, null);

    await connector.startTurn(harness.session, {
      ...turnInput("trae", null),
      snapshot: {
        modelId: null,
        permissionMode: "request_approval",
        pluginVersions: [],
      },
    });
    await waitForSettled(harness.session);

    const execRecord = readRecords(ctx.recordPath).find((record) => record.commandType === "exec");
    expect(execRecord?.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--permission-mode",
      "default",
    ]);
  });

  it("maps Trae assisted approval to its supported auto mode", async () => {
    const ctx = createFixtureContext();
    const connector = new TraeConnector({
      executable: fixtureBinary("fake-traecli.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: fixtureEnv(ctx.recordPath),
    });
    const harness = await createSessionHarness(connector, "trae", ctx.projectPath, null);

    await connector.startTurn(harness.session, turnInput("trae", null));
    await waitForSettled(harness.session);

    const execRecord = readRecords(ctx.recordPath).find((record) => record.commandType === "exec");
    expect(execRecord?.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--permission-mode",
      "auto",
    ]);
  });

  it.each([
    {
      id: "codex" as const,
      target: "codex.mcp.v1",
      expected: (args: string[]) => {
        expect(args).toContain("-c");
        expect(args).toContain(
          'mcp_servers."docs"={"command"="node","args"=["server.js"],"env"={"MODE"="test"}}',
        );
      },
    },
    {
      id: "claude" as const,
      target: "claude.mcp.v1",
      expected: (args: string[]) => {
        const flag = args.indexOf("--mcp-config");
        expect(flag).toBeGreaterThan(-1);
        expect(JSON.parse(args[flag + 1]!)).toEqual({
          mcpServers: {
            docs: { command: "node", args: ["server.js"], env: { MODE: "test" } },
          },
        });
      },
    },
    {
      id: "trae" as const,
      target: "trae.mcp.v1",
      expected: (args: string[]) => {
        expect(args).toContain("-c");
        expect(args).toContain(
          'mcp_servers."docs"={"command"="node","args"=["server.js"],"env"={"MODE"="test"}}',
        );
      },
    },
  ])("renders an Ain One MCP artifact for $id", async ({ id, target, expected }) => {
    const ctx = createFixtureContext();
    const artifactPath = join(ctx.root, `${id}-mcp.json`);
    writeFileSync(
      artifactPath,
      JSON.stringify({
        format: "ain-one.turn.mcp.v1",
        turnId: `turn-${id}-mcp`,
        agentProductId: id,
        servers: [
          {
            pluginId: "docs",
            versionId: "v1",
            target,
            server: { command: "node", args: ["server.js"], env: { MODE: "test" } },
          },
        ],
      }),
    );
    const connector = createConnectorRegistry({
      [id]: {
        executable: fixtureBinary(id === "trae" ? "fake-traecli.mjs" : `fake-${id}.mjs`),
        spawn: spawnRecorder(ctx.spawnCalls),
        modelsCachePath: ctx.modelsCachePath,
        env: { ...fixtureEnv(ctx.recordPath), HOME: ctx.root },
        killTimeoutMs: 50,
      },
    })[id]!;
    const harness = await createSessionHarness(connector, id, ctx.projectPath, null);

    const input = turnInput(id, null);
    if (id === "trae") {
      input.snapshot.permissionMode = "request_approval";
    }
    await connector.startTurn(harness.session, {
      ...input,
      mcpConfigPath: artifactPath,
    });
    await waitForSettled(harness.session);

    const execRecord = readRecords(ctx.recordPath).find((record) => record.commandType === "exec");
    expected(execRecord?.args as string[]);
  });

  it("redacts stderr diagnostics and marks non-zero exits as failed", async () => {
    const ctx = createFixtureContext();
    const connector = new TraeConnector({
      executable: fixtureBinary("fake-traecli.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "nonzero",
      },
      killTimeoutMs: 50,
    });

    const started = await startTurn(connector, "trae", ctx.projectPath, null);
    await waitForSettled(started.session);

    const terminal = started.events.find((event) => event.type === "turn_status");
    expect(terminal?.payload).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          message: expect.stringContaining("[REDACTED]"),
        }),
      }),
    );
    expect(JSON.stringify(terminal?.payload)).not.toContain("sk-live-secret");
    expect(JSON.stringify(terminal?.payload)).not.toContain("Bearer abc123");
  });

  it("recursively redacts nested event payload strings", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "nested-secret-event",
      },
      killTimeoutMs: 50,
    });

    const started = await startTurn(connector, "codex", ctx.projectPath, null);
    await waitForSettled(started.session);

    const toolEvent = started.events.find((event) => event.type === "tool");
    expect(JSON.stringify(toolEvent?.payload)).toContain("[REDACTED]");
    expect(JSON.stringify(toolEvent?.payload)).not.toContain("sk-live-secret");
    expect(JSON.stringify(toolEvent?.payload)).not.toContain("Bearer abc123");
    expect(JSON.stringify(toolEvent?.payload)).not.toContain("cookie=abc");
    expect(JSON.stringify(toolEvent?.payload)).not.toContain("token=def");
  });

  it("reports missing executables truthfully", async () => {
    const connector = new CodexConnector({ executable: "/missing/codex" });
    await expect(connector.probe()).resolves.toMatchObject({ status: "not_installed" });
  });

  it("bounds probe subprocesses", async () => {
    const connector = new CodexConnector({
      executable: "codex",
      spawn: () => createHangingChild(),
      commandTimeoutMs: 20,
      killTimeoutMs: 10,
    });

    await expect(withTimeout(connector.probe(), 100)).resolves.toMatchObject({
      status: "runtime_error",
      diagnostic: expect.stringContaining("timed out"),
    });
  });

  it("bounds catalog subprocesses", async () => {
    const connector = new TraeConnector({
      executable: "traecli",
      spawn: () => createHangingChild(),
      commandTimeoutMs: 20,
      killTimeoutMs: 10,
    });

    await expect(withTimeout(connector.fetchCatalog("/tmp/project"), 100)).resolves.toEqual({
      models: [],
      permissionModes: ["request_approval", "help_me_approve", "full_access"],
    });
  });

  it("classifies a missing executable as a definite start rejection", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: join(ctx.root, "missing-codex"),
      modelsCachePath: ctx.modelsCachePath,
      killTimeoutMs: 50,
    });
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null);

    await expect(
      withTimeout(connector.startTurn(harness.session, turnInput("codex", null)), 250),
    ).rejects.toMatchObject({ definiteStartRejection: true });
    await expect(withTimeout(waitForSettled(harness.session), 250)).resolves.toBeUndefined();
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "turn_status",
        payload: expect.objectContaining({ status: "start_failed" }),
      }),
    );
  });

  it.each([
    { id: "codex" as const, binary: "fake-codex.mjs" },
    { id: "trae" as const, binary: "fake-traecli.mjs" },
  ])("reports authentication_required when $id native login is missing", async ({ id, binary }) => {
    const ctx = createFixtureContext();
    const connector = createConnectorRegistry({
      [id]: {
        executable: fixtureBinary(binary),
        spawn: spawnRecorder(ctx.spawnCalls),
        modelsCachePath: ctx.modelsCachePath,
        env: { ...fixtureEnv(ctx.recordPath), AIN_FIXTURE_AUTH: "required" },
      },
    })[id]!;

    await expect(connector.probe()).resolves.toMatchObject({
      status: "authentication_required",
      diagnostic: "Not logged in",
    });
  });

  it("classifies invalid generated MCP config as a definite pre-start rejection", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: fixtureEnv(ctx.recordPath),
    });
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null);

    await expect(
      connector.startTurn(harness.session, {
        ...turnInput("codex", null),
        mcpConfigPath: join(ctx.root, "missing-artifact.json"),
      }),
    ).rejects.toMatchObject({ definiteStartRejection: true });
    expect(ctx.spawnCalls.filter((call) => call.args[0] === "exec")).toHaveLength(0);
  });

  it("requires both opencode sdk adapter and local executable", async () => {
    const ctx = createFixtureContext();
    const withoutSdk = new OpenCodeConnector({
      executable: fixtureBinary("fake-opencode.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: fixtureEnv(ctx.recordPath),
    });

    await expect(withoutSdk.probe()).resolves.toMatchObject({ status: "not_installed" });
    await expect(withoutSdk.fetchCatalog(ctx.projectPath)).resolves.toEqual({
      models: [],
      permissionModes: [],
    });
    await expect(
      withoutSdk.createOrResumeSession({
        projectPath: ctx.projectPath,
        conversationId: "conversation-opencode",
        nativeSessionId: null,
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);

    const withMissingExecutable = new OpenCodeConnector({
      executable: "/missing/opencode",
      sdkAdapter: createOpenCodeSdkAdapter(),
    });
    await expect(withMissingExecutable.probe()).resolves.toMatchObject({ status: "not_installed" });
    await expect(
      withMissingExecutable.createOrResumeSession({
        projectPath: ctx.projectPath,
        conversationId: "conversation-opencode",
        nativeSessionId: null,
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);

    await expect(
      withMissingExecutable.startTurn(
        {
          id: "conversation-opencode",
          nativeSessionId: null,
        },
        {
          content: "say hello",
          snapshot: {
            modelId: null,
            permissionMode: "help_me_approve",
            pluginVersions: [],
          },
          turnId: "turn-opencode-start",
        },
      ),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);

    const withBrokenExecutable = new OpenCodeConnector({
      executable: "/usr/bin/false",
      sdkAdapter: createOpenCodeSdkAdapter(),
    });
    await expect(
      withBrokenExecutable.createOrResumeSession({
        projectPath: ctx.projectPath,
        conversationId: "conversation-opencode",
        nativeSessionId: null,
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it("opencode sdk path emits normalized turn_status and terminal callback", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new OpenCodeConnector({
      executable: fixtureBinary("fake-opencode.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: fixtureEnv(ctx.recordPath),
      sdkAdapter: createOpenCodeSdkAdapter(),
    });
    setTurnCallbacks(connector, terminalCalls);

    await expect(connector.probe()).resolves.toMatchObject({ status: "available" });

    const started = await startTurn(connector, "opencode", ctx.projectPath, null);
    await waitForSettled(started.session);

    expect(started.session.nativeSessionId).toBe("sdk-session-opencode");
    expect(started.nativeTurnId).toBe("sdk-turn-opencode");
    expect(started.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["assistant_message", "turn_status"]),
    );
    expect(terminalCalls).toHaveLength(1);
    expect(terminalCalls[0]?.status).toBe("completed");
  });

  it("uses the configured OpenCode executable with the official SDK client", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const create = vi.fn().mockResolvedValue({
      data: { id: "sdk-session-opencode" },
    });
    const prompt = vi.fn().mockResolvedValue({
      data: {
        info: {
          id: "sdk-message-opencode",
          role: "assistant",
          tokens: { input: 8, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
        },
        parts: [
          { type: "reasoning", text: "checking the project" },
          { type: "text", text: "hello from official opencode sdk" },
          {
            type: "tool",
            tool: "read",
            state: { status: "completed", input: { path: "README.md" }, output: "# Ain One" },
          },
        ],
      },
    });
    opencodeSdk.createOpencodeClient.mockReturnValue({
      session: {
        create,
        prompt,
        abort: vi.fn().mockResolvedValue({ data: true }),
        update: vi.fn().mockResolvedValue({ data: {} }),
      },
    });
    const connector = createConnectorRegistry({
      opencode: {
        executable: fixtureBinary("fake-opencode.mjs"),
        spawn: spawnRecorder(ctx.spawnCalls),
        env: fixtureEnv(ctx.recordPath),
      },
    }).opencode;
    setTurnCallbacks(connector, terminalCalls);

    await expect(connector.probe()).resolves.toMatchObject({ status: "available" });
    const started = await startTurn(connector, "opencode", ctx.projectPath, null);
    await waitForSettled(started.session);

    expect(opencodeSdk.createOpencode).not.toHaveBeenCalled();
    expect(opencodeSdk.createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    });
    expect(ctx.spawnCalls).toContainEqual(
      expect.objectContaining({
        command: fixtureBinary("fake-opencode.mjs"),
        args: ["serve", "--hostname=127.0.0.1", "--port=0"],
        shell: false,
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ directory: ctx.projectPath }),
      { throwOnError: true },
    );
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "sdk-session-opencode",
        directory: ctx.projectPath,
        parts: [{ type: "text", text: "say hello" }],
      }),
      expect.objectContaining({ throwOnError: true, signal: expect.any(AbortSignal) }),
    );
    expect(started.session.nativeSessionId).toBe("sdk-session-opencode");
    expect(started.nativeTurnId).toBeNull();
    expect(started.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          payload: expect.objectContaining({ summary: "checking the project" }),
        }),
        expect.objectContaining({
          type: "assistant_message",
          payload: expect.objectContaining({ text: "hello from official opencode sdk" }),
        }),
        expect.objectContaining({
          type: "tool",
          payload: expect.objectContaining({ name: "read", status: "completed" }),
        }),
        expect.objectContaining({
          type: "usage",
          payload: expect.objectContaining({ summary: "8 input / 5 output tokens" }),
        }),
        expect.objectContaining({
          type: "turn_status",
          payload: expect.objectContaining({ status: "completed" }),
        }),
      ]),
    );
    expect(terminalCalls).toEqual([
      expect.objectContaining({ status: "completed", nativeTurnId: null }),
    ]);

    await connector.closeSession(started.session);
    expect(ctx.spawnCalls.find((call) => call.args[0] === "serve")?.killSignals).toContain(undefined);
  });

  it("advertises only full access for the official OpenCode transport", async () => {
    const ctx = createFixtureContext();
    opencodeSdk.createOpencodeClient.mockReturnValue({
      provider: {
        list: vi.fn().mockResolvedValue({
          data: {
            connected: ["openai"],
            all: [{ id: "openai", models: { "gpt-5": {} } }],
          },
        }),
      },
    });
    const connector = createConnectorRegistry({
      opencode: {
        executable: fixtureBinary("fake-opencode.mjs"),
        spawn: spawnRecorder(ctx.spawnCalls),
        env: fixtureEnv(ctx.recordPath),
        killTimeoutMs: 50,
      },
    }).opencode;

    await expect(connector.fetchCatalog(ctx.projectPath)).resolves.toEqual({
      models: ["openai/gpt-5"],
      permissionModes: ["full_access"],
    });
  });

  it("does not report OpenCode cancelled when abort is not confirmed", async () => {
    const ctx = createFixtureContext();
    const prompt = createDeferred<{
      data: { info: { tokens: { input: number; output: number } }; parts: unknown[] };
    }>();
    opencodeSdk.createOpencodeClient.mockReturnValue({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "sdk-session-opencode" } }),
        update: vi.fn().mockResolvedValue({ data: {} }),
        prompt: vi.fn().mockImplementation(async () => prompt.promise),
        abort: vi.fn().mockResolvedValue({ data: false }),
      },
    });
    const connector = createConnectorRegistry({
      opencode: {
        executable: fixtureBinary("fake-opencode.mjs"),
        spawn: spawnRecorder(ctx.spawnCalls),
        env: fixtureEnv(ctx.recordPath),
        killTimeoutMs: 50,
      },
    }).opencode;
    const terminalCalls: TerminalCall[] = [];
    setTurnCallbacks(connector, terminalCalls);
    const harness = await createSessionHarness(connector, "opencode", ctx.projectPath, null);
    await connector.startTurn(harness.session, {
      ...turnInput("opencode", null),
      snapshot: { modelId: null, permissionMode: "full_access", pluginVersions: [] },
    });

    await expect(withTimeout(connector.cancelTurn(harness.session, null), 250)).resolves.toEqual({
      confirmed: false,
    });
    prompt.resolve({ data: { info: { tokens: { input: 1, output: 1 } }, parts: [] } });
    await waitForSettled(harness.session);
    expect(terminalCalls).toEqual([expect.objectContaining({ status: "completed" })]);
    await connector.closeSession(harness.session);
  });

  it("waits for OpenCode abort confirmation before reporting a prompt failure", async () => {
    const ctx = createFixtureContext();
    const prompt = createDeferred<never>();
    const abort = createDeferred<{ data: boolean }>();
    opencodeSdk.createOpencodeClient.mockReturnValue({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "sdk-session-opencode" } }),
        update: vi.fn().mockResolvedValue({ data: {} }),
        prompt: vi.fn().mockImplementation(async () => prompt.promise),
        abort: vi.fn().mockImplementation(async () => abort.promise),
      },
    });
    const connector = createConnectorRegistry({
      opencode: {
        executable: fixtureBinary("fake-opencode.mjs"),
        spawn: spawnRecorder(ctx.spawnCalls),
        env: fixtureEnv(ctx.recordPath),
        killTimeoutMs: 50,
      },
    }).opencode;
    const terminalCalls: TerminalCall[] = [];
    setTurnCallbacks(connector, terminalCalls);
    const harness = await createSessionHarness(connector, "opencode", ctx.projectPath, null);
    await connector.startTurn(harness.session, {
      ...turnInput("opencode", null),
      snapshot: { modelId: null, permissionMode: "full_access", pluginVersions: [] },
    });

    const cancellation = connector.cancelTurn(harness.session, null);
    prompt.reject(new Error("native prompt aborted"));
    await Promise.resolve();
    expect(terminalCalls).toEqual([]);

    abort.resolve({ data: true });
    await expect(withTimeout(cancellation, 250)).resolves.toEqual({ confirmed: true });
    expect(terminalCalls).toEqual([expect.objectContaining({ status: "cancelled" })]);
    await connector.closeSession(harness.session);
  });

  it("closes an active OpenCode request and escalates its server to SIGKILL", async () => {
    const ctx = createFixtureContext();
    opencodeSdk.createOpencodeClient.mockReturnValue({
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "sdk-session-opencode" } }),
        update: vi.fn().mockResolvedValue({ data: {} }),
        prompt: vi.fn().mockImplementation(
          async (_input: unknown, options: { signal?: AbortSignal }) =>
            new Promise((_resolvePromise, rejectPromise) => {
              options.signal?.addEventListener(
                "abort",
                () => rejectPromise(options.signal?.reason ?? new Error("aborted")),
                { once: true },
              );
            }),
        ),
        abort: vi.fn().mockResolvedValue({ data: true }),
      },
    });
    const connector = createConnectorRegistry({
      opencode: {
        executable: fixtureBinary("fake-opencode.mjs"),
        spawn: spawnRecorder(ctx.spawnCalls),
        env: { ...fixtureEnv(ctx.recordPath), AIN_FIXTURE_SCENARIO: "ignore-sigterm" },
        killTimeoutMs: 50,
      },
    }).opencode;
    const terminalCalls: TerminalCall[] = [];
    setTurnCallbacks(connector, terminalCalls);
    const harness = await createSessionHarness(connector, "opencode", ctx.projectPath, null);
    await connector.startTurn(harness.session, {
      ...turnInput("opencode", null),
      snapshot: { modelId: null, permissionMode: "full_access", pluginVersions: [] },
    });

    await expect(withTimeout(connector.closeSession(harness.session), 500)).resolves.toBeUndefined();
    expect(ctx.spawnCalls.find((call) => call.args[0] === "serve")?.killSignals).toEqual(
      expect.arrayContaining([undefined, "SIGKILL"]),
    );
    expect(terminalCalls).toEqual([expect.objectContaining({ status: "interrupted" })]);
  });

  it("escalates OpenCode server cleanup when startup URL detection times out", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 12_345,
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess;
    const kill = vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") {
        (child as ChildProcess & { signalCode: NodeJS.Signals | null }).signalCode = "SIGKILL";
        child.emit("close", null, "SIGKILL");
      }
      return true;
    });
    child.kill = kill as typeof child.kill;
    const adapter = createOfficialOpenCodeSdkAdapter({
      executable: "opencode",
      spawn: () => child,
      killTimeoutMs: 50,
    });

    try {
      const catalog = adapter.fetchCatalog("/tmp/project");
      const rejected = expect(catalog).rejects.toThrow(
        "Timed out waiting for OpenCode server to start",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(50);

      await rejected;
      expect(kill.mock.calls.map(([signal]) => signal)).toEqual([undefined, "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a newly started OpenCode server when session creation fails", async () => {
    const ctx = createFixtureContext();
    const children: ChildProcess[] = [];
    const recordSpawn = spawnRecorder(ctx.spawnCalls);
    const createError = new Error("session create failed");
    opencodeSdk.createOpencodeClient.mockReturnValue({
      session: {
        create: vi.fn().mockRejectedValue(createError),
      },
    });
    const connector = createConnectorRegistry({
      opencode: {
        executable: fixtureBinary("fake-opencode.mjs"),
        spawn(command, args, options) {
          const child = recordSpawn(command, args, options);
          children.push(child);
          return child;
        },
        env: fixtureEnv(ctx.recordPath),
        killTimeoutMs: 50,
      },
    }).opencode;

    let caught: unknown;
    try {
      await connector.createOrResumeSession({
        projectPath: ctx.projectPath,
        conversationId: "conversation-opencode-create-failure",
        nativeSessionId: null,
      });
    } catch (error) {
      caught = error;
    }

    const serveCall = ctx.spawnCalls.find((call) => call.args[0] === "serve");
    const terminatedBeforeCleanup = serveCall?.killSignals.includes(undefined) ?? false;
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      await new Promise<void>((resolvePromise) => {
        child.once("close", () => resolvePromise());
        child.kill("SIGKILL");
      });
    }));

    expect(caught).toBe(createError);
    expect(terminatedBeforeCleanup).toBe(true);
  });

  it("claude new session can complete without session.started when uuid already exists", async () => {
    const ctx = createFixtureContext();
    const connector = new ClaudeConnector({
      executable: fixtureBinary("fake-claude.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "missing-session-id",
      },
      killTimeoutMs: 50,
    });
    const harness = await createSessionHarness(connector, "claude", ctx.projectPath, null);

    await expect(
      withTimeout(connector.startTurn(harness.session, turnInput("claude", null)), 250),
    ).resolves.toMatchObject({ nativeTurnId: "native-turn-claude" });

    await expect(withTimeout(waitForSettled(harness.session), 250)).resolves.toBeUndefined();
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "turn_status",
        payload: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  it("waits for new-session native session persistence before resolving startTurn", async () => {
    const ctx = createFixtureContext();
    const deferred = createDeferred<void>();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "turn-before-session",
      },
      killTimeoutMs: 50,
    });
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null, {
      onNativeSessionId: async (value) => {
        harness.nativeSessionIds.push(value);
        await deferred.promise;
      },
    });

    let resolved = false;
    const startPromise = connector.startTurn(harness.session, turnInput("codex", null)).then((turn) => {
      resolved = true;
      return turn;
    });

    await sleep(50);
    expect(resolved).toBe(false);
    deferred.resolve();

    await expect(startPromise).resolves.toMatchObject({ nativeTurnId: "native-turn-codex" });
  });

  it.each([
    { id: "codex" as const, binary: "fake-codex.mjs" },
    { id: "claude" as const, binary: "fake-claude.mjs" },
    { id: "trae" as const, binary: "fake-traecli.mjs" },
  ])("rejects a drifted native session id while resuming $id", async ({ id, binary }) => {
    const ctx = createFixtureContext();
    const connector = createConnectorRegistry({
      [id]: {
        executable: fixtureBinary(binary),
        spawn: spawnRecorder(ctx.spawnCalls),
        modelsCachePath: ctx.modelsCachePath,
        env: {
          ...fixtureEnv(ctx.recordPath),
          HOME: ctx.root,
          AIN_FIXTURE_SCENARIO: "session-id-drift",
        },
        killTimeoutMs: 50,
      },
    })[id]!;
    const expectedSessionId = `native-session-${id}`;
    const harness = await createSessionHarness(connector, id, ctx.projectPath, expectedSessionId);
    const input = turnInput(id, expectedSessionId);
    if (id === "trae") {
      input.snapshot.permissionMode = "request_approval";
    }

    await expect(
      withTimeout(connector.startTurn(harness.session, input), 250),
    ).rejects.toThrow(/native session id/i);
    await expect(withTimeout(waitForSettled(harness.session), 250)).resolves.toBeUndefined();
    expect(harness.session.nativeSessionId).toBe(expectedSessionId);
    expect(harness.nativeSessionIds).toEqual([]);
  });

  it("interrupts a new session if the process exits before a native session id is persisted", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "missing-session-id",
      },
      killTimeoutMs: 50,
    });
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null);

    await expect(
      withTimeout(connector.startTurn(harness.session, turnInput("codex", null)), 250),
    ).rejects.toThrow();
    await expect(withTimeout(waitForSettled(harness.session), 250)).resolves.toBeUndefined();
    expect(getActiveTurn(harness.session)).toBeUndefined();
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "turn_status",
        payload: expect.objectContaining({ status: "interrupted" }),
      }),
    );
  });

  it("fails the Turn when event persistence throws", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: fixtureEnv(ctx.recordPath),
      killTimeoutMs: 50,
    });
    setTurnCallbacks(connector, terminalCalls);
    let failed = false;
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null, {
      onEvent: async (event) => {
        harness.events.push(event);
        if (!failed && event.type === "assistant_message") {
          failed = true;
          throw new Error("event sink failed");
        }
      },
    });

    await connector.startTurn(harness.session, turnInput("codex", null));
    await expect(withTimeout(waitForSettled(harness.session), 250)).resolves.toBeUndefined();
    expect(getActiveTurn(harness.session)).toBeUndefined();
    expect(terminalCalls).toEqual([
      expect.objectContaining({
        status: "interrupted",
        error: expect.objectContaining({
          code: "event_processing_failed",
          message: "event sink failed",
        }),
      }),
    ]);
    expect(harness.events).not.toContainEqual(
      expect.objectContaining({
        type: "warning",
        payload: expect.objectContaining({ code: "malformed_json" }),
      }),
    );
  });

  it("cleans up and settles when onNativeSessionId throws", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "cancel",
      },
      killTimeoutMs: 50,
    });
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null, {
      onNativeSessionId: async () => {
        throw new Error("persist failed");
      },
    });

    await expect(
      withTimeout(connector.startTurn(harness.session, turnInput("codex", null)), 250),
    ).rejects.toThrow(/persist failed|interrupted/i);
    await expect(withTimeout(waitForSettled(harness.session), 250)).resolves.toBeUndefined();
    expect(getActiveTurn(harness.session)).toBeUndefined();
    const execCall = ctx.spawnCalls.find((call) => call.args[0] === "exec");
    expect(execCall?.detached).toBe(process.platform !== "win32");
  });

  it("publishes terminal status before invoking the terminal callback", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: fixtureEnv(ctx.recordPath),
      killTimeoutMs: 50,
    });
    const callbackCapable = connector as AgentConnector & {
      setTurnCallbacks?: (callbacks: {
        onTerminal: (input: TerminalCall) => Promise<void>;
      }) => void;
    };
    let attempts = 0;
    let publishedEvents: ConnectorEvent[] = [];
    callbackCapable.setTurnCallbacks?.({
      onTerminal: async () => {
        attempts += 1;
        expect(publishedEvents.some((event) => event.type === "turn_status")).toBe(true);
        if (attempts === 1) {
          throw new Error("terminal sink failed once");
        }
      },
    });

    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null);
    publishedEvents = harness.events;
    await connector.startTurn(harness.session, turnInput("codex", null));

    await expect(withTimeout(waitForSettled(harness.session), 250)).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(getActiveTurn(harness.session)).toBeUndefined();
    expect(harness.events.filter((event) => event.type === "turn_status")).toHaveLength(1);
  });

  it("keeps the active controller when terminal persistence never succeeds", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: fixtureEnv(ctx.recordPath),
      killTimeoutMs: 50,
    });
    const callbackCapable = connector as AgentConnector & {
      setTurnCallbacks?: (callbacks: {
        onTerminal: (input: TerminalCall) => Promise<void>;
      }) => void;
    };
    callbackCapable.setTurnCallbacks?.({
      onTerminal: async () => {
        throw new Error("terminal persistence unavailable");
      },
    });
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null);
    await connector.startTurn(harness.session, turnInput("codex", null));

    await expect(withTimeout(waitForSettled(harness.session), 250)).rejects.toThrow(
      "terminal persistence unavailable",
    );
    expect(getActiveTurn(harness.session)).toBeDefined();
    expect(harness.events.filter((event) => event.type === "turn_status")).toHaveLength(1);
  });

  it("reports a non-zero exit before native identity only as interrupted", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "nonzero-before-identity",
      },
      killTimeoutMs: 50,
    });
    setTurnCallbacks(connector, terminalCalls);
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null);

    await expect(
      withTimeout(connector.startTurn(harness.session, turnInput("codex", null)), 250),
    ).rejects.toThrow();
    await expect(withTimeout(waitForSettled(harness.session), 250)).resolves.toBeUndefined();

    expect(terminalCalls).toEqual([expect.objectContaining({ status: "interrupted" })]);
    expect(harness.events.filter((event) => event.type === "turn_status")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ status: "interrupted" }) }),
    ]);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "ignore-sigterm",
      },
      killTimeoutMs: 50,
    });

    const started = await startTurn(connector, "codex", ctx.projectPath, null);
    await waitForRecord(ctx.recordPath, "signal-ready", 250);
    await expect(
      withTimeout(connector.cancelTurn(started.session, started.nativeTurnId), 500),
    ).resolves.toEqual({ confirmed: true });
    await waitForSettled(started.session);

    const execCall = ctx.spawnCalls.find((call) => call.args[0] === "exec");
    expect(execCall?.detached).toBe(process.platform !== "win32");
    expect(readRecords(ctx.recordPath)).toContainEqual(
      expect.objectContaining({ commandType: "signal", signal: "SIGTERM" }),
    );
  });

  it("terminates CLI descendants when cancelling", async () => {
    const ctx = createFixtureContext();
    const descendantPidPath = join(ctx.root, "descendant.pid");
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "descendant",
        AIN_FIXTURE_DESCENDANT_PID_PATH: descendantPidPath,
      },
      killTimeoutMs: 50,
    });

    const started = await startTurn(connector, "codex", ctx.projectPath, null);
    await waitForFile(descendantPidPath, 250);
    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));

    try {
      await expect(
        withTimeout(connector.cancelTurn(started.session, started.nativeTurnId), 500),
      ).resolves.toEqual({ confirmed: true });
      await waitForSettled(started.session);
      expect(await waitForProcessExit(descendantPid, 250)).toBe(true);
    } finally {
      if (isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  it("escalates graceful CLI shutdown to SIGKILL when SIGTERM is ignored", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "ignore-sigterm",
      },
      killTimeoutMs: 50,
    });
    const started = await startTurn(connector, "codex", ctx.projectPath, null);
    await waitForRecord(ctx.recordPath, "signal-ready", 250);

    await expect(withTimeout(connector.closeSession(started.session), 500)).resolves.toBeUndefined();
    expect(ctx.spawnCalls.find((call) => call.args[0] === "exec")?.detached).toBe(
      process.platform !== "win32",
    );
    expect(readRecords(ctx.recordPath)).toContainEqual(
      expect.objectContaining({ commandType: "signal", signal: "SIGTERM" }),
    );
  });

  it("reports graceful CLI shutdown without a native terminal event as interrupted", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "cancel",
      },
      killTimeoutMs: 50,
    });
    setTurnCallbacks(connector, terminalCalls);
    const started = await startTurn(connector, "codex", ctx.projectPath, null);

    await connector.closeSession(started.session);

    expect(terminalCalls).toEqual([expect.objectContaining({ status: "interrupted" })]);
    expect(started.events).toContainEqual(
      expect.objectContaining({
        type: "turn_status",
        payload: expect.objectContaining({ status: "interrupted" }),
      }),
    );
  });

  it("does not let late cancellation overwrite native completion", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "terminal-before-exit",
      },
      killTimeoutMs: 50,
    });
    setTurnCallbacks(connector, terminalCalls);

    const started = await startTurn(connector, "codex", ctx.projectPath, null);
    await sleep(50);
    expect(getActiveTurn(started.session)).toBeDefined();

    expect(await connector.cancelTurn(started.session, started.nativeTurnId)).toEqual({
      confirmed: false,
    });
    await waitForSettled(started.session);
    expect(getActiveTurn(started.session)).toBeUndefined();
    expect(terminalCalls).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("throws UnsupportedCapabilityError for permission responses", async () => {
    const ctx = createFixtureContext();
    const connector = new ClaudeConnector({
      executable: fixtureBinary("fake-claude.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: fixtureEnv(ctx.recordPath),
    });
    const session = await connector.createOrResumeSession({
      projectPath: ctx.projectPath,
      conversationId: "conversation-claude",
      nativeSessionId: null,
    });

    await expect(
      connector.respondToPermission(session, "permission-1", "allow_once"),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it("creates a registry with exactly the supported connector ids", () => {
    const ctx = createFixtureContext();
    const registry = createConnectorRegistry({
      codex: {
        executable: fixtureBinary("fake-codex.mjs"),
        spawn: spawnRecorder(ctx.spawnCalls),
        modelsCachePath: ctx.modelsCachePath,
        env: fixtureEnv(ctx.recordPath),
      },
      claude: {
        executable: fixtureBinary("fake-claude.mjs"),
        spawn: spawnRecorder(ctx.spawnCalls),
        env: fixtureEnv(ctx.recordPath),
      },
      trae: {
        executable: fixtureBinary("fake-traecli.mjs"),
        spawn: spawnRecorder(ctx.spawnCalls),
        env: fixtureEnv(ctx.recordPath),
      },
      opencode: {
        sdkAdapter: createOpenCodeSdkAdapter(),
      },
    });

    expect(Object.keys(registry).sort()).toEqual(["claude", "codex", "opencode", "trae"]);
    expect(registry.codex).toBeInstanceOf(CodexConnector);
    expect(registry.claude).toBeInstanceOf(ClaudeConnector);
    expect(registry.trae).toBeInstanceOf(TraeConnector);
    expect(registry.opencode).toBeInstanceOf(OpenCodeConnector);
  });
});

function createFixtureContext(): FixtureContext {
  const root = mkdtempSync(join(tmpdir(), "ain-one-connectors-"));
  roots.push(root);
  const projectPath = join(root, "project");
  mkdirSync(projectPath, { recursive: true });
  const recordPath = join(root, "records.jsonl");
  writeFileSync(recordPath, "", "utf8");
  const modelsCachePath = join(root, "models_cache.json");
  writeFileSync(
    modelsCachePath,
    JSON.stringify({ models: [{ slug: "gpt-5" }, { display_name: "gpt-5-mini" }, null] }),
    "utf8",
  );
  return {
    root,
    projectPath,
    recordPath,
    modelsCachePath,
    spawnCalls: [],
  };
}

function fixtureBinary(name: string): string {
  return resolve(import.meta.dirname, "../fixtures/agents", name);
}

function fixtureEnv(recordPath: string): NodeJS.ProcessEnv {
  return { AIN_FIXTURE_RECORD_PATH: recordPath };
}

function spawnRecorder(calls: SpawnCall[]) {
  return (command: string, args: string[], options: SpawnOptions): ChildProcess => {
    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    calls.push({
      command,
      args: [...args],
      shell: options.shell === undefined ? undefined : Boolean(options.shell),
      detached: options.detached === undefined ? undefined : Boolean(options.detached),
      killSignals,
    });
    const child = nodeSpawn(command, args, options);
    const originalKill = child.kill.bind(child);
    child.kill = ((signal?: NodeJS.Signals | number) => {
      killSignals.push(signal);
      return originalKill(signal);
    }) as typeof child.kill;
    return child;
  };
}

function createHangingChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    pid: undefined,
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcess;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    (child as ChildProcess & { signalCode: NodeJS.Signals | null }).signalCode =
      typeof signal === "string" ? signal : "SIGTERM";
    queueMicrotask(() => child.emit("close", null, child.signalCode));
    return true;
  }) as typeof child.kill;
  return child;
}

function setTurnCallbacks(connector: AgentConnector, terminalCalls: TerminalCall[]): void {
  const callbackCapable = connector as AgentConnector & {
    setTurnCallbacks?: (callbacks: {
      onTerminal: (input: TerminalCall) => Promise<void>;
    }) => void;
  };
  callbackCapable.setTurnCallbacks?.({
    onTerminal: async (input) => {
      terminalCalls.push(input);
    },
  });
}

async function startTurn(
  connector: AgentConnector,
  id: AgentProductId,
  projectPath: string,
  nativeSessionId: string | null,
): Promise<{
  session: LiveSession;
  events: ConnectorEvent[];
  nativeSessionIds: Array<string | null>;
  nativeTurnId: string | null;
}> {
  const harness = await createSessionHarness(connector, id, projectPath, nativeSessionId);
  const input = turnInput(id, nativeSessionId);
  if (id === "trae" || id === "opencode") {
    input.snapshot.permissionMode = id === "trae" ? "request_approval" : "full_access";
  }
  const turn = await connector.startTurn(harness.session, input);

  return {
    session: harness.session,
    events: harness.events,
    nativeSessionIds: harness.nativeSessionIds,
    nativeTurnId: turn.nativeTurnId,
  };
}

async function createSessionHarness(
  connector: AgentConnector,
  id: AgentProductId,
  projectPath: string,
  nativeSessionId: string | null,
  overrides?: Pick<SessionInput, "onEvent" | "onNativeSessionId">,
): Promise<{
  session: LiveSession;
  events: ConnectorEvent[];
  nativeSessionIds: Array<string | null>;
}> {
  const events: ConnectorEvent[] = [];
  const nativeSessionIds: Array<string | null> = [];
  const session = await connector.createOrResumeSession({
    projectPath,
    conversationId: `conversation-${id}`,
    nativeSessionId,
    onEvent: overrides?.onEvent ?? (async (event) => {
      events.push(event);
    }),
    onNativeSessionId: overrides?.onNativeSessionId ?? (async (value) => {
      nativeSessionIds.push(value);
    }),
  });

  return { session, events, nativeSessionIds };
}

function turnInput(id: AgentProductId, nativeSessionId: string | null) {
  return {
    content: "say hello",
    snapshot: {
      modelId: null,
      permissionMode: "help_me_approve" as PermissionMode,
      pluginVersions: [],
    },
    turnId: `turn-${id}-${nativeSessionId ? "resume" : "start"}`,
  };
}

async function waitForSettled(session: LiveSession): Promise<void> {
  const runtime = session as LiveSession & { settled?: Promise<void> };
  await runtime.settled;
}

function readRecords(recordPath: string): Array<Record<string, unknown>> {
  return readFileSync(recordPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertArgs(actual: string[], expected: string[] | ((args: string[]) => void)): void {
  if (typeof expected === "function") {
    expected(actual);
    return;
  }
  expect(actual).toEqual(expected);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function waitForFile(path: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await sleep(10);
  }
}

async function waitForRecord(path: string, commandType: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!readRecords(path).some((record) => record.commandType === commandType)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${commandType}`);
    }
    await sleep(10);
  }
}

async function waitForProcessExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await sleep(10);
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolvePromise, rejectPromise) => {
      setTimeout(() => {
        rejectPromise(new Error(`Timed out after ${ms}ms`));
      }, ms);
    }),
  ]);
}

function getActiveTurn(session: LiveSession): unknown {
  return (session as LiveSession & { activeTurn?: unknown }).activeTurn;
}

function createOpenCodeSdkAdapter() {
  return {
    async probe() {
      return { status: "available" as const, version: "sdk-test" };
    },
    async fetchCatalog() {
      return {
        models: ["opencode-sdk-model"],
        permissionModes: ["request_approval", "help_me_approve", "full_access"] as PermissionMode[],
      };
    },
    async createOrResumeSession(input: SessionInput) {
      return {
        nativeSessionId: input.nativeSessionId ?? "sdk-session-opencode",
      };
    },
    async startTurn(
      _session: LiveSession,
      _input: ReturnType<typeof turnInput>,
      sink: {
        emitEvent: (event: ConnectorEvent) => Promise<void>;
        syncNativeSessionId: (nativeSessionId: string | null) => Promise<void>;
        emitTerminal: (input: {
          turnId: string | undefined;
          nativeTurnId: string | null;
          status: TerminalTurnStatus;
          error?: NormalizedError;
        }) => Promise<void>;
      },
    ) {
      await sink.syncNativeSessionId("sdk-session-opencode");
      await sink.emitEvent({
        type: "assistant_message",
        payload: { text: "hello from opencode sdk" },
      });
      const settled = (async () => {
        await sink.emitTerminal({
          turnId: "turn-opencode-start",
          nativeTurnId: "sdk-turn-opencode",
          status: "completed",
        });
      })();
      return {
        nativeTurnId: "sdk-turn-opencode",
        settled,
        async cancel() {
          return true;
        },
        async close() {
          await settled;
        },
      };
    },
  };
}
