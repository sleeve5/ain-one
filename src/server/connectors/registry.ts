import type { AgentProductId } from "../../shared/contracts.js";
import { type BaseConnectorOptions } from "./base.js";
import { ClaudeConnector } from "./claude.js";
import { CodexConnector } from "./codex.js";
import { OpenCodeConnector, type OpenCodeConnectorOptions } from "./opencode.js";
import { createOfficialOpenCodeSdkAdapter } from "./opencode-sdk.js";
import { TraeConnector } from "./trae.js";

export interface ConnectorRegistryOptions {
  codex?: BaseConnectorOptions & { useAppServer?: boolean };
  claude?: BaseConnectorOptions;
  trae?: BaseConnectorOptions;
  opencode?: OpenCodeConnectorOptions;
}

export function createConnectorRegistry(options: ConnectorRegistryOptions = {}) {
  return {
    codex: new CodexConnector(options.codex),
    claude: new ClaudeConnector(options.claude),
    trae: new TraeConnector(options.trae),
    opencode: new OpenCodeConnector({
      ...options.opencode,
      sdkAdapter:
        options.opencode?.sdkAdapter ?? createOfficialOpenCodeSdkAdapter(options.opencode),
    }),
  };
}
