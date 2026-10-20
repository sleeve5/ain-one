import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
  const existing = readExistingInstallToken(tokenPath);
  if (existing !== null) {
    return existing;
  }

  return createInstallTokenAtomically(tokenPath);
}

function readExistingInstallToken(tokenPath: string): string | null {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(tokenPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }
    throw error;
  }

  if (!stats.isFile()) {
    throw new Error("install.token must be a regular file inside dataDir");
  }

  if ((stats.mode & 0o777) !== 0o600) {
    chmodSync(tokenPath, 0o600);
  }

  const existing = readFileSync(tokenPath, "utf8").trim();
  if (existing.length === 0) {
    throw new Error("install.token exists but is empty");
  }

  return existing;
}

function createInstallTokenAtomically(tokenPath: string): string {
  const created = `${randomBytes(24).toString("hex")}\n`;

  try {
    const fd = openSync(tokenPath, "wx", 0o600);
    try {
      writeFileSync(fd, created, "utf8");
    } finally {
      closeSync(fd);
    }
    return created.trim();
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      const existing = readExistingInstallToken(tokenPath);
      if (existing !== null) {
        return existing;
      }
    }
    throw new Error("Failed to create installation token");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
