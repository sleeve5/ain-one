import type { AgentProductId } from "../../shared/contracts.js";

const agentLabels: Record<AgentProductId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  trae: "Trae CLI",
  opencode: "OpenCode",
};

export function AgentBadge(props: { agent: AgentProductId; className?: string }) {
  return <span className={["agent-badge", props.className].filter(Boolean).join(" ")} data-agent={props.agent}>{agentLabels[props.agent]}</span>;
}
