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
import { createConnectorRegistry } from "../../src/server/connectors/registry.js";
import { TraeConnector } from "../../src/server/connectors/trae.js";

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
        models: [],
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
        "-c",
        "plugins.trae-queue@local.enabled=false",
      ],
      resumeArgs: [
        "exec",
        "resume",
        "native-session-trae",
        "--json",
        "--skip-git-repo-check",
        "-c",
        "plugins.trae-queue@local.enabled=false",
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
    expect(started.events.filter((event) => event.type === "warning").map((event) => event.payload.event)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('\"type\":\"item.started\"')]),
    );
    expect(JSON.stringify(started.events)).not.toContain("sk-secret-value");
  });

  it("normalizes current Claude stream JSON with partial and final message events", async () => {
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
      expect.objectContaining({ payload: expect.objectContaining({ text: "duplicate", delta: true }) }),
      expect.objectContaining({ payload: expect.objectContaining({ text: "/tmp/project", final: true }) }),
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

  it("uses a distinct Claude stream identity for each Turn in one session", async () => {
    const ctx = createFixtureContext();
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
    const harness = await createSessionHarness(connector, "claude", ctx.projectPath, null);

    await connector.startTurn(harness.session, { ...turnInput("claude", null), turnId: "turn-claude-1" });
    await waitForSettled(harness.session);
    await connector.startTurn(harness.session, { ...turnInput("claude", null), turnId: "turn-claude-2" });
    await waitForSettled(harness.session);

    const streamIds = harness.events
      .filter((event) => event.type === "assistant_message" && event.payload.final === true)
      .map((event) => event.payload.streamId);
    expect(streamIds).toEqual([
      "claude:turn-claude-1:assistant",
      "claude:turn-claude-2:assistant",
    ]);
  });

  it("streams Codex app-server message deltas and emits one final message identity", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: fixtureEnv(ctx.recordPath),
      useAppServer: true,
    });
    setTurnCallbacks(connector, terminalCalls);

    const started = await startTurn(connector, "codex", ctx.projectPath, null);
    await waitForSettled(started.session);

    expect(started.nativeSessionIds).toEqual(["app-thread-codex"]);
    expect(started.nativeTurnId).toBe("app-turn-codex");
    expect(started.events.filter((event) => event.type === "assistant_message")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ text: "hello", streamId: "app-message-1", delta: true }) }),
      expect.objectContaining({ payload: expect.objectContaining({ text: " world", streamId: "app-message-1", delta: true }) }),
      expect.objectContaining({ payload: expect.objectContaining({ text: "hello world", streamId: "app-message-1", final: true }) }),
    ]);
    expect(terminalCalls).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(ctx.spawnCalls.find((call) => call.args[0] === "app-server")?.args).toEqual(["app-server", "--stdio"]);
  });

  it("accepts the next Codex app-server Turn from the terminal callback", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: fixtureEnv(ctx.recordPath),
      useAppServer: true,
    });
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null);
    const terminalCalls: TerminalCall[] = [];
    let secondTurn: Promise<{ nativeTurnId: string | null }> | null = null;
    const callbackCapable = connector as CodexConnector & {
      setTurnCallbacks(callbacks: { onTerminal(input: TerminalCall): Promise<void> }): void;
    };
    callbackCapable.setTurnCallbacks({
      onTerminal: async (input) => {
        terminalCalls.push(input);
        if (input.turnId === "turn-codex-1") {
          secondTurn = connector.startTurn(harness.session, {
            ...turnInput("codex", harness.session.nativeSessionId),
            turnId: "turn-codex-2",
          });
          await secondTurn;
        }
      },
    });

    await connector.startTurn(harness.session, { ...turnInput("codex", null), turnId: "turn-codex-1" });
    await withTimeout(waitForTerminalCount(terminalCalls, 2), 500);
    await expect(secondTurn).resolves.toEqual({ nativeTurnId: "app-turn-codex" });
  });

  it("accepts the next Codex app-server Turn from the terminal event handler", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: fixtureEnv(ctx.recordPath),
      useAppServer: true,
    });
    let secondTurn: Promise<{ nativeTurnId: string | null }> | null = null;
    let session!: LiveSession;
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null, {
      onEvent: async (event) => {
        if (event.type === "turn_status" && event.payload.status === "completed" && secondTurn === null) {
          secondTurn = connector.startTurn(session, { ...turnInput("codex", "resume"), turnId: "turn-codex-2" });
          await secondTurn;
        }
      },
    });
    session = harness.session;

    await connector.startTurn(session, { ...turnInput("codex", null), turnId: "turn-codex-1" });
    await waitForSettled(session);
    await expect(secondTurn).resolves.toEqual({ nativeTurnId: "app-turn-codex" });
  });

  it("surfaces Codex app-server approval requests and sends the selected decision", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: { ...fixtureEnv(ctx.recordPath), AIN_FIXTURE_SCENARIO: "app-server-approval" },
      useAppServer: true,
    });
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null);

    await connector.startTurn(harness.session, {
      ...turnInput("codex", null),
      snapshot: { modelId: null, permissionMode: "request_approval", pluginVersions: [] },
    });
    await waitForEvent(harness.events, "permission");
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: "permission",
      payload: expect.objectContaining({ requestId: "approval-1", request: "Run pwd" }),
    }));

    await connector.respondToPermission(harness.session, "approval-1", "allow_once");
    await waitForSettled(harness.session);
    expect(readRecords(ctx.recordPath)).toContainEqual(expect.objectContaining({
      commandType: "permission-response",
      response: { id: "approval-1", result: { decision: "accept" } },
    }));
  });

  it("warns on malformed Codex app-server JSON and continues the Turn", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: { ...fixtureEnv(ctx.recordPath), AIN_FIXTURE_SCENARIO: "app-server-malformed-json" },
      useAppServer: true,
    });
    const started = await startTurn(connector, "codex", ctx.projectPath, null);
    await waitForSettled(started.session);

    expect(started.events).toContainEqual(expect.objectContaining({
      type: "warning",
      payload: expect.objectContaining({ code: "malformed_json" }),
    }));
    expect(started.events).toContainEqual(expect.objectContaining({
      type: "turn_status",
      payload: expect.objectContaining({ status: "completed" }),
    }));
  });

  it("times out when Codex app-server does not answer a startup request", async () => {
    const ctx = createFixtureContext();
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: { ...fixtureEnv(ctx.recordPath), AIN_FIXTURE_SCENARIO: "app-server-hang" },
      commandTimeoutMs: 100,
      killTimeoutMs: 20,
      useAppServer: true,
    });
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null);

    await expect(withTimeout(
      connector.startTurn(harness.session, turnInput("codex", null)),
      250,
    )).rejects.toThrow("initialize timed out");
    await expect(withTimeout(waitForSettled(harness.session), 250)).resolves.toBeUndefined();
  });

  it("terminates Codex app-server when an interrupt request is not answered", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: { ...fixtureEnv(ctx.recordPath), AIN_FIXTURE_SCENARIO: "app-server-cancel-hang" },
      interruptTimeoutMs: 100,
      killTimeoutMs: 20,
      useAppServer: true,
    });
    setTurnCallbacks(connector, terminalCalls);
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null);

    const turn = await connector.startTurn(harness.session, turnInput("codex", null));
    await expect(withTimeout(connector.cancelTurn(harness.session, turn.nativeTurnId), 500))
      .resolves.toEqual({ confirmed: true });
    expect(terminalCalls).toEqual([expect.objectContaining({ status: "cancelled" })]);
  });

  it("interrupts a Codex app-server Turn when event persistence fails", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: fixtureEnv(ctx.recordPath),
      useAppServer: true,
    });
    setTurnCallbacks(connector, terminalCalls);
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null, {
      onEvent: async (event) => {
        if (event.type === "assistant_message") throw new Error("event store unavailable");
        harness.events.push(event);
      },
    });

    await connector.startTurn(harness.session, turnInput("codex", null));
    await waitForSettled(harness.session);

    expect(terminalCalls).toEqual([expect.objectContaining({
      status: "interrupted",
      error: expect.objectContaining({ code: "event_processing_failed", message: "event store unavailable" }),
    })]);
  });

  it("recovers a Codex app-server Turn when its completed status event cannot be persisted", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      modelsCachePath: ctx.modelsCachePath,
      env: fixtureEnv(ctx.recordPath),
      useAppServer: true,
    });
    setTurnCallbacks(connector, terminalCalls);
    let failedCompletedStatus = false;
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null, {
      onEvent: async (event) => {
        if (event.type === "turn_status" && event.payload.status === "completed" && !failedCompletedStatus) {
          failedCompletedStatus = true;
          throw new Error("event store unavailable");
        }
        harness.events.push(event);
      },
    });

    await connector.startTurn(harness.session, turnInput("codex", null));
    await withTimeout(waitForTerminalCount(terminalCalls, 1), 500);

    expect(terminalCalls).toEqual([expect.objectContaining({
      status: "interrupted",
      error: expect.objectContaining({ code: "event_processing_failed", message: "event store unavailable" }),
    })]);
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

  it("only advertises the highest-precedence configured Claude model", async () => {
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
      models: ["local-model"],
      permissionModes: ["request_approval", "help_me_approve", "full_access"],
    });
  });

  it("does not advertise a configured non-Claude model as a Claude model", async () => {
    const ctx = createFixtureContext();
    mkdirSync(join(ctx.root, ".claude"), { recursive: true });
    writeFileSync(join(ctx.root, ".claude", "settings.json"), JSON.stringify({ model: "gpt-5.6-sol" }));
    const connector = new ClaudeConnector({ env: { HOME: ctx.root } });

    await expect(connector.fetchCatalog(ctx.projectPath)).resolves.toEqual({
      models: [],
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

  it("uses the headless default for Trae request approval", async () => {
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
      "-c",
      "plugins.trae-queue@local.enabled=false",
    ]);
  });

  it("accepts the next Trae Turn from the terminal event handler", async () => {
    const ctx = createFixtureContext();
    const connector = new TraeConnector({
      executable: fixtureBinary("fake-traecli.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: fixtureEnv(ctx.recordPath),
      killTimeoutMs: 50,
    });
    let secondTurn: Promise<{ nativeTurnId: string | null }> | null = null;
    let session!: LiveSession;
    const harness = await createSessionHarness(connector, "trae", ctx.projectPath, null, {
      onEvent: async (event) => {
        if (event.type === "turn_status" && event.payload.status === "completed" && secondTurn === null) {
          secondTurn = connector.startTurn(session, { ...turnInput("trae", session.nativeSessionId), turnId: "turn-trae-2" });
          await secondTurn;
        }
      },
    });
    session = harness.session;

    await connector.startTurn(session, { ...turnInput("trae", null), turnId: "turn-trae-1" });
    await vi.waitFor(() => expect(secondTurn).not.toBeNull());

    await expect(secondTurn).resolves.toEqual(expect.objectContaining({ nativeTurnId: expect.anything() }));
  });

  it("completes a Turn when shutdown follows a persisted final answer", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new TraeConnector({
      executable: fixtureBinary("fake-traecli.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: { ...fixtureEnv(ctx.recordPath), AIN_FIXTURE_SCENARIO: "final-output-hang" },
      killTimeoutMs: 50,
    });
    setTurnCallbacks(connector, terminalCalls);
    const harness = await createSessionHarness(connector, "trae", ctx.projectPath, null);

    await connector.startTurn(harness.session, turnInput("trae", null));
    await waitForEvent(harness.events, "assistant_message");
    await connector.closeSession(harness.session);

    expect(terminalCalls).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("interrupts a Turn when work continues after a complete assistant item", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new TraeConnector({
      executable: fixtureBinary("fake-traecli.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: { ...fixtureEnv(ctx.recordPath), AIN_FIXTURE_SCENARIO: "final-output-then-tool-hang" },
      killTimeoutMs: 50,
    });
    setTurnCallbacks(connector, terminalCalls);
    const harness = await createSessionHarness(connector, "trae", ctx.projectPath, null);

    await connector.startTurn(harness.session, turnInput("trae", null));
    await waitForEvent(harness.events, "shell");
    await connector.closeSession(harness.session);

    expect(terminalCalls).toEqual([expect.objectContaining({ status: "interrupted" })]);
  });

  it("injects the Ain One Queue hook only when Trae auto queue is enabled", async () => {
    const ctx = createFixtureContext();
    const connector = new TraeConnector({
      executable: fixtureBinary("fake-traecli.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: fixtureEnv(ctx.recordPath),
      queueHome: join(ctx.root, "queue"),
    });
    const harness = await createSessionHarness(connector, "trae", ctx.projectPath, null);

    await connector.startTurn(harness.session, {
      ...turnInput("trae", null),
      snapshot: {
        modelId: null, permissionMode: "request_approval", pluginVersions: [], autoQueue: true,
      },
    });
    await waitForSettled(harness.session);

    const args = ctx.spawnCalls.find((call) => call.args[0] === "exec")?.args ?? [];
    expect(args).toContain('plugins.trae-queue@local.enabled=false');
    expect(args.some((arg) => arg.startsWith("hooks.Stop=") && arg.includes("trae-queue-hook.mjs"))).toBe(true);
    expect(args.some((arg) => arg.startsWith("hooks.PostToolUse=") && arg.includes("trae-queue-hook.mjs"))).toBe(true);
  });

  it("releases an independently waiting Trae Queue hook when the session closes", async () => {
    const ctx = createFixtureContext();
    const queueHome = join(ctx.root, "queue");
    const connector = new TraeConnector({
      executable: fixtureBinary("fake-traecli.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: fixtureEnv(ctx.recordPath),
      queueHome,
    });
    const harness = await createSessionHarness(
      connector, "trae", ctx.projectPath, "native-session-trae",
    );
    const hook = resolve(process.cwd(), "src/server/connectors/trae-queue-hook.mjs");
    const statePath = join(queueHome, "hook-sessions", "native-session-trae", "state.json");
    const child = nodeSpawn(process.execPath, [hook], { env: { ...process.env, TRAE_QUEUE_HOME: queueHome } });
    child.stdin?.end(JSON.stringify({ hook_event_name: "Stop", session_id: "native-session-trae" }));
    await waitForFile(statePath, 250);

    await connector.closeSession(harness.session);

    expect(await waitForProcessExit(child.pid!, 250)).toBe(true);
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
      "-c",
      "plugins.trae-queue@local.enabled=false",
      "--permission-mode",
      "auto",
    ]);
  });

  it("maps Trae full access without conflicting permission and sandbox overrides", async () => {
    const ctx = createFixtureContext();
    const connector = new TraeConnector({
      executable: fixtureBinary("fake-traecli.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: fixtureEnv(ctx.recordPath),
    });
    const harness = await createSessionHarness(connector, "trae", ctx.projectPath, null);

    await connector.startTurn(harness.session, {
      ...turnInput("trae", null),
      snapshot: { modelId: null, permissionMode: "full_access", pluginVersions: [] },
    });
    await waitForSettled(harness.session);

    const execRecord = readRecords(ctx.recordPath).find((record) => record.commandType === "exec");
    expect(execRecord?.args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-c",
      "plugins.trae-queue@local.enabled=false",
      "--dangerously-bypass-approvals-and-sandbox",
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
      withTimeout(connector.startTurn(harness.session, input), 500),
    ).rejects.toThrow(/native session id/i);
    await expect(withTimeout(waitForSettled(harness.session), 500)).resolves.toBeUndefined();
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

  it("interrupts the Turn when an unterminated stdout record exceeds the limit", async () => {
    const ctx = createFixtureContext();
    const child = createHangingChild();
    const stdout = child.stdout as PassThrough;
    const terminalCalls: TerminalCall[] = [];
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: () => child,
      modelsCachePath: ctx.modelsCachePath,
      killTimeoutMs: 50,
    });
    setTurnCallbacks(connector, terminalCalls);
    const harness = await createSessionHarness(
      connector,
      "codex",
      ctx.projectPath,
      "native-session-codex",
    );

    try {
      const startPromise = connector.startTurn(
        harness.session,
        turnInput("codex", "native-session-codex"),
      );
      stdout.write(
        `${JSON.stringify({ type: "thread.started", thread_id: "native-session-codex" })}\n` +
          `${JSON.stringify({ type: "turn.started", turn_id: "native-turn-codex" })}\n`,
      );
      await startPromise;

      stdout.write("x".repeat(1_048_577));

      await expect(withTimeout(waitForSettled(harness.session), 250)).resolves.toBeUndefined();
      expect(terminalCalls).toEqual([
        expect.objectContaining({
          status: "interrupted",
          error: expect.objectContaining({ code: "stdout_record_too_large" }),
        }),
      ]);
    } finally {
      await connector.closeSession(harness.session);
    }
  });

  it("pauses stdout while event persistence is pending and resumes in order", async () => {
    const ctx = createFixtureContext();
    const child = createHangingChild();
    const stdout = child.stdout as PassThrough;
    const pause = vi.spyOn(stdout, "pause");
    const resume = vi.spyOn(stdout, "resume");
    const releaseFirstEvent = createDeferred<void>();
    const firstEvent = createDeferred<void>();
    const secondEvent = createDeferred<void>();
    let assistantEvents = 0;
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: () => child,
      modelsCachePath: ctx.modelsCachePath,
      killTimeoutMs: 50,
    });
    const harness = await createSessionHarness(
      connector,
      "codex",
      ctx.projectPath,
      "native-session-codex",
      {
        onEvent: async (event) => {
          harness.events.push(event);
          if (event.type !== "assistant_message") {
            return;
          }
          assistantEvents += 1;
          if (assistantEvents === 1) {
            firstEvent.resolve();
            await releaseFirstEvent.promise;
          } else if (assistantEvents === 2) {
            secondEvent.resolve();
          }
        },
      },
    );

    try {
      const startPromise = connector.startTurn(
        harness.session,
        turnInput("codex", "native-session-codex"),
      );
      stdout.write(
        `${JSON.stringify({ type: "thread.started", thread_id: "native-session-codex" })}\n` +
          `${JSON.stringify({ type: "turn.started", turn_id: "native-turn-codex" })}\n` +
          `${JSON.stringify({ type: "message", role: "assistant", content: "first" })}\n` +
          `${JSON.stringify({ type: "message", role: "assistant", content: "second" })}\n`,
      );
      await startPromise;
      await withTimeout(firstEvent.promise, 250);

      expect(stdout.isPaused()).toBe(true);
      expect(pause).toHaveBeenCalled();
      expect(assistantEvents).toBe(1);
      const resumeCallsWhilePending = resume.mock.calls.length;

      releaseFirstEvent.resolve();
      await withTimeout(secondEvent.promise, 250);
      await sleep(0);

      expect(resume.mock.calls.length).toBeGreaterThan(resumeCallsWhilePending);
      expect(harness.events.filter((event) => event.type === "assistant_message")).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ text: "first" }) }),
        expect.objectContaining({ payload: expect.objectContaining({ text: "second" }) }),
      ]);
    } finally {
      releaseFirstEvent.resolve();
      await connector.closeSession(harness.session);
    }
  });

  it("preserves UTF-8 characters split across stdout chunks", async () => {
    const ctx = createFixtureContext();
    const child = createHangingChild();
    const stdout = child.stdout as PassThrough;
    const connector = new CodexConnector({
      executable: fixtureBinary("fake-codex.mjs"),
      spawn: () => child,
      modelsCachePath: ctx.modelsCachePath,
      killTimeoutMs: 50,
    });
    const harness = await createSessionHarness(
      connector,
      "codex",
      ctx.projectPath,
      "native-session-codex",
    );

    try {
      const startPromise = connector.startTurn(
        harness.session,
        turnInput("codex", "native-session-codex"),
      );
      stdout.write(
        `${JSON.stringify({ type: "thread.started", thread_id: "native-session-codex" })}\n` +
          `${JSON.stringify({ type: "turn.started", turn_id: "native-turn-codex" })}\n`,
      );
      await startPromise;

      const line = Buffer.from(
        `${JSON.stringify({ type: "message", role: "assistant", content: "中文" })}\n`,
      );
      const splitAt = line.indexOf(Buffer.from("中文")) + 1;
      stdout.write(line.subarray(0, splitAt));
      stdout.write(line.subarray(splitAt));

      await vi.waitFor(() => {
        expect(harness.events).toContainEqual(
          expect.objectContaining({
            type: "assistant_message",
            payload: expect.objectContaining({ text: "中文" }),
          }),
        );
      });
    } finally {
      await connector.closeSession(harness.session);
    }
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

  it("classifies an occupied native session as a definite start rejection", async () => {
    const ctx = createFixtureContext();
    const terminalCalls: TerminalCall[] = [];
    const connector = new TraeConnector({
      executable: fixtureBinary("fake-traecli.mjs"),
      spawn: spawnRecorder(ctx.spawnCalls),
      env: {
        ...fixtureEnv(ctx.recordPath),
        AIN_FIXTURE_SCENARIO: "thread-conflict",
      },
      killTimeoutMs: 50,
    });
    setTurnCallbacks(connector, terminalCalls);
    const harness = await createSessionHarness(
      connector,
      "trae",
      ctx.projectPath,
      "native-session-trae",
    );
    const input = turnInput("trae", "native-session-trae");
    input.snapshot.permissionMode = "request_approval";

    await expect(
      withTimeout(connector.startTurn(harness.session, input), 250),
    ).rejects.toMatchObject({
      code: "session_in_use",
      definiteStartRejection: true,
      message: expect.not.stringContaining("thread-store conflict"),
    });
    await expect(withTimeout(waitForSettled(harness.session), 250)).resolves.toBeUndefined();
    expect(terminalCalls).toEqual([
      expect.objectContaining({
        status: "start_failed",
        error: {
          code: "session_in_use",
          message: "This Agent session is still in use by another process. Restart the workspace and try again.",
        },
      }),
    ]);
  });

  it("handles stdin errors instead of leaving an uncaught stream error", async () => {
    const ctx = createFixtureContext();
    const child = createHangingChild();
    const connector = new CodexConnector({
      spawn: () => child,
      modelsCachePath: ctx.modelsCachePath,
    });
    const harness = await createSessionHarness(connector, "codex", ctx.projectPath, null);
    const started = connector.startTurn(harness.session, turnInput("codex", null));
    const listenerCount = child.stdin?.listenerCount("error") ?? 0;

    child.emit("error", new Error("stop test child"));
    await expect(started).rejects.toThrow("stop test child");
    expect(listenerCount).toBeGreaterThan(0);
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
    });

    expect(Object.keys(registry).sort()).toEqual(["claude", "codex", "trae"]);
    expect(registry.codex).toBeInstanceOf(CodexConnector);
    expect(registry.claude).toBeInstanceOf(ClaudeConnector);
    expect(registry.trae).toBeInstanceOf(TraeConnector);
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
  if (id === "trae") {
    input.snapshot.permissionMode = "request_approval";
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

async function waitForEvent(events: ConnectorEvent[], type: ConnectorEvent["type"]): Promise<void> {
  const deadline = Date.now() + 500;
  while (!events.some((event) => event.type === type)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${type}`);
    await sleep(5);
  }
}

async function waitForTerminalCount(calls: TerminalCall[], count: number): Promise<void> {
  const deadline = Date.now() + 500;
  while (calls.length < count) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${count} terminal calls`);
    await sleep(5);
  }
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
