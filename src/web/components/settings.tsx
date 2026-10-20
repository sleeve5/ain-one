import type { AgentCatalog, AgentProbe, AgentProductId } from "../../shared/contracts.js";
import { isPhaseOneAgentProductId } from "../api.js";
import { agentLabel, sortAgents } from "../agent-meta.js";

export interface AgentSettingsItem {
  id: AgentProductId; name: string; status: AgentProbe["status"]; version?: string;
  enabled?: boolean; executablePath?: string; executablePathOverride?: string; diagnostic?: string; catalog: AgentCatalog;
}

interface SettingsProps {
  agents: AgentSettingsItem[]; language?: "zh" | "en";
  onPickExecutablePath(agentId: AgentProductId): Promise<string | null>;
  onSaveExecutablePath(agentId: AgentProductId, path: string | null): void;
  onSetEnabled?(agentId: AgentProductId, enabled: boolean): void;
}

export function Settings(props: SettingsProps) {
  const zh = props.language === "zh";
  return <section className="settings" aria-label="Agent Product settings">
    <h1>{zh ? "Agent 设置" : "Agent Products"}</h1>
    <p className="settings__intro">{zh ? "管理本机 Agent 的启用状态和可用模型。" : "Manage local Agents and available models."}</p>
    <div className="settings__agents">
      {sortAgents(props.agents.filter((agent) => isPhaseOneAgentProductId(agent.id))).map((agent) => <article key={agent.id} className="settings__agent-card">
        <div className="settings__agent-row">
          <div><h2><span aria-hidden="true" className={`settings__agent-state settings__agent-state--${displayState(agent)}`}>{statusText(agent, zh)}</span>{agentLabel(agent.id)}</h2><p>{zh ? "版本" : "Version"}: {agent.version ?? "—"}</p></div>
          <div className="settings__agent-actions">
            <button type="button" aria-label={`${zh ? "导入其他" : "Import another"} ${agentLabel(agent.id)} ${zh ? "路径" : "path"}`} onClick={() => void props.onPickExecutablePath(agent.id).then((path) => { if (path) props.onSaveExecutablePath(agent.id, path); })}>{zh ? "导入其他路径" : "Import another path"}</button>
            <button type="button" aria-label={`${agent.enabled === false ? (zh ? "启用" : "Enable") : (zh ? "停用" : "Disable")} ${agentLabel(agent.id)}`} disabled={displayState(agent) === "absent"} onClick={() => props.onSetEnabled?.(agent.id, agent.enabled === false)}>{agent.enabled === false ? (zh ? "启用" : "Enable") : (zh ? "停用" : "Disable")}</button>
          </div>
        </div>
        <section aria-label={`${agentLabel(agent.id)} catalog models`} className="settings__models"><h3>{zh ? "可用模型" : "Available models"}</h3>{agent.catalog.models.length ? <ul>{agent.catalog.models.map((model) => <li key={model}>{model}</li>)}</ul> : <p>{zh ? "未发现可用模型" : "No catalog models reported"}</p>}</section>
      </article>)}
    </div>
  </section>;
}

function statusText(agent: AgentSettingsItem, zh: boolean): string {
  const state = displayState(agent);
  return state === "enabled" ? (zh ? "已启用" : "Enabled") : state === "disabled" ? (zh ? "已停用" : "Disabled") : (zh ? "不存在" : "Not found");
}

function displayState(agent: AgentSettingsItem): "enabled" | "disabled" | "absent" {
  if (agent.status === "not_installed") return "absent";
  return agent.enabled === false ? "disabled" : "enabled";
}
