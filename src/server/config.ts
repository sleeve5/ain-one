import { randomBytes } from "node:crypto";
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
    token: overrides.token ?? process.env.AIN_ONE_TOKEN ?? randomBytes(24).toString("hex"),
  };
}

function defaultDataDir(): string {
  return join(homedir(), ".ain-one");
}
