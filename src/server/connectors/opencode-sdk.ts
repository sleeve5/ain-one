import type { ChildProcess } from "node:child_process";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import type {
  AgentCatalog,
  LiveSession,
  SessionInput,
} from "../../shared/contracts.js";
import { redactSecrets, type BaseConnectorOptions } from "./base.js";
import type { OpenCodeSdkAdapter } from "./opencode.js";

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
      return {
        status: "capability_limited",
        diagnostic: "Ain One does not yet stream native OpenCode SDK events; Turn execution is disabled",
      };
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

    async startTurn(session) {
      const runtime = runtimes.get(session.id);
      if (!runtime || !session.nativeSessionId) {
        throw definiteStartError("OpenCode session is not initialized");
      }
      runtimes.delete(session.id);
      await runtime.server.close();
      throw definiteStartError(
        "Ain One OpenCode Turn execution is disabled until native SDK events are streamed",
      );
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

function definiteStartError(message: string): Error {
  const error = new Error(message) as Error & { definiteStartRejection?: boolean };
  error.definiteStartRejection = true;
  return error;
}
