import type { AgentCatalog, AgentProbe, LiveSession, SessionInput, StartTurnInput } from "../../shared/contracts.js";
import { BaseConnectorOptions, isMissingExecutableError, parseVersion } from "./base.js";
import { CliJsonlConnector } from "./cli-jsonl.js";

export class OpenCodeConnector extends CliJsonlConnector {
  readonly id = "opencode" as const;

  protected defaultExecutable(): string {
    return "opencode";
  }

  async probe(): Promise<AgentProbe> {
    try {
      const result = await this.runCommand({ args: ["--version"] });
      if (result.exitCode !== 0) {
        return { status: "runtime_error", diagnostic: result.stderr.trim() || result.stdout.trim() };
      }
      return {
        status: "capability_limited",
        version: parseVersion(result.stdout),
        diagnostic: "OpenCode CLI transport is available, but permission replies and plugin workflows are not implemented",
      };
    } catch (error) {
      if (isMissingExecutableError(error)) {
        return { status: "not_installed" };
      }
      return {
        status: "runtime_error",
        diagnostic: error instanceof Error ? error.message : "Failed to probe opencode",
      };
    }
  }

  async fetchCatalog(_projectPath: string): Promise<AgentCatalog> {
    return {
      models: [],
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

    if (input.snapshot.modelId) {
      args.push("--model", input.snapshot.modelId);
    }
    if (input.snapshot.permissionMode === "help_me_approve") {
      args.push("--permission-mode", "auto");
    }
    if (input.snapshot.permissionMode === "request_approval") {
      args.push("--permission-mode", "default");
    }
    if (input.snapshot.permissionMode === "full_access") {
      args.push("--permission-mode", "bypass_permissions");
    }

    return args;
  }
}

