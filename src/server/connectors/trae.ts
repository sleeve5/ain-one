import type { AgentCatalog, AgentProbe, ContinuationInput, LiveSession, SessionInput, StartTurnInput } from "../../shared/contracts.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BaseConnectorOptions, isMissingExecutableError, parseVersion, type RuntimeSession } from "./base.js";
import { CliJsonlConnector, readMcpArtifact, renderTomlMcpOverride } from "./cli-jsonl.js";
import { beginTraeQueueTurn, cancelTraeQueueWait, deliverToWaitingTraeQueue, readTraeQueueStatus, resolveTraeQueueHome } from "./trae-queue-bridge.js";

export class TraeConnector extends CliJsonlConnector {
  readonly id = "trae" as const;
  private readonly queueHome: string;
  private readonly autoQueueSessions = new WeakMap<LiveSession, boolean>();
  private readonly queueLeases = new WeakMap<LiveSession, string>();

  constructor(options: BaseConnectorOptions = {}) {
    const queueHome = options.queueHome ?? resolveTraeQueueHome({ ...process.env, ...options.env });
    super({ ...options, env: { ...options.env, TRAE_QUEUE_HOME: queueHome } });
    this.queueHome = queueHome;
  }

  protected defaultExecutable(): string {
    return "traecli";
  }

  async probe(): Promise<AgentProbe> {
    try {
      const [version, auth] = await Promise.all([
        this.runCommand({ args: ["--version"] }),
        this.runCommand({ args: ["login", "status"] }),
      ]);
      if (version.exitCode !== 0) {
        return { status: "runtime_error", diagnostic: version.stderr.trim() || version.stdout.trim() };
      }
      if (auth.exitCode !== 0) {
        return {
          status: "authentication_required",
          version: parseVersion(version.stdout),
          diagnostic: auth.stderr.trim() || auth.stdout.trim(),
        };
      }
      return {
        status: "capability_limited",
        version: parseVersion(version.stdout),
        diagnostic: "Interactive permission replies are not supported in non-interactive Trae exec mode",
      };
    } catch (error) {
      if (isMissingExecutableError(error)) {
        return { status: "not_installed" };
      }
      return {
        status: "runtime_error",
        diagnostic: error instanceof Error ? error.message : "Failed to probe traecli",
      };
    }
  }

  async fetchCatalog(_projectPath: string): Promise<AgentCatalog> {
    try {
      const result = await this.runCommand({ args: ["models", "--json"] });
      if (result.exitCode !== 0) {
        return {
          models: [],
          permissionModes: ["request_approval", "help_me_approve", "full_access"],
        };
      }
      const parsed = JSON.parse(result.stdout) as unknown;
      const items = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
          ? (parsed as { models: unknown[] }).models
          : [];
      return {
        models: items
          .map((item) => {
            if (!item || typeof item !== "object") {
              return null;
            }
            const record = item as { id?: unknown; name?: unknown; real_name?: unknown };
            return typeof record.id === "string"
              ? record.id
              : typeof record.name === "string"
                ? record.name
                : typeof record.real_name === "string"
                  ? record.real_name
                  : null;
          })
          .filter((value): value is string => Boolean(value)),
        permissionModes: ["request_approval", "help_me_approve", "full_access"],
      };
    } catch {
      return {
        models: [],
        permissionModes: ["request_approval", "help_me_approve", "full_access"],
      };
    }
  }

  async createOrResumeSession(input: SessionInput): Promise<LiveSession> {
    return this.createRuntimeSession(input);
  }

  async continueTurn(session: LiveSession, input: ContinuationInput): Promise<boolean> {
    if (!this.autoQueueSessions.get(session) || !session.nativeSessionId) return false;
    return deliverToWaitingTraeQueue({
      home: this.queueHome,
      sessionId: session.nativeSessionId,
      leaseId: this.queueLeases.get(session),
      ...input,
    });
  }

  async startTurn(session: LiveSession, input: StartTurnInput) {
    this.autoQueueSessions.set(session, input.snapshot.autoQueue === true);
    if (input.snapshot.autoQueue) {
      this.queueLeases.set(session, randomUUID());
      if (session.nativeSessionId) {
        await beginTraeQueueTurn({
          home: this.queueHome, sessionId: session.nativeSessionId, leaseId: this.queueLeases.get(session),
        });
      }
    }
    const turn = await super.startTurn(session, input);
    if (input.snapshot.autoQueue) {
      void this.watchQueueStatus(session).catch(() => undefined);
    }
    return turn;
  }

  async cancelTurn(session: LiveSession, nativeTurnId: string | null) {
    if (session.nativeSessionId) {
      await cancelTraeQueueWait({ home: this.queueHome, sessionId: session.nativeSessionId });
    }
    return super.cancelTurn(session, nativeTurnId);
  }

  override async closeSession(session: LiveSession): Promise<void> {
    if (session.nativeSessionId) {
      await cancelTraeQueueWait({ home: this.queueHome, sessionId: session.nativeSessionId });
    }
    await super.closeSession(session);
  }

  private async watchQueueStatus(session: LiveSession): Promise<void> {
    const runtime = this.asRuntimeSession(session);
    let previous = "";
    while (runtime.activeTurn) {
      if (runtime.nativeSessionId) {
        const status = await readTraeQueueStatus({
          home: this.queueHome, sessionId: runtime.nativeSessionId, leaseId: this.queueLeases.get(session),
        });
        const key = `${status.status}:${status.hasPendingInput}:${status.safePointId ?? ""}:${status.acknowledged?.deliveryId ?? ""}`;
        if (key !== previous) {
          previous = key;
          await this.emitEvent(runtime, { type: "queue_status", payload: status });
        }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
  }

  protected buildStartArgs(session: LiveSession, input: StartTurnInput): string[] {
    const runtime = this.asRuntimeSession(session);
    const args = runtime.nativeSessionId
      ? ["exec", "resume", runtime.nativeSessionId, "--json"]
      : ["exec", "--json"];
    args.push("--skip-git-repo-check");
    if (input.snapshot.autoQueue) {
      const hook = fileURLToPath(new URL("./trae-queue-hook.mjs", import.meta.url));
      const hookCommand = `${process.execPath} ${hook} ${this.queueLeases.get(session)}`;
      args.push(
        "-c",
        "plugins.trae-queue@local.enabled=false",
        "-c",
        `hooks.Stop=[{hooks=[{type="command",command=${JSON.stringify(hookCommand)},timeout="5h5m",statusMessage="等待用户新输入中"}]}]`,
        "-c",
        `hooks.PostToolUse=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(hookCommand)},timeout=30}]}]`,
        "-c",
        `hooks.SessionEnd=[{hooks=[{type="command",command=${JSON.stringify(hookCommand)},timeout=30}]}]`,
        "--dangerously-bypass-hook-trust",
      );
    }

    if (input.snapshot.modelId) {
      args.push("--model", input.snapshot.modelId);
    }
    if (input.snapshot.permissionMode === "help_me_approve") {
      args.push("--permission-mode", "auto");
    }
    if (input.snapshot.permissionMode === "full_access") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    for (const server of readMcpArtifact(input.mcpConfigPath, "trae")) {
      args.push("-c", renderTomlMcpOverride(server));
    }
    return args;
  }

  protected override async syncNativeSessionId(
    session: RuntimeSession,
    nextNativeSessionId: string | null,
  ): Promise<void> {
    const previousSessionId = session.nativeSessionId;
    await super.syncNativeSessionId(session, nextNativeSessionId);
    if (
      this.autoQueueSessions.get(session)
      && session.nativeSessionId
      && session.nativeSessionId !== previousSessionId
    ) {
      await beginTraeQueueTurn({
        home: this.queueHome, sessionId: session.nativeSessionId, leaseId: this.queueLeases.get(session),
      });
    }
  }
}
