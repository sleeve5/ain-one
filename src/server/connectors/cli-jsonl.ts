import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type {
  ConnectorEvent,
  LiveSession,
  StartTurnInput,
  TerminalTurnStatus,
} from "../../shared/contracts.js";
import { BaseConnector, redactSecrets, truncateText, type RuntimeSession } from "./base.js";

type TurnError = { code: string; message: string; details?: Record<string, unknown> };

const MAX_STDOUT_RECORD_BYTES = 1024 * 1024;

export interface JsonlEventContext {
  readonly turnId: string | undefined;
  emit(event: ConnectorEvent): Promise<void>;
  setNativeSessionId(nativeSessionId: string | null): Promise<void>;
  setNativeTurnId(nativeTurnId: string | null): void;
  terminal(status: TerminalTurnStatus, error?: TurnError): Promise<void>;
}

interface StartCliJsonlTurnInput {
  session: RuntimeSession;
  turn: StartTurnInput;
  args: string[];
  mapEvent: (event: unknown, context: JsonlEventContext) => Promise<void>;
}

export abstract class CliJsonlConnector extends BaseConnector {
  async startTurn(session: LiveSession, input: StartTurnInput): Promise<{ nativeTurnId: string | null }> {
    const runtime = this.asRuntimeSession(session);
    let args: string[];
    try {
      args = this.buildStartArgs(runtime, input);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      (error as Error & { definiteStartRejection: boolean }).definiteStartRejection = true;
      throw error;
    }
    return this.startCliJsonlTurn({
      session: runtime,
      turn: input,
      args,
      mapEvent: async (event, context) => {
        await this.mapEvent(event, context);
      },
    });
  }

  protected abstract buildStartArgs(
    session: RuntimeSession,
    input: StartTurnInput,
  ): string[];

  protected async mapEvent(event: unknown, context: JsonlEventContext): Promise<void> {
    await mapCommonEvent(event, context);
  }

  private async startCliJsonlTurn(
    input: StartCliJsonlTurnInput,
  ): Promise<{ nativeTurnId: string | null }> {
    if (input.session.activeTurn) {
      const error = new Error("Turn already active") as Error & { definiteStartRejection?: boolean };
      error.definiteStartRejection = true;
      throw error;
    }

    let child: ChildProcess;
    try {
      child = this.spawn(this.executable, input.args, {
        cwd: input.session.projectPath,
        env: { ...process.env, ...this.env },
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw error;
    }

    let nativeTurnId: string | null = null;
    let nativeTurnStarted = false;
    const requiresPersistedSessionId = input.session.nativeSessionId == null;
    let persistedSessionId = !requiresPersistedSessionId;
    let stderrText = "";
    let stderrBytes = 0;
    let cancelled = false;
    let closing = false;
    let finalAssistantOutput = false;
    let killTimer: NodeJS.Timeout | null = null;
    let abortError: TurnError | null = null;
    let nativeTerminal: { status: TerminalTurnStatus; error?: TurnError } | null = null;
    let terminalSent = false;
    let settledResolve!: () => void;
    let settledReject!: (reason?: unknown) => void;
    const settled = new Promise<void>((resolvePromise, rejectPromise) => {
      settledResolve = resolvePromise;
      settledReject = rejectPromise;
    });
    void settled.catch(() => undefined);
    let resolveStart!: (value: { nativeTurnId: string | null }) => void;
    let rejectStart!: (reason?: unknown) => void;
    let startSettled = false;
    const started = new Promise<{ nativeTurnId: string | null }>((resolvePromise, rejectPromise) => {
      resolveStart = resolvePromise;
      rejectStart = rejectPromise;
    });

    const finalize = async (
      status: TerminalTurnStatus,
      error?: TurnError,
    ): Promise<void> => {
      if (terminalSent) {
        return;
      }
      const startReady = nativeTurnStarted && persistedSessionId;
      const effectiveStatus =
        !startReady && status !== "start_failed" ? "interrupted" : status;
      const effectiveError =
        effectiveStatus === "interrupted" && !error && !startReady
          ? {
              code: "missing_native_identity",
              message: "Native process exited before session and turn identifiers were persisted",
            }
          : error;

      if (!startSettled) {
        startSettled = true;
        if (
          effectiveStatus === "failed" ||
          effectiveStatus === "interrupted" ||
          effectiveStatus === "start_failed"
        ) {
          const startError = new Error(
            effectiveError?.message ?? "Native turn failed before start",
          ) as Error & { code?: string; definiteStartRejection?: boolean };
          if (effectiveError?.code) {
            startError.code = effectiveError.code;
          }
          if (effectiveStatus === "start_failed") {
            startError.definiteStartRejection = true;
          }
          rejectStart(startError);
        } else {
          resolveStart({ nativeTurnId });
        }
      }
      const terminal = {
        turnId: input.turn.turnId,
        nativeTurnId,
        status: effectiveStatus,
        error: effectiveError,
      };
      const finishingTurn = input.session.activeTurn?.settled === settled
        ? input.session.activeTurn
        : undefined;
      if (finishingTurn) {
        delete input.session.activeTurn;
      }
      try {
        await this.emitEvent(input.session, {
          type: "turn_status",
          payload: {
            turnId: input.turn.turnId ?? null,
            nativeTurnId,
            status: effectiveStatus,
            error: effectiveError,
          },
        });
        try {
          await this.emitTerminal(input.session, terminal);
        } catch {
          await this.emitTerminal(input.session, terminal);
        }
        terminalSent = true;
      } catch (error) {
        if (!input.session.activeTurn && finishingTurn) {
          input.session.activeTurn = finishingTurn;
        }
        settledReject(error);
        return;
      } finally {
        input.session.settled = settled;
      }
      if (terminalSent) {
        settledResolve();
      }
    };

    const maybeResolveStart = (): void => {
      if (startSettled || abortError) {
        return;
      }
      if (!persistedSessionId) {
        return;
      }
      if (!nativeTurnStarted) {
        return;
      }
      startSettled = true;
      resolveStart({ nativeTurnId });
    };

    const abortTurn = (error: TurnError): void => {
      if (terminalSent || abortError) {
        return;
      }
      abortError = error;
      stopChild();
    };

    const stopChild = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      this.killProcessTree(child);
      killTimer ??= setTimeout(() => {
        if (!terminalSent) {
          this.killProcessTree(child, "SIGKILL");
        }
      }, this.killTimeoutMs);
    };

    const closeTurn = async (): Promise<void> => {
      if (terminalSent) {
        await settled;
        return;
      }
      closing = true;
      cancelled = false;
      stopChild();
      await settled;
    };

    const cancelTurn = async (): Promise<boolean> => {
      if (terminalSent) {
        await settled;
        return false;
      }
      if (nativeTerminal) {
        stopChild();
        await settled;
        return false;
      }

      cancelled = true;
      stopChild();

      await settled;
      return terminalSent;
    };

    input.session.activeTurn = {
      nativeTurnId,
      settled,
      cancel: cancelTurn,
      close: closeTurn,
    };
    input.session.settled = settled;

    let stdoutBuffer = Buffer.alloc(0);
    let processing = Promise.resolve();

    const context: JsonlEventContext = {
      turnId: input.turn.turnId,
      emit: async (event) => {
        await this.emitEvent(input.session, event);
        if (event.type === "assistant_message") finalAssistantOutput = event.payload.final === true;
        else if (event.type === "reasoning" || event.type === "tool" || event.type === "shell" || event.type === "file" || event.type === "permission" || event.type === "warning") finalAssistantOutput = false;
      },
      setNativeSessionId: async (nextNativeSessionId) => {
        try {
          await this.syncNativeSessionId(input.session, nextNativeSessionId);
          persistedSessionId = true;
          maybeResolveStart();
        } catch (error) {
          abortTurn({
            code: "session_persist_failed",
            message: error instanceof Error ? error.message : "Failed to persist native session id",
          });
        }
      },
      setNativeTurnId: (nextNativeTurnId) => {
        nativeTurnStarted = true;
        if (nextNativeTurnId !== null) {
          nativeTurnId = nextNativeTurnId;
        }
        if (input.session.activeTurn) {
          input.session.activeTurn.nativeTurnId = nativeTurnId;
        }
        maybeResolveStart();
      },
      terminal: async (status, error) => {
        nativeTerminal = { status, error };
      },
    };

    const queue = (work: () => Promise<void>, after?: () => void): void => {
      processing = processing
        .then(work)
        .catch((error: unknown) => {
          abortTurn({
            code: "event_processing_failed",
            message: error instanceof Error ? error.message : "Event processing failed",
          });
        })
        .finally(after);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (abortError) {
        return;
      }
      const stdout = child.stdout;
      stdout?.pause();
      queue(async () => {
        stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
        while (true) {
          const newlineIndex = stdoutBuffer.indexOf(0x0a);
          if (newlineIndex === -1) {
            break;
          }
          const rawLine = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (rawLine.byteLength > MAX_STDOUT_RECORD_BYTES) {
            stdoutBuffer = Buffer.alloc(0);
            abortTurn({
              code: "stdout_record_too_large",
              message: `Native JSONL record exceeded ${MAX_STDOUT_RECORD_BYTES} bytes`,
              details: { maxBytes: MAX_STDOUT_RECORD_BYTES },
            });
            return;
          }
          const line = rawLine.toString("utf8").trim();
          if (!line) {
            continue;
          }
          let event: unknown;
          try {
            event = JSON.parse(line) as unknown;
          } catch {
            await context.emit({
              type: "warning",
              payload: {
                code: "malformed_json",
                line: truncateText(redactSecrets(line), 200),
              },
            });
            continue;
          }
          await input.mapEvent(event, context);
        }
        if (stdoutBuffer.byteLength > MAX_STDOUT_RECORD_BYTES) {
          stdoutBuffer = Buffer.alloc(0);
          abortTurn({
            code: "stdout_record_too_large",
            message: `Native JSONL record exceeded ${MAX_STDOUT_RECORD_BYTES} bytes`,
            details: { maxBytes: MAX_STDOUT_RECORD_BYTES },
          });
        }
      }, () => {
        if (!stdout?.destroyed) {
          stdout?.resume();
        }
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= this.maxStderrBytes) {
        return;
      }
      const sanitized = redactSecrets(chunk.toString("utf8"));
      const remaining = this.maxStderrBytes - stderrBytes;
      const portion = sanitized.slice(0, remaining);
      stderrText += portion;
      stderrBytes += Buffer.byteLength(portion);
    });

    child.stdin?.on("error", (error) => {
      abortTurn({
        code: "stdin_write_failed",
        message: error instanceof Error ? error.message : "Failed to write to child process",
      });
    });

    child.once("error", (error) => {
      queue(async () => {
        const code = error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
        await finalize(code === "ENOENT" || code === "EACCES" ? "start_failed" : "interrupted", {
          code: "spawn_failed",
          message: error instanceof Error ? error.message : "Failed to start child process",
        });
      });
    });

    child.once("close", (code, signal) => {
      queue(async () => {
        if (killTimer) {
          clearTimeout(killTimer);
        }

        if (terminalSent) {
          return;
        }

        if (abortError) {
          await finalize("interrupted", abortError);
          return;
        }

        if (nativeTerminal) {
          await finalize(nativeTerminal.status, nativeTerminal.error);
          return;
        }

        if (cancelled) {
          await finalize("cancelled");
          return;
        }

        if (closing) {
          await finalize(finalAssistantOutput ? "completed" : "interrupted");
          return;
        }

        if ((code ?? 0) !== 0) {
          if (!nativeTurnStarted && isSessionInUseError(stderrText)) {
            await finalize("start_failed", {
              code: "session_in_use",
              message: "This Agent session is still in use by another process. Restart the workspace and try again.",
            });
            return;
          }
          await finalize("failed", {
            code: "process_exit",
            message: stderrText.trim() || `Process exited with code ${code}`,
            details: { exitCode: code },
          });
          return;
        }

        if (signal) {
          await finalize("interrupted", {
            code: "process_signal",
            message: `Process closed with signal ${signal}`,
            details: { signal },
          });
          return;
        }

        if (!startSettled) {
          await finalize("interrupted", {
            code: "missing_native_identity",
            message: "Native process exited before session and turn identifiers were persisted",
          });
          return;
        }

        await finalize("completed");
      });
    });

    child.stdin?.end(input.turn.content);

    return started;
  }
}

function isSessionInUseError(stderr: string): boolean {
  return /thread-store conflict:[\s\S]*already has an active writer/i.test(stderr);
}

interface McpArtifactServer {
  pluginId: string;
  target: string;
  server: Record<string, unknown>;
}

export function readMcpArtifact(
  path: string | null | undefined,
  agentProductId: "codex" | "claude" | "trae",
): McpArtifactServer[] {
  if (!path) {
    return [];
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid MCP artifact");
  }
  const artifact = parsed as Record<string, unknown>;
  if (
    artifact.format !== "ain-one.turn.mcp.v1" ||
    artifact.agentProductId !== agentProductId ||
    !Array.isArray(artifact.servers)
  ) {
    throw new Error("Invalid MCP artifact");
  }
  return artifact.servers.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Invalid MCP server");
    }
    const item = value as Record<string, unknown>;
    if (
      typeof item.pluginId !== "string" ||
      item.target !== `${agentProductId}.mcp.v1` ||
      !item.server ||
      typeof item.server !== "object" ||
      Array.isArray(item.server)
    ) {
      throw new Error("Invalid MCP server");
    }
    assertNoSecretRefs(item.server);
    return {
      pluginId: item.pluginId,
      target: item.target,
      server: item.server as Record<string, unknown>,
    };
  });
}

export function renderTomlMcpOverride(server: McpArtifactServer): string {
  return `mcp_servers.${JSON.stringify(server.pluginId)}=${toToml(server.server)}`;
}

function toToml(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(toToml).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => `${JSON.stringify(key)}=${toToml(child)}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported MCP configuration value");
}

function assertNoSecretRefs(value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { secretRef?: unknown }).secretRef === "string"
  ) {
    throw new Error("MCP secretRef must be resolved before dispatch");
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    assertNoSecretRefs(child);
  }
}

async function mapCommonEvent(event: unknown, context: JsonlEventContext): Promise<void> {
  if (!event || typeof event !== "object") {
    await context.emit({
      type: "warning",
      payload: {
        code: "unknown_native_event",
        event: truncateText(redactSecrets(JSON.stringify(event)), 200),
      },
    });
    return;
  }

  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : null;
  const nativeSessionId =
    stringValue(record.session_id) ??
    stringValue(record.sessionId) ??
    stringValue(record.thread_id) ??
    stringValue(record.threadId);
  const nativeTurnId = stringValue(record.turn_id) ?? stringValue(record.turnId);

  if (nativeSessionId) {
    await context.setNativeSessionId(nativeSessionId);
  }
  if (nativeTurnId) {
    context.setNativeTurnId(nativeTurnId);
  }

  if (type === "turn.started") {
    context.setNativeTurnId(nativeTurnId);
    return;
  }

  if (type === "session.started" || type === "thread.started") {
    return;
  }

  if (type === "item.completed") {
    await mapCompletedItem(record.item, context);
    return;
  }

  if (type === "item.started") {
    return;
  }

  if (type === "item.updated" || type === "item.delta") {
    const item = objectValue(record.item);
    const delta = objectValue(record.delta);
    const itemType = item ? stringValue(item.type) : null;
    const text = stringValue(delta?.text) ?? stringValue(record.text);
    const itemId = stringValue(item?.id) ?? stringValue(record.item_id) ?? stringValue(record.itemId);
    if (itemType === "agent_message" && text && itemId) {
      await context.emit({ type: "assistant_message", payload: { text, role: "assistant", streamId: itemId, delta: true } });
      return;
    }
  }

  if (type === "message" || type === "assistant_message") {
    const role = stringValue(record.role) ?? "assistant";
    const text = stringValue(record.content) ?? stringValue(record.text) ?? "";
    await context.emit({
      type: role === "user" ? "user_message" : "assistant_message",
      payload: { text, role },
    });
    return;
  }

  if (type === "reasoning") {
    await context.emit({
      type: "reasoning",
      payload: { summary: stringValue(record.summary) ?? stringValue(record.content) ?? "" },
    });
    return;
  }

  if (type === "tool") {
    await context.emit({
      type: "tool",
      payload: {
        ...record,
        name:
          stringValue(record.name) ??
          stringValue(record.tool_name) ??
          stringValue(record.toolName) ??
          "tool",
      },
    });
    return;
  }

  if (type === "shell") {
    await context.emit({
      type: "shell",
      payload: { ...record },
    });
    return;
  }

  if (type === "file") {
    await context.emit({
      type: "file",
      payload: { ...record },
    });
    return;
  }

  if (type === "usage") {
    const inputTokens = numberValue(record.input_tokens) ?? numberValue(record.inputTokens);
    const outputTokens = numberValue(record.output_tokens) ?? numberValue(record.outputTokens);
    await context.emit({
      type: "usage",
      payload: {
        ...record,
        summary:
          inputTokens !== null && outputTokens !== null
            ? `${inputTokens} input / ${outputTokens} output tokens`
            : "Usage updated",
      },
    });
    return;
  }

  if (type === "warning") {
    await context.emit({
      type: "warning",
      payload: { ...record },
    });
    return;
  }

  if (type === "turn.completed") {
    const usage = objectValue(record.usage);
    if (usage) {
      await emitUsage(usage, context);
    }
    await context.terminal("completed");
    return;
  }

  if (type === "turn.failed") {
    await context.terminal("failed", {
      code: stringValue(record.code) ?? "native_failure",
      message: stringValue(record.message) ?? "Native turn failed",
    });
    return;
  }

  await context.emit({
    type: "warning",
    payload: {
      code: "unknown_native_event",
      event: truncateText(redactSecrets(JSON.stringify(record)), 200),
    },
  });
}

async function mapCompletedItem(
  value: unknown,
  context: JsonlEventContext,
): Promise<void> {
  const item = objectValue(value);
  if (!item) {
    return;
  }

  const type = stringValue(item.type);
  if (type === "agent_message") {
    await context.emit({
      type: "assistant_message",
      payload: { text: stringValue(item.text) ?? "", role: "assistant", ...(stringValue(item.id) ? { streamId: stringValue(item.id), final: true } : {}) },
    });
    return;
  }
  if (type === "reasoning") {
    await context.emit({
      type: "reasoning",
      payload: { summary: stringValue(item.text) ?? "" },
    });
    return;
  }
  if (type === "command_execution") {
    await context.emit({ type: "shell", payload: { ...item } });
    return;
  }
  if (type === "file_change") {
    await context.emit({ type: "file", payload: { ...item } });
    return;
  }
  if (type === "mcp_tool_call") {
    const server = stringValue(item.server) ?? stringValue(item.server_name);
    const tool = stringValue(item.tool) ?? stringValue(item.tool_name) ?? "tool";
    await context.emit({
      type: "tool",
      payload: { ...item, name: server ? `${server}.${tool}` : tool },
    });
    return;
  }
  if (type === "web_search") {
    await context.emit({ type: "tool", payload: { ...item, name: "web_search" } });
    return;
  }
  if (type === "error") {
    await context.emit({
      type: "warning",
      payload: { ...item, message: stringValue(item.message) ?? "Agent warning" },
    });
    return;
  }
  await context.emit({
    type: "warning",
    payload: {
      code: "unknown_native_event",
      event: truncateText(redactSecrets(JSON.stringify(item)), 200),
    },
  });
}

async function emitUsage(
  usage: Record<string, unknown>,
  context: JsonlEventContext,
): Promise<void> {
  const inputTokens = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens);
  const outputTokens = numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens);
  await context.emit({
    type: "usage",
    payload: {
      ...usage,
      summary:
        inputTokens !== null && outputTokens !== null
          ? `${inputTokens} input / ${outputTokens} output tokens`
          : "Usage updated",
    },
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
