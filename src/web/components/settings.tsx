import type {
  AgentCatalog,
  AgentProbe,
  AgentProductId,
  PermissionMode,
} from "../../shared/contracts.js";
import { isPhaseOneAgentProductId } from "../api.js";

export interface AgentSettingsItem {
  id: AgentProductId;
  name: string;
  status: AgentProbe["status"];
  version?: string;
  executablePath?: string;
  executablePathOverride?: string;
  diagnostic?: string;
  catalog: AgentCatalog;
}

interface SettingsProps {
  agents: AgentSettingsItem[];
  onSaveExecutablePath(agentId: AgentProductId, path: string | null): void;
}

const permissionLabels: Record<PermissionMode, string> = {
  request_approval: "Request approval",
  help_me_approve: "Help me approve",
  full_access: "Full access",
};

export function Settings(props: SettingsProps) {
  return (
    <section className="settings" aria-label="Agent Product settings">
      <h1>Agent Products</h1>
      <div className="settings__agents">
        {props.agents.filter((agent) => isPhaseOneAgentProductId(agent.id)).map((agent) => (
          <article key={agent.id} className="settings__agent-card">
            <h2>{agent.name}</h2>
            <p className="settings__status">{statusText(agent)}</p>
            <p>Version: {agent.version ?? "Not detected"}</p>
            <p>Executable: {agent.executablePath ?? "Not resolved"}</p>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                const path = new FormData(event.currentTarget).get("path");
                const trimmed = typeof path === "string" ? path.trim() : "";
                props.onSaveExecutablePath(agent.id, trimmed || null);
              }}
            >
              <label htmlFor={`${agent.id}-executable-path`}>
                {agent.name} executable path override
              </label>
              <input
                id={`${agent.id}-executable-path`}
                name="path"
                type="text"
                defaultValue={agent.executablePathOverride ?? ""}
              />
              <button type="submit">Save {agent.name} path</button>
            </form>

            <section aria-label={`${agent.name} diagnostics`}>
              <h3>Diagnostic</h3>
              <p>{agent.diagnostic ?? "No diagnostic reported"}</p>
            </section>

            <section aria-label={`${agent.name} catalog models`}>
              <h3>Catalog models</h3>
              {agent.catalog.error ? <p>{agent.catalog.error}</p> : null}
              {agent.catalog.models.length > 0 ? (
                <ul>
                  {agent.catalog.models.map((model) => (
                    <li key={model}>{model}</li>
                  ))}
                </ul>
              ) : (
                <p>No catalog models reported</p>
              )}
            </section>

            <section aria-label={`${agent.name} permission modes`}>
              <h3>Permission modes</h3>
              {agent.catalog.permissionModes.length > 0 ? (
                <ul>
                  {agent.catalog.permissionModes.map((mode) => (
                    <li key={mode}>{permissionLabels[mode]}</li>
                  ))}
                </ul>
              ) : (
                <p>No permission modes reported</p>
              )}
            </section>
          </article>
        ))}
      </div>
    </section>
  );
}

function statusText(agent: AgentSettingsItem): string {
  switch (agent.status) {
    case "not_installed":
      return `${agent.name} is not installed`;
    case "authentication_required":
      return `${agent.name} requires authentication`;
    case "available":
      return `${agent.name} is available`;
    case "runtime_error":
      return `${agent.name} has a runtime error`;
    case "version_unsupported":
      return `${agent.name} version is unsupported`;
    case "capability_limited":
      return `${agent.name} has limited capabilities`;
  }
}
