import { homedir } from "node:os";
import { join } from "node:path";

export interface ServerConfig {
  dataDir: string;
  sqlitePath: string;
}

export function createServerConfig(
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  const dataDir = overrides.dataDir ?? process.env.AIN_ONE_DATA_DIR ?? defaultDataDir();
  return {
    dataDir,
    sqlitePath: overrides.sqlitePath ?? join(dataDir, "ain-one.sqlite"),
  };
}

function defaultDataDir(): string {
  return join(homedir(), ".ain-one");
}
