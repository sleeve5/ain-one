import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createApiServer, InputError } from "./api.js";
import type { AgentConnector, AgentProductId } from "../shared/contracts.js";
import { createServerConfig, type ServerConfig } from "./config.js";
import { createConnectorRegistry } from "./connectors/registry.js";
import { createDatabase } from "./db.js";
import { createProjectFilesService, pickLocalPath, pickProjectDirectory } from "./files.js";
import { createGraphRepository } from "./graph-repository.js";
import { GraphRuntime } from "./graph-runtime.js";
import { discoverNativeMcpDefinitions } from "./mcp-discovery.js";
import { discoverNativeSkillRoots } from "./skill-discovery.js";
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
  discoverLocalPlugins?: boolean;
  allowedOrigins?: string[];
}

export async function startServer(overrides: StartServerOptions = {}): Promise<RunningServer> {
  const config = createServerConfig(overrides);
  mkdirSync(config.dataDir, { recursive: true });

  const database = createDatabase(config.sqlitePath);
  const repositories = createRepositories(database);
  const graphRepository = createGraphRepository(database);
  const executablePaths = repositories.getAgentExecutablePaths();
  const connectors: Partial<Record<AgentProductId, AgentConnector>> =
    overrides.connectors ?? createConnectorRegistry({
      codex: { executable: executablePaths.codex, useAppServer: true },
      claude: { executable: executablePaths.claude },
      trae: { executable: executablePaths.trae },
      opencode: { executable: executablePaths.opencode },
    });
  const discoverLocalPlugins = overrides.discoverLocalPlugins ?? true;
  const pluginHub = overrides.pluginHub ?? createPluginHub({
    dataDir: config.dataDir,
    skillRoots: discoverLocalPlugins ? {
      codex: join(homedir(), ".codex", "skills"),
      claude: join(homedir(), ".claude", "skills"),
      trae: join(homedir(), ".trae", "skills"),
      opencode: join(homedir(), ".config", "opencode", "skills"),
    } : {},
    discoverSkillRoots: discoverLocalPlugins ? () => discoverNativeSkillRoots({
      codexExecutable: executablePaths.codex ?? "codex",
    }) : undefined,
    discoverMcpDefinitions: discoverLocalPlugins ? () => discoverNativeMcpDefinitions({
      dataDir: config.dataDir,
      executables: {
        codex: executablePaths.codex ?? "codex",
        trae: executablePaths.trae ?? "traecli",
      },
    }) : undefined,
  });
  const importLocalPlugins = async () => {
    const before = new Set(pluginHub.listInstalled().map(pluginVersionKey));
    const plugins = await pluginHub.importConfiguredRoots();
    const globalScope = { type: "global" } as const;
    const firstImport = !repositories.isPluginScopeConfigured(globalScope);
    const added = plugins.filter((plugin) =>
      plugin.compatibleAgents.length > 0 && (firstImport || !before.has(pluginVersionKey(plugin))),
    );
    if (added.length > 0) {
      const enabled = new Map(
        repositories.listPluginEnablements(globalScope).map((plugin) => [plugin.pluginId, plugin]),
      );
      for (const plugin of added) enabled.set(plugin.pluginId, plugin);
      repositories.setPluginEnablements(globalScope, [...enabled.values()]);
    }
    return plugins;
  };
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
  const graphRuntime = new GraphRuntime({
    repository: graphRepository,
    connectors,
    projectPath: (graphId) => {
      const graph = graphRepository.getGraph(graphId);
      const project = graph ? repositories.getProject(graph.projectId) : null;
      if (!project) throw new Error("Graph project not found");
      return project.path;
    },
  });

  const shutdown = async (): Promise<void> => {
    try {
      await Promise.all([turnCoordinator.shutdown(), graphRuntime.shutdown()]);
    } finally {
      database.close();
    }
  };

  try {
    await turnCoordinator.recoverInterruptedTurns();
    await turnCoordinator.recoverPendingQueues();
    graphRepository.interruptActiveRuns();
    await importLocalPlugins();
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
    graphRepository,
    graphRuntime,
    resolvePluginVersions,
    validatePluginVersions: (scope, pluginVersions) => {
      const installed = new Map(
        pluginHub.listInstalled().map((plugin) => [
          `${plugin.pluginId}\0${plugin.versionId}`,
          plugin,
        ]),
      );
      if (pluginVersions.some(
        (plugin) => !installed.has(`${plugin.pluginId}\0${plugin.versionId}`),
      )) {
        throw new InputError(400, "plugin_version_not_found", "Plugin version not found");
      }
      if (pluginVersions.some(
        (plugin) => installed.get(`${plugin.pluginId}\0${plugin.versionId}`)?.compatibleAgents.length === 0,
      )) {
        throw new InputError(
          400,
          "plugin_incompatible",
          "Plugin has no compatible Agent Product",
        );
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
    pickProjectDirectory,
    pickLocalPath: (kind, purpose) => pickLocalPath(kind, purpose),
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
            enabled: repositories.isAgentEnabled(id),
            probe: await connector.probe(),
          };
        }),
      ),
    updateAgentSettings: overrides.connectors
      ? undefined
      : async ({ agentProductId, executablePath, enabled }) => {
          if (executablePath === undefined) {
            repositories.setAgentEnabled(agentProductId, enabled ?? true);
            return "updated";
          }
          const registry = createConnectorRegistry({
            [agentProductId]: { executable: executablePath ?? undefined, ...(agentProductId === "codex" ? { useAppServer: true } : {}) },
          });
          const connector = registry[agentProductId];
          const probe = await connector.probe();
          if (
            !probe.version
            || probe.status === "not_installed"
            || probe.status === "runtime_error"
            || probe.status === "version_unsupported"
          ) {
            throw new InputError(
              400,
              "agent_identity_mismatch",
              `Executable did not identify as ${agentProductId}`,
            );
          }
          const result = await turnCoordinator.setConnector(agentProductId, connector);
          if (result === "turn_active") {
            return result;
          }
          repositories.setAgentExecutablePath(agentProductId, executablePath);
          repositories.setAgentEnabled(agentProductId, enabled ?? true);
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
        const installed = pluginHub.listInstalled().find(
          (item) => pluginVersionKey(item) === pluginVersionKey(plugin),
        );
        if (installed?.compatibleAgents.length) {
          const enabled = new Map(
            repositories.listPluginEnablements({ type: "global" }).map((item) => [item.pluginId, item]),
          );
          enabled.set(plugin.pluginId, plugin);
          repositories.setPluginEnablements({ type: "global" }, [...enabled.values()]);
        }
        return { status: 201, body: { plugin } };
      }
      if (method === "POST" && path === "/api/plugins/scan") {
        const plugins = await importLocalPlugins();
        return { status: 200, body: { plugins, candidates: pluginHub.listCandidates() } };
      }
      const acceptMatch = /^\/api\/plugins\/candidates\/([^/]+)\/accept$/.exec(path);
      if (method === "POST" && acceptMatch) {
        const plugin = await pluginHub.acceptCandidate(decodeURIComponent(acceptMatch[1]));
        return { status: 201, body: { plugin } };
      }
      const repairMatch = /^\/api\/plugins\/([^/]+)\/versions\/([^/]+)\/materializations\/([^/]+)\/repair$/.exec(path);
      if (method === "POST" && repairMatch) {
        const agentProductId = readAgentProductId(decodeURIComponent(repairMatch[3]));
        const result = await turnCoordinator.runBetweenTurns(agentProductId, () =>
          pluginHub.repairMaterialization(
            agentProductId,
            {
              pluginId: decodeURIComponent(repairMatch[1]),
              versionId: decodeURIComponent(repairMatch[2]),
            },
          ),
        );
        if (result === "turn_active") {
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
  let stopPromise: Promise<void> | null = null;

  return {
    url: api.url,
    token: config.token,
    async stop() {
      stopPromise ??= (async () => {
        await api.stop();
        await shutdown();
      })();
      await stopPromise;
    },
  };
}

function defaultExecutable(agentProductId: AgentProductId): string {
  return agentProductId === "trae" ? "traecli" : agentProductId;
}

function pluginVersionKey(plugin: { pluginId: string; versionId: string }): string {
  return `${plugin.pluginId}\0${plugin.versionId}`;
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
