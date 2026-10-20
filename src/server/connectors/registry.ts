import { type BaseConnectorOptions } from "./base.js";
import { ClaudeConnector } from "./claude.js";
import { CodexConnector } from "./codex.js";
import { TraeConnector } from "./trae.js";

export interface ConnectorRegistryOptions {
  codex?: BaseConnectorOptions & { useAppServer?: boolean };
  claude?: BaseConnectorOptions;
  trae?: BaseConnectorOptions;
}

export function createConnectorRegistry(options: ConnectorRegistryOptions = {}) {
  return {
    codex: new CodexConnector(options.codex),
    claude: new ClaudeConnector(options.claude),
    trae: new TraeConnector(options.trae),
  };
}
