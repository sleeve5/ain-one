import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerConfig {
  dataDir: string;
  sqlitePath: string;
  host: string;
  port: number;
  token: string;
}

export function createServerConfig(
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  const dataDir = overrides.dataDir ?? process.env.AIN_ONE_DATA_DIR ?? defaultDataDir();
  mkdirSync(dataDir, { recursive: true });
  const portRaw = overrides.port ?? process.env.AIN_ONE_PORT;
  const parsedPort =
    typeof portRaw === "number"
      ? portRaw
      : typeof portRaw === "string"
        ? Number.parseInt(portRaw, 10)
        : 6469;

  return {
    dataDir,
    sqlitePath: overrides.sqlitePath ?? join(dataDir, "ain-one.sqlite"),
    host: overrides.host ?? process.env.AIN_ONE_HOST ?? "127.0.0.1",
    port: Number.isFinite(parsedPort) && parsedPort >= 0 ? parsedPort : 6469,
    token: overrides.token ?? process.env.AIN_ONE_TOKEN ?? readOrCreateInstallToken(dataDir),
  };
}

function defaultDataDir(): string {
  return join(homedir(), ".ain-one");
}

function readOrCreateInstallToken(dataDir: string): string {
  const tokenPath = join(dataDir, "install.token");

  try {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch {
    // fall through to create
  }

  const created = `${randomBytes(24).toString("hex")}\n`;
  try {
    const fd = openSync(tokenPath, "wx", 0o600);
    try {
      writeFileSync(fd, created, "utf8");
    } finally {
      closeSync(fd);
    }
    return created.trim();
  } catch {
    const fallback = readFileSync(tokenPath, "utf8").trim();
    if (fallback.length > 0) {
      return fallback;
    }
    throw new Error("Failed to create installation token");
  }
}
