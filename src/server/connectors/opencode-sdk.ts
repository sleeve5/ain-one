import type { ChildProcess } from "node:child_process";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import type {
  AgentCatalog,
  ConnectorEvent,
  LiveSession,
  SessionInput,
  StartTurnInput,
} from "../../shared/contracts.js";
import { redactSecrets, type BaseConnectorOptions } from "./base.js";
import type { OpenCodeSdkAdapter, OpenCodeSdkTurn } from "./opencode.js";

interface OfficialRuntime {
  client: ReturnType<typeof createOpencodeClient>;
  projectPath: string;
  server: { close(): Promise<void> };
}

export function createOfficialOpenCodeSdkAdapter(
  options: BaseConnectorOptions = {},
): OpenCodeSdkAdapter {
  const runtimes = new Map<string, OfficialRuntime>();
  const executable = options.executable ?? "opencode";
  const spawn = options.spawn;
  const env = options.env ?? {};
  const killTimeoutMs = options.killTimeoutMs ?? 1_000;

  const ensureRuntime = async (conversationId: string, projectPath: string) => {
    const existing = runtimes.get(conversationId);
    if (existing) {
      return { runtime: existing, created: false };
    }
    const server = await startServer({ executable, spawn, env, killTimeoutMs, projectPath });
    const runtime = {
      client: createOpencodeClient({ baseUrl: server.url }),
      projectPath,
      server,
    };
    runtimes.set(conversationId, runtime);
    return { runtime, created: true };
  };

  return {
    async probe() {
      return { status: "available" };
    },

    async fetchCatalog(projectPath): Promise<AgentCatalog> {
      const server = await startServer({ executable, spawn, env, killTimeoutMs, projectPath });
      try {
        const response = await createOpencodeClient({ baseUrl: server.url }).provider.list(
          { directory: projectPath },
          { throwOnError: true },
        );
        const connected = new Set(response.data.connected);
        return {
          models: response.data.all
            .filter((provider) => connected.has(provider.id))
            .flatMap((provider) =>
              Object.keys(provider.models).map((modelId) => `${provider.id}/${modelId}`),
            ),
          permissionModes: ["full_access"],
        };
      } finally {
        await server.close();
      }
    },

    async createOrResumeSession(input: SessionInput) {
      const { runtime, created } = await ensureRuntime(input.conversationId, input.projectPath);
      if (input.nativeSessionId) {
        return { nativeSessionId: input.nativeSessionId };
      }
      try {
        const response = await runtime.client.session.create(
          {
            directory: input.projectPath,
            permission: permissionRules(),
          },
          { throwOnError: true },
        );
        return { nativeSessionId: response.data.id };
      } catch (error) {
        if (created) {
          runtimes.delete(input.conversationId);
          await runtime.server.close().catch(() => undefined);
        }
        throw error;
      }
    },

    async startTurn(session, input, sink): Promise<OpenCodeSdkTurn> {
      const runtime = runtimes.get(session.id);
      if (!runtime || !session.nativeSessionId) {
        throw definiteStartError("OpenCode session is not initialized");
      }
      if (input.snapshot.permissionMode !== "full_access") {
        throw definiteStartError("OpenCode headless transport supports only full access");
      }

      let cancelled = false;
      let closing = false;
      const cancellation: { confirmation: Promise<boolean> | null } = { confirmation: null };
      const request = new AbortController();
      const settled = (async () => {
        try {
          await runtime.client.session.update(
            {
              sessionID: session.nativeSessionId!,
              directory: runtime.projectPath,
              permission: permissionRules(),
            },
            { throwOnError: true, signal: request.signal },
          );
          const response = await runtime.client.session.prompt(
            {
              sessionID: session.nativeSessionId!,
              directory: runtime.projectPath,
              ...(input.snapshot.modelId ? { model: parseModel(input.snapshot.modelId) } : {}),
              parts: [{ type: "text", text: input.content }],
            },
            { throwOnError: true, signal: request.signal },
          );
          for (const event of normalizePrompt(response.data)) {
            await sink.emitEvent(event);
          }
          await sink.emitTerminal({
            turnId: input.turnId,
            nativeTurnId: null,
            status: cancelled ? "cancelled" : "completed",
          });
        } catch (error) {
          if (cancellation.confirmation) {
            cancelled = await cancellation.confirmation.catch(() => false);
          }
          const status = cancelled ? "cancelled" : closing ? "interrupted" : "failed";
          await sink.emitTerminal({
            turnId: input.turnId,
            nativeTurnId: null,
            status,
            ...(status !== "failed"
              ? {}
              : {
                  error: {
                    code: "opencode_sdk_error",
                    message: error instanceof Error ? error.message : "OpenCode SDK request failed",
                  },
                }),
          });
        }
      })();

      return {
        nativeTurnId: null,
        settled,
        async cancel() {
          cancellation.confirmation ??= runtime.client.session.abort(
            { sessionID: session.nativeSessionId!, directory: runtime.projectPath },
            { throwOnError: true },
          ).then((response) => response.data === true);
          cancelled = await cancellation.confirmation;
          if (!cancelled) {
            return false;
          }
          await settled;
          return true;
        },
        async close() {
          closing = true;
          request.abort(new Error("OpenCode session closed"));
          await runtime.server.close();
          await settled;
        },
      };
    },

    async closeSession(session: LiveSession) {
      const runtime = runtimes.get(session.id);
      if (!runtime) {
        return;
      }
      runtimes.delete(session.id);
      await runtime.server.close();
    },
  };
}

function permissionRules(): PermissionRuleset {
  return [{ permission: "*", pattern: "*", action: "allow" }];
}

async function startServer(input: {
  executable: string;
  spawn?: BaseConnectorOptions["spawn"];
  env: NodeJS.ProcessEnv;
  killTimeoutMs: number;
  projectPath: string;
}): Promise<{ url: string; close(): Promise<void> }> {
  const spawn = input.spawn ?? (await import("node:child_process")).spawn;
  const child = spawn(
    input.executable,
    ["serve", "--hostname=127.0.0.1", "--port=0"],
    {
      cwd: input.projectPath,
      env: { ...process.env, ...input.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let url: string;
  try {
    url = await readServerUrl(child);
  } catch (error) {
    await stopServer(child, input.killTimeoutMs);
    throw error;
  }
  let closePromise: Promise<void> | null = null;
  return {
    url,
    close() {
      closePromise ??= stopServer(child, input.killTimeoutMs);
      return closePromise;
    },
  };
}

function readServerUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("Timed out waiting for OpenCode server to start"));
    }, 5_000);
    const finish = (error?: Error, url?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) {
        rejectPromise(error);
      } else {
        resolvePromise(url!);
      }
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null): void =>
      finish(new Error(`OpenCode server exited before startup (${code ?? "signal"})`));
    child.on("error", onError);
    child.on("exit", onExit);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      for (const line of output.split("\n")) {
        const match = line.match(/^opencode server listening.*on\s+(https?:\/\/\S+)/);
        if (match) {
          finish(undefined, match[1]);
          return;
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output = `${output}${redactSecrets(chunk.toString("utf8"))}`.slice(-4_096);
    });
  });
}

function stopServer(child: ChildProcess, killTimeoutMs: number): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    const killTimer = setTimeout(() => child.kill("SIGKILL"), killTimeoutMs);
    child.once("close", () => {
      clearTimeout(killTimer);
      resolvePromise();
    });
    child.kill();
  });
}

function parseModel(modelId: string): { providerID: string; modelID: string } {
  const separator = modelId.indexOf("/");
  if (separator <= 0 || separator === modelId.length - 1) {
    throw definiteStartError("OpenCode model must use provider/model format");
  }
  return {
    providerID: modelId.slice(0, separator),
    modelID: modelId.slice(separator + 1),
  };
}

function normalizePrompt(value: unknown): ConnectorEvent[] {
  const record = objectValue(value);
  const info = objectValue(record?.info);
  const events: ConnectorEvent[] = [];
  for (const rawPart of Array.isArray(record?.parts) ? record.parts : []) {
    const part = objectValue(rawPart);
    if (part?.type === "text" && typeof part.text === "string") {
      events.push({ type: "assistant_message", payload: { text: part.text, role: "assistant" } });
    } else if (part?.type === "reasoning" && typeof part.text === "string") {
      events.push({ type: "reasoning", payload: { summary: part.text } });
    } else if (part?.type === "tool") {
      const state = objectValue(part.state);
      events.push({
        type: "tool",
        payload: {
          name: typeof part.tool === "string" ? part.tool : "tool",
          status: state?.status ?? "unknown",
          input: state?.input,
          output: state?.output,
          error: state?.error,
        },
      });
    }
  }
  const tokens = objectValue(info?.tokens);
  if (typeof tokens?.input === "number" && typeof tokens.output === "number") {
    events.push({
      type: "usage",
      payload: {
        ...tokens,
        summary: `${tokens.input} input / ${tokens.output} output tokens`,
      },
    });
  }
  return events;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function definiteStartError(message: string): Error {
  const error = new Error(message) as Error & { definiteStartRejection?: boolean };
  error.definiteStartRejection = true;
  return error;
}
