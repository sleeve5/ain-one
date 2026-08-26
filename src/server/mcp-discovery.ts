import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProductId } from "../shared/contracts.js";

export interface NativeMcpDefinition {
  agentProductId: AgentProductId;
  pluginId: string;
  server: Record<string, unknown>;
}

export interface DiscoveredMcpPath {
  agentProductId: AgentProductId;
  path: string;
}

type SpawnLike = typeof nodeSpawn;

export async function discoverNativeMcpDefinitions(input: {
  dataDir: string;
  executables: Partial<Record<AgentProductId, string>>;
  spawn?: SpawnLike;
  timeoutMs?: number;
}): Promise<DiscoveredMcpPath[]> {
  const definitions = (await Promise.all((["codex", "trae"] as const).map(async (agentProductId) => {
    const executable = input.executables[agentProductId] ?? (agentProductId === "trae" ? "traecli" : agentProductId);
    try {
      return parseNativeMcpList(agentProductId, await run(executable, ["mcp", "list", "--json"], input.spawn, input.timeoutMs));
    } catch {
      return [];
    }
  }))).flat();
  try {
    definitions.push(...parseNativeMcpConfig("claude", readFileSync(join(homedir(), ".claude.json"), "utf8")));
  } catch {
    // Claude's user configuration is optional and may not exist.
  }
  const root = join(input.dataDir, "discovered-mcp");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return definitions.map((definition) => {
    const path = join(root, `${definition.agentProductId}-${definition.pluginId}.json`);
    writeFileSync(path, `${JSON.stringify({
      format: "ain-one.mcp.v1",
      pluginId: definition.pluginId,
      compatibility: {
        [definition.agentProductId]: {
          kind: "mcp",
          target: `${definition.agentProductId}.mcp.v1`,
          server: definition.server,
        },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    return { agentProductId: definition.agentProductId, path };
  });
}

export function parseNativeMcpList(agentProductId: AgentProductId, raw: string): NativeMcpDefinition[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const result: NativeMcpDefinition[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.name !== "string" || !validPluginId(item.name) || !isRecord(item.transport)) continue;
    const transport = item.transport;
    const server = safeServer(transport);
    if (server) result.push({ agentProductId, pluginId: item.name, server });
  }
  return result.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

export function parseNativeMcpConfig(agentProductId: AgentProductId, raw: string): NativeMcpDefinition[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!isRecord(parsed)) return [];
  const sources: unknown[] = [parsed.mcpServers];
  if (isRecord(parsed.projects)) {
    sources.push(...Object.values(parsed.projects).map((project) => isRecord(project) ? project.mcpServers : null));
  }
  const byName = new Map<string, NativeMcpDefinition>();
  for (const source of sources) {
    if (!isRecord(source)) continue;
    for (const [pluginId, rawServer] of Object.entries(source)) {
      if (!validPluginId(pluginId) || !isRecord(rawServer)) continue;
      const server = safeServer(rawServer);
      if (server && !byName.has(pluginId)) byName.set(pluginId, { agentProductId, pluginId, server });
    }
  }
  return [...byName.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function safeServer(transport: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(transport.env) && Object.keys(transport.env).length > 0) return null;
  if (isRecord(transport.headers) && Object.keys(transport.headers).length > 0) return null;
  if (typeof transport.command === "string" && transport.command.trim()) {
    const args = stringArray(transport.args);
    if (args === null || args.some(looksSensitive) || args.some((arg, index) => sensitiveFlag(arg) && Boolean(args[index + 1]))) return null;
    const server: Record<string, unknown> = { command: transport.command };
    if (args.length) server.args = args;
    if (typeof transport.cwd === "string" && transport.cwd.trim()) server.cwd = transport.cwd;
    const envVars = stringArray(transport.env_vars);
    if (envVars?.length) server.env_vars = envVars;
    return server;
  }
  if (typeof transport.url === "string" && safeUrl(transport.url)) return { url: transport.url };
  return null;
}

function safeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function looksSensitive(value: string): boolean {
  return /(?:token|secret|password|api[-_]?key|authorization)(?:=|:)/i.test(value);
}

function sensitiveFlag(value: string): boolean {
  return /^(?:--?)?(?:token|secret|password|api[-_]?key|authorization)$/i.test(value);
}

function stringArray(value: unknown): string[] | null {
  if (value == null) return [];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function validPluginId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function run(command: string, args: string[], spawn: SpawnLike = nodeSpawn, timeoutMs = 5_000): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child: ChildProcess = spawn(command, args, { detached: process.platform !== "win32", shell: false, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
      rejectPromise(new Error("MCP discovery timed out"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolvePromise(Buffer.concat(chunks).toString("utf8")) : rejectPromise(new Error(`MCP discovery exited ${code}`)); });
  });
}
