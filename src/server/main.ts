import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createApiServer } from "./api.js";
import { createServerConfig, type ServerConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createProjectFilesService } from "./files.js";
import { createRepositories } from "./repositories.js";
import { TurnCoordinator } from "./turn-coordinator.js";

export interface RunningServer {
  url: string;
  stop(): Promise<void>;
}

export async function startServer(overrides: Partial<ServerConfig> = {}): Promise<RunningServer> {
  const config = createServerConfig(overrides);
  mkdirSync(config.dataDir, { recursive: true });

  const database = createDatabase(config.sqlitePath);
  const repositories = createRepositories(database);
  const turnCoordinator = new TurnCoordinator({
    repositories,
    connectors: {},
  });

  await turnCoordinator.recoverInterruptedTurns();

  const api = createApiServer({
    host: config.host,
    port: config.port,
    token: config.token,
    repositories,
    turnCoordinator,
    files: createProjectFilesService(),
    allowedOrigins: [
      `http://127.0.0.1:${config.port}`,
      `http://localhost:${config.port}`,
      `http://[::1]:${config.port}`,
    ],
  });

  await api.start();

  return {
    url: api.url,
    async stop() {
      await api.stop();
      database.close();
    },
  };
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
