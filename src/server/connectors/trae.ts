import type { AgentCatalog, AgentProbe, LiveSession, SessionInput, StartTurnInput } from "../../shared/contracts.js";
import { BaseConnectorOptions, isMissingExecutableError, parseVersion } from "./base.js";
import { CliJsonlConnector, readMcpArtifact, renderTomlMcpOverride } from "./cli-jsonl.js";

export class TraeConnector extends CliJsonlConnector {
  readonly id = "trae" as const;

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

  protected buildStartArgs(session: LiveSession, input: StartTurnInput): string[] {
    const runtime = this.asRuntimeSession(session);
    const args = runtime.nativeSessionId
      ? ["exec", "resume", runtime.nativeSessionId, "--json"]
      : ["exec", "--json"];
    args.push("--skip-git-repo-check");

    if (input.snapshot.modelId) {
      args.push("--model", input.snapshot.modelId);
    }
    if (input.snapshot.permissionMode === "request_approval") {
      args.push("--permission-mode", "default");
    }
    if (input.snapshot.permissionMode === "help_me_approve") {
      args.push("--permission-mode", "auto");
    }
    if (input.snapshot.permissionMode === "full_access") {
      args.push("--permission-mode", "bypass_permissions", "--dangerously-bypass-approvals-and-sandbox");
    }
    for (const server of readMcpArtifact(input.mcpConfigPath, "trae")) {
      args.push("-c", renderTomlMcpOverride(server));
    }
    return args;
  }
}
