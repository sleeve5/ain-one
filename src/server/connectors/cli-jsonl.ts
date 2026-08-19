import type { ChildProcess } from "node:child_process";
import type { ConnectorEvent, StartTurnInput, TerminalTurnStatus } from "../../shared/contracts.js";
import { BaseConnector, redactSecrets, truncateText, type RuntimeSession } from "./base.js";

type TurnError = { code: string; message: string; details?: Record<string, unknown> };

interface JsonlEventContext {
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
  async startTurn(session: RuntimeSession, input: StartTurnInput): Promise<{ nativeTurnId: string | null }> {
    return this.startCliJsonlTurn({
      session,
      turn: input,
      args: this.buildStartArgs(session, input),
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
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw error;
    }

    let nativeTurnId: string | null = null;
    let stderrText = "";
    let stderrBytes = 0;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | null = null;
    let terminalSent = false;
    let settledResolve!: () => void;
    const settled = new Promise<void>((resolvePromise) => {
      settledResolve = resolvePromise;
    });
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
      terminalSent = true;

      if (!startSettled) {
        startSettled = true;
        if (status === "failed" || status === "interrupted" || status === "start_failed") {
          rejectStart(new Error(error?.message ?? "Native turn failed before start"));
        } else {
          resolveStart({ nativeTurnId });
        }
      }

      await this.emitEvent(input.session, {
        type: "turn_status",
        payload: {
          turnId: input.turn.turnId ?? null,
          nativeTurnId,
          status,
          error,
        },
      });
      await this.emitTerminal(input.session, {
        turnId: input.turn.turnId,
        nativeTurnId,
        status,
        error,
      });

      if (input.session.activeTurn?.settled === settled) {
        delete input.session.activeTurn;
      }
      input.session.settled = settled;
      settledResolve();
    };

    const closeTurn = async (): Promise<void> => {
      if (terminalSent) {
        await settled;
        return;
      }
      cancelled = false;
      child.kill();
      await settled;
    };

    const cancelTurn = async (): Promise<boolean> => {
      if (terminalSent) {
        await settled;
        return false;
      }

      cancelled = true;
      if (!child.killed) {
        child.kill();
      }
      killTimer = setTimeout(() => {
        if (!terminalSent) {
          child.kill("SIGKILL");
        }
      }, this.killTimeoutMs);

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

    let stdoutBuffer = "";
    let processing = Promise.resolve();

    const context: JsonlEventContext = {
      emit: async (event) => {
        await this.emitEvent(input.session, event);
      },
      setNativeSessionId: async (nextNativeSessionId) => {
        await this.syncNativeSessionId(input.session, nextNativeSessionId);
      },
      setNativeTurnId: (nextNativeTurnId) => {
        nativeTurnId = nextNativeTurnId;
        if (input.session.activeTurn) {
          input.session.activeTurn.nativeTurnId = nextNativeTurnId;
        }
        if (!startSettled && nextNativeTurnId) {
          startSettled = true;
          resolveStart({ nativeTurnId: nextNativeTurnId });
        }
      },
      terminal: async (status, error) => {
        await finalize(status, error);
      },
    };

    const queue = (work: () => Promise<void>): void => {
      processing = processing.then(work).catch(async (error: unknown) => {
        await finalize("interrupted", {
          code: "event_processing_failed",
          message: error instanceof Error ? error.message : "Event processing failed",
        });
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        queue(async () => {
          try {
            const event = JSON.parse(line) as unknown;
            await input.mapEvent(event, context);
          } catch {
            await context.emit({
              type: "warning",
              payload: {
                code: "malformed_json",
                line: truncateText(redactSecrets(line), 200),
              },
            });
          }
        });
      }
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

    child.once("error", (error) => {
      queue(async () => {
        await finalize("interrupted", {
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

        if (cancelled) {
          await finalize("cancelled");
          return;
        }

        if ((code ?? 0) !== 0) {
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

        await finalize("completed");
      });
    });

    child.stdin?.end(input.turn.content);

    return started;
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
  const nativeSessionId = stringValue(record.session_id) ?? stringValue(record.sessionId);
  const nativeTurnId = stringValue(record.turn_id) ?? stringValue(record.turnId);

  if (nativeSessionId) {
    await context.setNativeSessionId(nativeSessionId);
  }
  if (nativeTurnId) {
    context.setNativeTurnId(nativeTurnId);
  }

  if (type === "session.started" || type === "turn.started") {
    return;
  }

  if (type === "message" || type === "assistant_message") {
    const role = stringValue(record.role) ?? "assistant";
    const content = stringValue(record.content) ?? stringValue(record.text) ?? "";
    await context.emit({
      type: role === "user" ? "user_message" : "assistant_message",
      payload: { content, role },
    });
    return;
  }

  if (type === "reasoning") {
    await context.emit({
      type: "reasoning",
      payload: { content: stringValue(record.content) ?? stringValue(record.summary) ?? "" },
    });
    return;
  }

  if (type === "tool") {
    await context.emit({
      type: "tool",
      payload: { ...record },
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
    await context.emit({
      type: "usage",
      payload: { ...record },
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

