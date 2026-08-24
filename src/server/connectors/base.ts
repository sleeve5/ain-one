import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFile } from "node:fs/promises";
import type {
  AgentCatalog,
  AgentConnector,
  AgentProbe,
  CancelResult,
  ConnectorEvent,
  LiveSession,
  MaterializeInput,
  MaterializeResult,
  NativePluginCandidate,
  PermissionDecision,
  SessionInput,
  StartTurnInput,
  TerminalTurnStatus,
} from "../../shared/contracts.js";

export type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ConnectorCallbacks {
  onTerminal: (input: {
    conversationId: string;
    turnId: string;
    nativeTurnId: string | null;
    status: TerminalTurnStatus;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  }) => Promise<void>;
}

export interface BaseConnectorOptions {
  executable?: string;
  spawn?: SpawnLike;
  env?: NodeJS.ProcessEnv;
  killTimeoutMs?: number;
  maxStderrBytes?: number;
  modelsCachePath?: string;
}

export interface ActiveTurnController {
  nativeTurnId: string | null;
  settled: Promise<void>;
  cancel(): Promise<boolean>;
  close(): Promise<void>;
}

export interface RuntimeSession extends LiveSession {
  projectPath: string;
  resume: boolean;
  onEvent?: SessionInput["onEvent"];
  onNativeSessionId?: SessionInput["onNativeSessionId"];
  activeTurn?: ActiveTurnController;
  settled?: Promise<void>;
  closePromise?: Promise<void>;
}

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

export class UnsupportedCapabilityError extends Error {
  readonly code = "UNSUPPORTED_CAPABILITY";

  constructor(readonly capability: string, message?: string) {
    super(message ?? `${capability} is not supported by this connector`);
    this.name = "UnsupportedCapabilityError";
  }
}

export abstract class BaseConnector implements AgentConnector {
  abstract readonly id: AgentConnector["id"];

  protected readonly executable: string;
  protected readonly spawn: SpawnLike;
  protected readonly env: NodeJS.ProcessEnv;
  protected readonly killTimeoutMs: number;
  protected readonly maxStderrBytes: number;
  protected readonly modelsCachePath?: string;
  private callbacks: ConnectorCallbacks | null = null;

  constructor(options: BaseConnectorOptions = {}) {
    this.executable = options.executable ?? this.defaultExecutable();
    this.spawn = options.spawn ?? nodeSpawn;
    this.env = options.env ?? {};
    this.killTimeoutMs = options.killTimeoutMs ?? 1_000;
    this.maxStderrBytes = options.maxStderrBytes ?? 4_096;
    this.modelsCachePath = options.modelsCachePath;
  }

  abstract probe(): Promise<AgentProbe>;

  abstract fetchCatalog(projectPath: string): Promise<AgentCatalog>;

  abstract createOrResumeSession(input: SessionInput): Promise<LiveSession>;

  abstract startTurn(session: LiveSession, input: StartTurnInput): Promise<{ nativeTurnId: string | null }>;

  setTurnCallbacks(callbacks: ConnectorCallbacks): void {
    this.callbacks = callbacks;
  }

  async respondToPermission(
    _session: LiveSession,
    _requestId: string,
    _decision: PermissionDecision,
  ): Promise<void> {
    throw new UnsupportedCapabilityError(
      "permission_response",
      `${this.id} does not support interactive permission responses in non-interactive mode`,
    );
  }

  async cancelTurn(session: LiveSession, _nativeTurnId: string | null): Promise<CancelResult> {
    const runtime = this.asRuntimeSession(session);
    const activeTurn = runtime.activeTurn;
    if (!activeTurn) {
      return { confirmed: false };
    }
    return { confirmed: await activeTurn.cancel() };
  }

  async closeSession(session: LiveSession): Promise<void> {
    const runtime = this.asRuntimeSession(session);
    if (runtime.closePromise) {
      return runtime.closePromise;
    }

    runtime.closePromise = (async () => {
      const activeTurn = runtime.activeTurn;
      if (activeTurn) {
        await activeTurn.close();
      }
    })();

    return runtime.closePromise;
  }

  async discoverPlugins(): Promise<NativePluginCandidate[]> {
    return [];
  }

  async materializePlugins(input: MaterializeInput): Promise<MaterializeResult> {
    if (input.plugins.length === 0) {
      return { applied: [] };
    }
    throw new UnsupportedCapabilityError(
      "plugin_materialization",
      `${this.id} plugin materialization is deferred to Task 5`,
    );
  }

  protected abstract defaultExecutable(): string;

  protected createRuntimeSession(
    input: SessionInput,
    nativeSessionId: string | null = input.nativeSessionId,
  ): RuntimeSession {
    return {
      id: input.conversationId,
      nativeSessionId,
      projectPath: input.projectPath,
      resume: input.nativeSessionId != null,
      onEvent: input.onEvent,
      onNativeSessionId: input.onNativeSessionId,
    };
  }

  protected asRuntimeSession(session: LiveSession): RuntimeSession {
    return session as RuntimeSession;
  }

  protected async emitEvent(session: RuntimeSession, event: ConnectorEvent): Promise<void> {
    if (!session.onEvent) {
      return;
    }
    try {
      await session.onEvent({
        type: event.type,
        payload: deepRedactStrings(event.payload) as Record<string, unknown>,
      });
    } catch {
      return;
    }
  }

  protected async emitTerminal(
    session: RuntimeSession,
    input: {
      turnId: string | undefined;
      nativeTurnId: string | null;
      status: TerminalTurnStatus;
      error?: { code: string; message: string; details?: Record<string, unknown> };
    },
  ): Promise<void> {
    if (!this.callbacks || !input.turnId) {
      return;
    }
    const sanitizedError = input.error
      ? (deepRedactStrings(input.error as JsonLike) as {
          code: string;
          message: string;
          details?: Record<string, unknown>;
        })
      : undefined;
    await this.callbacks.onTerminal({
      conversationId: redactSecrets(session.id),
      turnId: redactSecrets(input.turnId),
      nativeTurnId: input.nativeTurnId ? redactSecrets(input.nativeTurnId) : null,
      status: input.status,
      error: sanitizedError,
    });
  }

  protected async syncNativeSessionId(
    session: RuntimeSession,
    nextNativeSessionId: string | null,
  ): Promise<void> {
    if (nextNativeSessionId == null) {
      return;
    }
    if (session.nativeSessionId === nextNativeSessionId) {
      return;
    }
    session.nativeSessionId = nextNativeSessionId;
    await session.onNativeSessionId?.(nextNativeSessionId);
  }

  protected newSessionUuid(): string {
    return randomUUID();
  }

  protected async runCommand(input: {
    args: string[];
    cwd?: string;
    stdin?: string;
    maxBytes?: number;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const maxBytes = input.maxBytes ?? 64 * 1024;
    const child = this.spawn(this.executable, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...this.env },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;

    const append = (target: Buffer[], chunk: Buffer): void => {
      if (truncated) {
        return;
      }
      const remaining = maxBytes - totalBytes;
      if (remaining <= 0) {
        truncated = true;
        child.kill();
        return;
      }
      const portion = chunk.subarray(0, remaining);
      target.push(portion);
      totalBytes += portion.length;
      if (portion.length < chunk.length) {
        truncated = true;
        child.kill();
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));

    const close = new Promise<number>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code) => resolvePromise(code ?? 0));
    });

    if (typeof input.stdin === "string") {
      child.stdin?.end(input.stdin);
    } else {
      child.stdin?.end();
    }

    const exitCode = await close;
    return {
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
  }

  protected async readModelsCache(): Promise<string[]> {
    if (!this.modelsCachePath) {
      return [];
    }

    try {
      const raw = await readFile(this.modelsCachePath, "utf8");
      const parsed = JSON.parse(raw) as { models?: unknown };
      const models = Array.isArray(parsed.models) ? parsed.models : [];
      return models
        .map((entry) => {
          if (typeof entry === "string") {
            return entry;
          }
          if (entry && typeof entry === "object") {
            const id =
              (entry as { id?: unknown; slug?: unknown; name?: unknown; display_name?: unknown }).id ??
              (entry as { id?: unknown; slug?: unknown; name?: unknown; display_name?: unknown }).slug ??
              (entry as { id?: unknown; slug?: unknown; name?: unknown; display_name?: unknown }).name ??
              (entry as { id?: unknown; slug?: unknown; name?: unknown; display_name?: unknown }).display_name;
            return typeof id === "string" ? id : null;
          }
          return null;
        })
        .filter((value): value is string => Boolean(value));
    } catch {
      return [];
    }
  }
}

export function parseVersion(output: string): string | undefined {
  const match = output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/);
  return match?.[0];
}

export function isMissingExecutableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown };
  return candidate.code === "ENOENT";
}

export function redactSecrets(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\b(token|api[_-]?key|secret|cookie|session)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

export function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars)}...`;
}

export function deepRedactStrings<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => deepRedactStrings(entry)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, deepRedactStrings(entry)]),
    ) as T;
  }
  return value;
}
