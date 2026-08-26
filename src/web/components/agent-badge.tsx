import type { AgentProductId } from "../../shared/contracts.js";
import { agentLabel } from "../agent-meta.js";

export function AgentBadge(props: { agent: AgentProductId; className?: string }) {
  return <span className={["agent-badge", props.className].filter(Boolean).join(" ")} data-agent={props.agent}>{agentLabel(props.agent)}</span>;
}
