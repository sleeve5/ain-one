import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createApiServer, InputError } from "./api.js";
import type { AgentConnector, AgentProductId } from "../shared/contracts.js";
import { createServerConfig, type ServerConfig } from "./config.js";
import { createConnectorRegistry } from "./connectors/registry.js";
import { createDatabase } from "./db.js";
import { createProjectFilesService } from "./files.js";
import {
  createPluginHub,
  type InstallLocalInput,
  type PluginHub,
} from "./plugins.js";
import { createRepositories } from "./repositories.js";
import { TurnCoordinator } from "./turn-coordinator.js";

export interface RunningServer {
  url: string;
  token: string;
  stop(): Promise<void>;
}

export interface StartServerOptions extends Partial<ServerConfig> {
  connectors?: Partial<Record<AgentProductId, AgentConnector>>;
  pluginHub?: PluginHub;
  allowedOrigins?: string[];
}

export async function startServer(overrides: StartServerOptions = {}): Promise<RunningServer> {
  const config = createServerConfig(overrides);
  mkdirSync(config.dataDir, { recursive: true });

  const database = createDatabase(config.sqlitePath);
  const repositories = createRepositories(database);
  const executablePaths = repositories.getAgentExecutablePaths();
  const connectors: Partial<Record<AgentProductId, AgentConnector>> =
    overrides.connectors ?? createConnectorRegistry({
      codex: { executable: executablePaths.codex },
      claude: { executable: executablePaths.claude },
      trae: { executable: executablePaths.trae },
      opencode: { executable: executablePaths.opencode },
    });
  const pluginHub = overrides.pluginHub ?? createPluginHub({
    dataDir: config.dataDir,
    skillRoots: {
      codex: join(homedir(), ".codex", "skills"),
      claude: join(homedir(), ".claude", "skills"),
      trae: join(homedir(), ".trae", "skills"),
      opencode: join(homedir(), ".config", "opencode", "skills"),
    },
  });
  const resolvePluginVersions = (input: {
    projectId: string;
    conversationId: string;
    agentProductId: AgentProductId;
  }) => pluginHub.resolveForTurn({
    agentProductId: input.agentProductId,
    global: repositories.resolvePluginVersions(input.projectId, input.conversationId),
  });
  const turnCoordinator = new TurnCoordinator({
    repositories,
    connectors,
    resolvePluginVersions,
    materializePlugins: async ({ turnId, agentProductId, plugins }) => {
      return pluginHub.materialize(agentProductId, plugins, { turnId });
    },
  });

  const shutdown = async (): Promise<void> => {
    try {
      await turnCoordinator.shutdown();
    } finally {
      database.close();
    }
  };

  try {
    await turnCoordinator.recoverInterruptedTurns();
    await turnCoordinator.recoverPendingQueues();
    await pluginHub.scanConfiguredRoots();
  } catch (error) {
    await shutdown().catch(() => undefined);
    throw error;
  }

  const api = createApiServer({
    host: config.host,
    port: config.port,
    token: config.token,
    repositories,
    turnCoordinator,
    resolvePluginVersions,
    validatePluginVersions: (scope, pluginVersions) => {
      const installed = new Set(
        pluginHub.listInstalled().map((plugin) => `${plugin.pluginId}\0${plugin.versionId}`),
      );
      if (pluginVersions.some(
        (plugin) => !installed.has(`${plugin.pluginId}\0${plugin.versionId}`),
      )) {
        throw new InputError(400, "plugin_version_not_found", "Plugin version not found");
      }
      if (scope.type === "conversation") {
        const conversation = repositories.getConversation(scope.id);
        const compatible = conversation
          ? pluginHub.resolveForTurn({
              agentProductId: conversation.agentProductId,
              conversation: pluginVersions,
            })
          : [];
        if (compatible.length !== pluginVersions.length) {
          throw new InputError(
            400,
            "plugin_incompatible",
            "Plugin is incompatible with the Conversation Agent Product",
          );
        }
      }
    },
    files: createProjectFilesService(),
    allowedOrigins: [
      `http://127.0.0.1:${config.port}`,
      `http://localhost:${config.port}`,
      `http://[::1]:${config.port}`,
      ...(overrides.allowedOrigins ?? []),
    ],
    listAgents: async () =>
      Promise.all(
        Object.entries(connectors).map(async ([agentProductId, connector]) => {
          const id = agentProductId as AgentProductId;
          const executablePathOverride = repositories.getAgentExecutablePaths()[id] ?? null;
          return {
            agentProductId: id,
            executablePath: executablePathOverride ?? defaultExecutable(id),
            executablePathOverride,
            probe: await connector.probe(),
          };
        }),
      ),
    updateAgentSettings: overrides.connectors
      ? undefined
      : async ({ agentProductId, executablePath }) => {
          const registry = createConnectorRegistry({
            [agentProductId]: { executable: executablePath ?? undefined },
          });
          const connector = registry[agentProductId];
          const result = await turnCoordinator.setConnector(agentProductId, connector);
          if (result === "turn_active") {
            return result;
          }
          repositories.setAgentExecutablePath(agentProductId, executablePath);
          return "updated";
        },
    catalogProvider: async ({ agentProductId, projectPath }) => {
      const connector = connectors[agentProductId];
      if (!connector) {
        throw new Error(`No connector registered for ${agentProductId}`);
      }
      return connector.fetchCatalog(projectPath);
    },
    pluginHandler: async ({ method, path, body }) => {
      if (method === "GET" && path === "/api/plugins") {
        return {
          status: 200,
          body: {
            plugins: pluginHub.listInstalled(),
            candidates: pluginHub.listCandidates(),
          },
        };
      }
      if (method === "POST" && path === "/api/plugins/install") {
        const input = readObject(body, "Invalid plugin install payload");
        const sourcePath = readRequiredString(input, "path");
        const compatibility = readCompatibility(input.compatibility);
        const plugin = await pluginHub.installLocal({ path: sourcePath, compatibility });
        return { status: 201, body: { plugin } };
      }
      if (method === "POST" && path === "/api/plugins/scan") {
        const candidates = await pluginHub.scanConfiguredRoots();
        return { status: 200, body: { candidates } };
      }
      const acceptMatch = /^\/api\/plugins\/candidates\/([^/]+)\/accept$/.exec(path);
      if (method === "POST" && acceptMatch) {
        const plugin = await pluginHub.acceptCandidate(decodeURIComponent(acceptMatch[1]));
        return { status: 201, body: { plugin } };
      }
      const repairMatch = /^\/api\/plugins\/([^/]+)\/versions\/([^/]+)\/materializations\/([^/]+)\/repair$/.exec(path);
      if (method === "POST" && repairMatch) {
        const agentProductId = readAgentProductId(decodeURIComponent(repairMatch[3]));
        if (repositories.hasActiveTurnForAgent(agentProductId)) {
          return {
            status: 409,
            body: {
              error: {
                code: "turn_active",
                message: "Plugin materialization can change only between Turns",
              },
            },
          };
        }
        await pluginHub.repairMaterialization(
          agentProductId,
          {
            pluginId: decodeURIComponent(repairMatch[1]),
            versionId: decodeURIComponent(repairMatch[2]),
          },
        );
        return { status: 200, body: { repaired: true } };
      }
      return { status: 404, body: { error: { code: "not_found", message: "Route not found" } } };
    },
  });

  try {
    await api.start();
  } catch (error) {
    await shutdown().catch(() => undefined);
    throw error;
  }

  return {
    url: api.url,
    token: config.token,
    async stop() {
      await api.stop();
      await shutdown();
    },
  };
}

function defaultExecutable(agentProductId: AgentProductId): string {
  return agentProductId === "trae" ? "traecli" : agentProductId;
}

function readObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(400, "invalid_plugin_input", message);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.trim().length === 0) {
    throw new InputError(400, "invalid_plugin_input", `${key} must be a non-empty string`);
  }
  return result.trim();
}

function readAgentProductId(value: unknown): AgentProductId {
  if (value === "codex" || value === "claude" || value === "trae" || value === "opencode") {
    return value;
  }
  throw new InputError(400, "invalid_agent_product", "Unsupported Agent Product");
}

function readCompatibility(
  value: unknown,
): NonNullable<InstallLocalInput["compatibility"]> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = readCompatibilityObject(value, "compatibility must be an object");
  const compatibility: NonNullable<InstallLocalInput["compatibility"]> = {};

  for (const [agent, rawSpec] of Object.entries(record)) {
    const agentProductId = readAgentProductId(agent);
    const spec = readCompatibilityObject(rawSpec, `${agent} compatibility must be an object`);
    if (spec.kind === "skill") {
      compatibility[agentProductId] = { kind: "skill" };
      continue;
    }
    if (spec.kind !== "mcp") {
      throw new InputError(400, "invalid_plugin_compatibility", "Unsupported compatibility kind");
    }
    const target = readCompatibilityString(spec.target, "MCP target must be a non-empty string");
    const server = readCompatibilityObject(spec.server, "MCP server must be an object");
    compatibility[agentProductId] = { kind: "mcp", target, server };
  }

  return compatibility;
}

function readCompatibilityObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(400, "invalid_plugin_compatibility", message);
  }
  return value as Record<string, unknown>;
}

function readCompatibilityString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InputError(400, "invalid_plugin_compatibility", message);
  }
  return value.trim();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer()
    .then((server) => {
      process.stdout.write(`Ain One API listening at ${server.url}\n`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
