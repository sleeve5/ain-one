import type { ChildProcess } from "node:child_process";
import type { AgentCatalog, AgentProbe, LiveSession, PermissionDecision, SessionInput, StartTurnInput, TerminalTurnStatus } from "../../shared/contracts.js";
import { BaseConnectorOptions, isMissingExecutableError, parseVersion, redactSecrets, truncateText, type ActiveTurnController, type RuntimeSession } from "./base.js";
import { CliJsonlConnector, readMcpArtifact, renderTomlMcpOverride } from "./cli-jsonl.js";

export class CodexConnector extends CliJsonlConnector {
  readonly id = "codex" as const;
  private readonly useAppServer: boolean;

  constructor(options: BaseConnectorOptions & { useAppServer?: boolean } = {}) {
    super({
      modelsCachePath: options.modelsCachePath ?? `${process.env.HOME ?? "~"}/.codex/models_cache.json`,
      ...options,
    });
    this.useAppServer = options.useAppServer ?? false;
  }

  protected defaultExecutable(): string {
    return "codex";
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
        diagnostic: "Interactive permission replies are not supported in non-interactive Codex exec mode",
      };
    } catch (error) {
      if (isMissingExecutableError(error)) {
        return { status: "not_installed" };
      }
      return {
        status: "runtime_error",
        diagnostic: error instanceof Error ? error.message : "Failed to probe codex",
      };
    }
  }

  async fetchCatalog(_projectPath: string): Promise<AgentCatalog> {
    return {
      models: await this.readModelsCache(),
      permissionModes: ["request_approval", "help_me_approve", "full_access"],
    };
  }

  async createOrResumeSession(input: SessionInput): Promise<LiveSession> {
    return this.createRuntimeSession(input);
  }

  protected buildStartArgs(session: LiveSession, input: StartTurnInput): string[] {
    const runtime = this.asRuntimeSession(session);
    const args = runtime.nativeSessionId
      ? ["exec", "resume", runtime.nativeSessionId, "--json"]
      : ["exec", "--json"];
    args.push("--skip-git-repo-check");

    if (input.snapshot.modelId) {
      args.push("--model", input.snapshot.modelId);
    }
    if (input.snapshot.permissionMode === "help_me_approve") {
      if (runtime.resume) {
        args.push("-c", 'approvals_reviewer="auto_review"');
      } else {
        args.push("--approve-for-me");
      }
    }
    if (input.snapshot.permissionMode === "request_approval") {
      args.push("-c", 'approval_policy="on-request"');
    }
    if (input.snapshot.permissionMode === "full_access") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    for (const server of readMcpArtifact(input.mcpConfigPath, "codex")) {
      args.push("-c", renderTomlMcpOverride(server));
    }
    return args;
  }

  override async startTurn(session: LiveSession, input: StartTurnInput): Promise<{ nativeTurnId: string | null }> {
    return this.useAppServer
      ? this.startAppServerTurn(this.asRuntimeSession(session), input)
      : super.startTurn(session, input);
  }

  override async respondToPermission(session: LiveSession, requestId: string, decision: PermissionDecision): Promise<void> {
    const active = this.asRuntimeSession(session).activeTurn as CodexActiveTurn | undefined;
    if (!active?.respondToPermission) throw new Error("Permission request is no longer active");
    await active.respondToPermission(requestId, decision);
  }

  private async startAppServerTurn(session: RuntimeSession, input: StartTurnInput): Promise<{ nativeTurnId: string | null }> {
    if (session.activeTurn) throw new Error("Turn already active");
    const args = ["app-server", "--stdio"];
    for (const server of readMcpArtifact(input.mcpConfigPath, "codex")) {
      args.push("-c", renderTomlMcpOverride(server));
    }
    const child = this.spawn(this.executable, args, {
      cwd: session.projectPath, env: { ...process.env, ...this.env },
      detached: process.platform !== "win32", shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let requestId = 0;
    let nativeTurnId: string | null = null;
    let terminalSent = false;
    let cancelling = false;
    let settledResolve!: () => void;
    const settled = new Promise<void>((resolve) => { settledResolve = resolve; });
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timeout: NodeJS.Timeout }>();
    const permissionRequests = new Map<string, string | number>();
    const write = (message: Record<string, unknown>): Promise<void> => new Promise((resolve, reject) => {
      if (!child.stdin?.writable) { reject(new Error("Codex app-server stdin is closed")); return; }
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    });
    const request = (method: string, params: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
      const id = ++requestId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${this.commandTimeoutMs}ms`));
      }, this.commandTimeoutMs);
      pending.set(id, { resolve, reject, timeout });
      void write({ id, method, params }).catch((error: Error) => {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error);
      });
    });
    const finish = async (status: TerminalTurnStatus, error?: { code: string; message: string }): Promise<void> => {
      if (terminalSent) return;
      await this.emitEvent(session, { type: "turn_status", payload: { turnId: input.turnId ?? null, nativeTurnId, status, error } });
      terminalSent = true;
      if (session.activeTurn?.settled === settled) delete session.activeTurn;
      settledResolve();
      if (child.exitCode === null && child.signalCode === null) this.killProcessTree(child);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("Codex app-server Turn ended"));
      }
      pending.clear();
      permissionRequests.clear();
      await this.emitTerminal(session, { turnId: input.turnId, nativeTurnId, status, error });
    };
    const onMessage = async (message: Record<string, unknown>): Promise<void> => {
      const method = typeof message.method === "string" ? message.method : "";
      if (!method && typeof message.id === "number") {
        const waiter = pending.get(message.id);
        if (waiter) {
          clearTimeout(waiter.timeout);
          pending.delete(message.id);
          message.error ? waiter.reject(new Error(appServerError(message.error))) : waiter.resolve(message.result);
        }
        return;
      }
      const params = asObject(message.params);
      if ((typeof message.id === "number" || typeof message.id === "string") && isApprovalRequest(method)) {
        const requestId = String(message.id);
        permissionRequests.set(requestId, message.id);
        await this.emitEvent(session, { type: "permission", payload: {
          requestId,
          request: stringField(params, "reason") ?? stringField(params, "command") ?? "Codex requests approval",
          method,
          itemId: stringField(params, "itemId"),
        } });
      } else if (method === "item/agentMessage/delta") {
        const delta = stringField(params, "delta");
        const itemId = stringField(params, "itemId");
        if (delta && itemId) await this.emitEvent(session, { type: "assistant_message", payload: { text: delta, role: "assistant", streamId: itemId, delta: true } });
      } else if (method === "item/completed") {
        await this.emitAppServerItem(asObject(params.item), session);
      } else if (method === "warning") {
        await this.emitEvent(session, { type: "warning", payload: { message: stringField(params, "message") ?? "Codex warning" } });
      } else if (method === "turn/completed") {
        const turn = asObject(params.turn);
        const status = stringField(turn, "status");
        const errorMessage = appServerError(turn.error);
        await finish(status === "completed" ? "completed" : status === "interrupted" ? "cancelled" : "failed", errorMessage ? { code: "native_failure", message: errorMessage } : undefined);
      }
    };
    let processing = Promise.resolve();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        processing = processing.then(async () => {
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            await this.emitEvent(session, { type: "warning", payload: { code: "malformed_json", line: truncateText(redactSecrets(line), 200) } });
            return;
          }
          await onMessage(message);
        }).catch((error: unknown) => finish("interrupted", { code: "event_processing_failed", message: error instanceof Error ? error.message : String(error) }));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < this.maxStderrBytes) stderr += redactSecrets(chunk.toString("utf8")).slice(0, this.maxStderrBytes - stderr.length);
    });
    child.once("error", (error) => { void finish("interrupted", { code: "app_server_error", message: error.message }); });
    child.once("close", (code) => { void processing.then(() => finish(cancelling ? "cancelled" : "interrupted", code ? { code: "app_server_exit", message: stderr.trim() || `Codex app-server exited with code ${code}` } : undefined)); });
    const activeTurn: CodexActiveTurn = {
      nativeTurnId, settled,
      cancel: async () => {
        if (!nativeTurnId || !session.nativeSessionId || terminalSent) return false;
        cancelling = true;
        try {
          await request("turn/interrupt", { threadId: session.nativeSessionId, turnId: nativeTurnId });
        } catch {
          this.killProcessTree(child);
        }
        await settled;
        return true;
      },
      close: async () => { cancelling = true; if (!terminalSent) this.killProcessTree(child); await settled; },
      respondToPermission: async (id, decision) => {
        const nativeId = permissionRequests.get(id);
        if (nativeId === undefined) throw new Error("Permission request is no longer active");
        permissionRequests.delete(id);
        await write({ id: nativeId, result: { decision: decision === "allow_once" ? "accept" : "decline" } });
        await this.emitEvent(session, { type: "permission", payload: { requestId: id, status: "resolved", decision } });
      },
    };
    session.activeTurn = activeTurn;
    session.settled = settled;

    try {
      await request("initialize", { clientInfo: { name: "ain-one", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      child.stdin?.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      const permissions = appServerPermissions(input.snapshot.permissionMode);
      const threadResult = asObject(await request(session.nativeSessionId ? "thread/resume" : "thread/start", {
        ...(session.nativeSessionId ? { threadId: session.nativeSessionId } : {}),
        cwd: session.projectPath, model: input.snapshot.modelId, ...permissions,
      }));
      const threadId = stringField(asObject(threadResult.thread), "id");
      if (!threadId) throw new Error("Codex app-server did not return a thread id");
      await this.syncNativeSessionId(session, threadId);
      const turnResult = asObject(await request("turn/start", {
        threadId, input: [{ type: "text", text: input.content, text_elements: [] }],
        model: input.snapshot.modelId, ...permissions,
      }));
      nativeTurnId = stringField(asObject(turnResult.turn), "id");
      if (!nativeTurnId) throw new Error("Codex app-server did not return a turn id");
      if (session.activeTurn) session.activeTurn.nativeTurnId = nativeTurnId;
      return { nativeTurnId };
    } catch (error) {
      await finish("start_failed", { code: "app_server_start_failed", message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async emitAppServerItem(item: Record<string, unknown>, session: RuntimeSession): Promise<void> {
    const type = stringField(item, "type");
    const id = stringField(item, "id");
    if (type === "agentMessage") {
      await this.emitEvent(session, { type: "assistant_message", payload: { text: stringField(item, "text") ?? "", role: "assistant", ...(id ? { streamId: id, final: true } : {}) } });
    } else if (type === "reasoning") {
      await this.emitEvent(session, { type: "reasoning", payload: { summary: stringField(item, "summary") ?? stringField(item, "text") ?? "Reasoning" } });
    } else if (type === "commandExecution") {
      await this.emitEvent(session, { type: "shell", payload: { ...item } });
    } else if (type === "fileChange") {
      await this.emitEvent(session, { type: "file", payload: { ...item } });
    } else if (type === "mcpToolCall" || type === "webSearch") {
      await this.emitEvent(session, { type: "tool", payload: { ...item, name: stringField(item, "tool") ?? type } });
    }
  }
}

interface CodexActiveTurn extends ActiveTurnController {
  respondToPermission?(requestId: string, decision: PermissionDecision): Promise<void>;
}

function isApprovalRequest(method: string): boolean {
  return method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
}

function appServerPermissions(mode: StartTurnInput["snapshot"]["permissionMode"]): Record<string, unknown> {
  if (mode === "full_access") return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
  if (mode === "help_me_approve") return { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } };
  return { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite" } };
}
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringField(value: Record<string, unknown>, key: string): string | null { return typeof value[key] === "string" ? value[key] : null; }
function appServerError(value: unknown): string { const record = asObject(value); return stringField(record, "message") ?? (value ? String(value) : ""); }
