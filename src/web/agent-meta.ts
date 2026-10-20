import type { AgentProductId } from "../shared/contracts.js";
import type { AgentSettingsView } from "./api.js";

const labels: Record<AgentProductId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  trae: "Trae CLI",
};

const order: Record<AgentProductId, number> = { codex: 0, claude: 1, trae: 2 };

export function agentLabel(agent: AgentProductId): string { return labels[agent]; }

export function sortAgents<T extends { id: AgentProductId }>(agents: readonly T[]): T[] {
  return [...agents].sort((left, right) => order[left.id] - order[right.id]);
}

export function sortAgentIds(agents: readonly AgentProductId[]): AgentProductId[] {
  return [...agents].sort((left, right) => order[left] - order[right]);
}

export function isSelectableAgent(agent: AgentSettingsView): boolean {
  return agent.enabled !== false &&
    agent.status !== "not_installed" &&
    agent.status !== "runtime_error" &&
    agent.status !== "version_unsupported";
}
