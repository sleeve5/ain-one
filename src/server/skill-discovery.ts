import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentProductId } from "../shared/contracts.js";

export interface DiscoveredSkillRoot {
  agentProductId: AgentProductId;
  path: string;
}

type SpawnLike = typeof nodeSpawn;

export async function discoverNativeSkillRoots(input: {
  codexExecutable?: string;
  homeDir?: string;
  spawn?: SpawnLike;
  timeoutMs?: number;
} = {}): Promise<DiscoveredSkillRoot[]> {
  const homeDir = input.homeDir ?? homedir();
  const roots: DiscoveredSkillRoot[] = [
    { agentProductId: "codex", path: join(homeDir, ".agents", "skills") },
  ];
  try {
    const raw = await run(input.codexExecutable ?? "codex", ["plugin", "list", "--json"], input.spawn, input.timeoutMs);
    roots.push(...parseCodexPluginSkillRoots(raw, join(homeDir, ".codex")));
  } catch {
    // The shared root remains usable when Codex or plugin discovery is unavailable.
  }
  return roots;
}

export function parseCodexPluginSkillRoots(raw: string, codexHome: string): DiscoveredSkillRoot[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!isRecord(parsed) || !Array.isArray(parsed.installed)) return [];
  return parsed.installed.flatMap((plugin) => {
    if (!isRecord(plugin) || plugin.installed !== true || plugin.enabled !== true) return [];
    if (plugin.name === "trae-queue") return [];
    const segments = [plugin.marketplaceName, plugin.name, plugin.version];
    if (!segments.every(isSafePathSegment)) return [];
    return [{
      agentProductId: "codex" as const,
      path: join(codexHome, "plugins", "cache", ...segments as string[], "skills"),
    }];
  });
}

function isSafePathSegment(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9._+-]+$/.test(value) && value !== "." && value !== "..";
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
      rejectPromise(new Error("Codex plugin discovery timed out"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", (code) => { clearTimeout(timer); code === 0
      ? resolvePromise(Buffer.concat(chunks).toString("utf8"))
      : rejectPromise(new Error(`Codex plugin discovery exited ${code}`)); });
  });
}
