import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentCatalog, AgentProbe, LiveSession, SessionInput, StartTurnInput } from "../../shared/contracts.js";
import { BaseConnectorOptions, isMissingExecutableError, parseVersion } from "./base.js";
import { CliJsonlConnector, readMcpArtifact, type JsonlEventContext } from "./cli-jsonl.js";

export class ClaudeConnector extends CliJsonlConnector {
  readonly id = "claude" as const;

  protected defaultExecutable(): string {
    return "claude";
  }

  async probe(): Promise<AgentProbe> {
    try {
      const [version, auth] = await Promise.all([
        this.runCommand({ args: ["--version"] }),
        this.runCommand({ args: ["auth", "status", "--json"] }),
      ]);
      if (version.exitCode !== 0) {
        return { status: "runtime_error", diagnostic: version.stderr.trim() || version.stdout.trim() };
      }
      if (auth.exitCode !== 0) {
        return { status: "runtime_error", version: parseVersion(version.stdout), diagnostic: auth.stderr.trim() || auth.stdout.trim() };
      }

      const parsed = JSON.parse(auth.stdout) as { loggedIn?: unknown };
      if (parsed.loggedIn !== true) {
        return { status: "authentication_required", version: parseVersion(version.stdout) };
      }

      return {
        status: "capability_limited",
        version: parseVersion(version.stdout),
        diagnostic: "Interactive permission replies are not supported in non-interactive Claude print mode",
      };
    } catch (error) {
      if (isMissingExecutableError(error)) {
        return { status: "not_installed" };
      }
      return {
        status: "runtime_error",
        diagnostic: error instanceof Error ? error.message : "Failed to probe claude",
      };
    }
  }

  async fetchCatalog(projectPath: string): Promise<AgentCatalog> {
    const configuredModel = await this.readConfiguredModel(projectPath);
    return {
      models: configuredModel && !isKnownForeignModel(configuredModel) ? [configuredModel] : [],
      permissionModes: ["request_approval", "help_me_approve", "full_access"],
    };
  }

  async createOrResumeSession(input: SessionInput): Promise<LiveSession> {
    const nativeSessionId = input.nativeSessionId ?? this.newSessionUuid();
    if (input.nativeSessionId == null) {
      try {
        await input.onNativeSessionId?.(nativeSessionId);
      } catch (error) {
        const definite = error instanceof Error ? error : new Error("Failed to persist native session id");
        (definite as Error & { definiteSessionFailure: boolean }).definiteSessionFailure = true;
        throw definite;
      }
    }
    return this.createRuntimeSession(input, nativeSessionId);
  }

  protected async mapEvent(event: unknown, context: JsonlEventContext): Promise<void> {
    const record = objectValue(event);
    if (!record) {
      await super.mapEvent(event, context);
      return;
    }

    const type = stringValue(record.type);
    const sessionId = stringValue(record.session_id);
    if (sessionId) {
      await context.setNativeSessionId(sessionId);
    }

    if (type === "stream_event") {
      const streamEvent = objectValue(record.event);
      const delta = streamEvent ? objectValue(streamEvent.delta) : null;
      const text = delta?.type === "text_delta" ? stringValue(delta.text) : null;
      if (text) {
        await context.emit({
          type: "assistant_message",
          payload: { text, role: "assistant", streamId: claudeStreamId(context, sessionId), delta: true },
        });
      }
      return;
    }
    if (type === "system") {
      if (record.subtype === "init") {
        context.setNativeTurnId(null);
      }
      return;
    }
    if (type === "assistant") {
      await emitAssistantContent(record.message, context, claudeStreamId(context, sessionId));
      return;
    }
    if (type === "user") {
      await emitToolResults(record.message, context);
      return;
    }
    if (type === "result") {
      const usage = objectValue(record.usage);
      if (usage) {
        await context.emit({
          type: "usage",
          payload: { ...usage, summary: usageSummary(usage) },
        });
      }
      if (record.is_error === true) {
        await context.terminal("failed", {
          code: stringValue(record.subtype) ?? "native_failure",
          message: stringValue(record.result) ?? "Claude turn failed",
        });
      } else {
        await context.terminal("completed");
      }
      return;
    }

    await super.mapEvent(event, context);
  }

  protected buildStartArgs(session: LiveSession, input: StartTurnInput): string[] {
    const runtime = this.asRuntimeSession(session);
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];

    if (runtime.resume && runtime.nativeSessionId) {
      args.push("--resume", runtime.nativeSessionId);
    } else if (runtime.nativeSessionId) {
      args.push("--session-id", runtime.nativeSessionId);
    }

    if (input.snapshot.modelId) {
      args.push("--model", input.snapshot.modelId);
    }
    if (input.snapshot.permissionMode === "help_me_approve") {
      args.push("--permission-mode", "auto");
    }
    if (input.snapshot.permissionMode === "full_access") {
      args.push("--permission-mode", "bypassPermissions");
    }
    if (input.snapshot.permissionMode === "request_approval") {
      args.push("--permission-mode", "default");
    }

    const servers = readMcpArtifact(input.mcpConfigPath, "claude");
    if (servers.length > 0) {
      args.push(
        "--mcp-config",
        JSON.stringify({
          mcpServers: Object.fromEntries(
            servers.map((server) => [server.pluginId, server.server]),
          ),
        }),
        "--strict-mcp-config",
      );
    }

    return args;
  }

  private async readConfiguredModel(projectPath: string): Promise<string | null> {
    const home = this.env.HOME ?? process.env.HOME;
    const candidates = [
      join(projectPath, ".claude", "settings.local.json"),
      join(projectPath, ".claude", "settings.json"),
      ...(home ? [join(home, ".claude", "settings.json")] : []),
    ];

    for (const path of candidates) {
      try {
        const settings = JSON.parse(await readFile(path, "utf8")) as { model?: unknown };
        if (typeof settings.model === "string" && settings.model.trim()) {
          return settings.model.trim();
        }
      } catch {
        continue;
      }
    }
    return null;
  }
}

function isKnownForeignModel(model: string): boolean {
  return /^(?:gpt|glm|deepseek|seed|kimi|openrouter|gemini)[-_.]/i.test(model);
}

function claudeStreamId(context: JsonlEventContext, sessionId: string | null): string {
  return `claude:${context.turnId ?? sessionId ?? "current"}:assistant`;
}

async function emitAssistantContent(value: unknown, context: JsonlEventContext, streamId?: string): Promise<void> {
  const message = objectValue(value);
  const content = message && Array.isArray(message.content) ? message.content : [];
  for (const value of content) {
    const item = objectValue(value);
    if (!item) {
      continue;
    }
    if (item.type === "thinking") {
      const summary = stringValue(item.thinking);
      if (summary) {
        await context.emit({ type: "reasoning", payload: { summary } });
      }
    } else if (item.type === "text") {
      const text = stringValue(item.text);
      if (text) {
        await context.emit({ type: "assistant_message", payload: { text, role: "assistant", ...(streamId ? { streamId, final: true } : {}) } });
      }
    } else if (item.type === "tool_use") {
      await context.emit({
        type: "tool",
        payload: {
          id: stringValue(item.id),
          name: stringValue(item.name) ?? "tool",
          input: item.input,
          status: "started",
        },
      });
    }
  }
}

async function emitToolResults(value: unknown, context: JsonlEventContext): Promise<void> {
  const message = objectValue(value);
  const content = message && Array.isArray(message.content) ? message.content : [];
  for (const value of content) {
    const item = objectValue(value);
    if (!item || item.type !== "tool_result") {
      continue;
    }
    await context.emit({
      type: "tool",
      payload: {
        id: stringValue(item.tool_use_id),
        status: item.is_error === true ? "failed" : "completed",
        result: item.content,
      },
    });
  }
}

function usageSummary(usage: Record<string, unknown>): string {
  const input = numberValue(usage.input_tokens);
  const output = numberValue(usage.output_tokens);
  return input !== null && output !== null
    ? `${input} input / ${output} output tokens`
    : "Usage updated";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
