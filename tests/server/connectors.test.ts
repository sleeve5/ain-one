import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { createConnectorRegistry } from "../../src/server/connectors/registry.js";
import { TraeConnector } from "../../src/server/connectors/trae.js";

type SpawnCall = {
  command: string;
  args: string[];
  shell: boolean | undefined;
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
      startArgs: ["exec", "--json", "--approve-for-me"],
      resumeArgs: ["exec", "resume", "native-session-codex", "--json", "--approve-for-me"],
    },
    {
      id: "claude",
      factory: (ctx, env) =>
        new ClaudeConnector({
          executable: fixtureBinary("fake-claude.mjs"),
          spawn: spawnRecorder(ctx.spawnCalls),
          env: env ?? fixtureEnv(ctx.recordPath),
          killTimeoutMs: 50,
        }),
      probeStatus: "capability_limited",
      catalog: {
        models: ["sonnet", "opus", "haiku", "fable"],
        permissionModes: ["request_approval", "help_me_approve", "full_access"],
      },
      startArgs: (args) => {
        expect(args.slice(0, 4)).toEqual([
          "--print",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
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
      startArgs: ["exec", "--json", "--permission-mode", "auto"],
      resumeArgs: [
        "exec",
        "resume",
        "native-session-trae",
        "--json",
        "--permission-mode",
        "auto",
      ],
    },
    {
      id: "opencode",
      factory: (ctx, env) =>
        new OpenCodeConnector({
          executable: fixtureBinary("fake-opencode.mjs"),
          spawn: spawnRecorder(ctx.spawnCalls),
          env: env ?? fixtureEnv(ctx.recordPath),
          killTimeoutMs: 50,
        }),
      probeStatus: "capability_limited",
      catalog: {
        models: [],
        permissionModes: ["request_approval", "help_me_approve", "full_access"],
      },
      startArgs: ["exec", "--json", "--permission-mode", "auto"],
      resumeArgs: [
        "exec",
        "resume",
        "native-session-opencode",
        "--json",
        "--permission-mode",
        "auto",
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

  it("reports missing executables truthfully", async () => {
    const connector = new CodexConnector({ executable: "/missing/codex" });
    await expect(connector.probe()).resolves.toMatchObject({ status: "not_installed" });
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
        executable: fixtureBinary("fake-opencode.mjs"),
        spawn: spawnRecorder(ctx.spawnCalls),
        env: fixtureEnv(ctx.recordPath),
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
    calls.push({
      command,
      args: [...args],
      shell: options.shell === undefined ? undefined : Boolean(options.shell),
    });
    return nodeSpawn(command, args, options);
  };
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
  const events: ConnectorEvent[] = [];
  const nativeSessionIds: Array<string | null> = [];
  const sessionInput: SessionInput = {
    projectPath,
    conversationId: `conversation-${id}`,
    nativeSessionId,
    onEvent: async (event) => {
      events.push(event);
    },
    onNativeSessionId: async (value) => {
      nativeSessionIds.push(value);
    },
  };
  const session = await connector.createOrResumeSession(sessionInput);
  const turn = await connector.startTurn(session, {
    content: "say hello",
    snapshot: {
      modelId: null,
      permissionMode: "help_me_approve",
      pluginVersions: [],
    },
    turnId: `turn-${id}-${nativeSessionId ? "resume" : "start"}`,
  });

  return { session, events, nativeSessionIds, nativeTurnId: turn.nativeTurnId };
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
