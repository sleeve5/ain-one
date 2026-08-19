import type { AgentCatalog, AgentProbe, LiveSession, SessionInput, StartTurnInput } from "../../shared/contracts.js";
import { BaseConnectorOptions, isMissingExecutableError, parseVersion } from "./base.js";
import { CliJsonlConnector } from "./cli-jsonl.js";

export class CodexConnector extends CliJsonlConnector {
  readonly id = "codex" as const;

  constructor(options: BaseConnectorOptions = {}) {
    super({
      modelsCachePath: options.modelsCachePath ?? `${process.env.HOME ?? "~"}/.codex/models_cache.json`,
      ...options,
    });
  }

  protected defaultExecutable(): string {
    return "codex";
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

    if (input.snapshot.modelId) {
      args.push("--model", input.snapshot.modelId);
    }
    if (input.snapshot.permissionMode === "help_me_approve") {
      args.push("--approve-for-me");
    }
    if (input.snapshot.permissionMode === "full_access") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    return args;
  }
}

