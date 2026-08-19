import type { AgentCatalog, AgentProbe, LiveSession, SessionInput, StartTurnInput } from "../../shared/contracts.js";
import { BaseConnectorOptions, isMissingExecutableError, parseVersion } from "./base.js";
import { CliJsonlConnector } from "./cli-jsonl.js";

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

  async fetchCatalog(_projectPath: string): Promise<AgentCatalog> {
    return {
      models: ["sonnet", "opus", "haiku", "fable"],
      permissionModes: ["request_approval", "help_me_approve", "full_access"],
    };
  }

  async createOrResumeSession(input: SessionInput): Promise<LiveSession> {
    return this.createRuntimeSession(input, input.nativeSessionId ?? this.newSessionUuid());
  }

  protected buildStartArgs(session: LiveSession, input: StartTurnInput): string[] {
    const runtime = this.asRuntimeSession(session);
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
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

    return args;
  }
}
