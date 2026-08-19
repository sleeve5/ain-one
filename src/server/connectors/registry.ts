import type { AgentProductId } from "../../shared/contracts.js";
import { type BaseConnectorOptions } from "./base.js";
import { ClaudeConnector } from "./claude.js";
import { CodexConnector } from "./codex.js";
import { OpenCodeConnector } from "./opencode.js";
import { TraeConnector } from "./trae.js";

export type ConnectorRegistryOptions = Partial<Record<AgentProductId, BaseConnectorOptions>>;

export function createConnectorRegistry(options: ConnectorRegistryOptions = {}) {
  return {
    codex: new CodexConnector(options.codex),
    claude: new ClaudeConnector(options.claude),
    trae: new TraeConnector(options.trae),
    opencode: new OpenCodeConnector(options.opencode),
  };
}

