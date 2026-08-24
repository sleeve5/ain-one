import { useState } from "react";
import type { AgentProductId, PluginVersion } from "../../shared/contracts.js";
import { isPhaseOneAgentProductId, type PluginMaterializationView } from "../api.js";

export type PluginType = "skill" | "mcp";
export type PluginScope = "global" | "project" | "conversation";

export interface InstalledPluginVersion extends PluginVersion {
  type: PluginType;
  compatibleAgents: AgentProductId[];
  materializations: PluginMaterializationView[];
}

export interface PluginImportCandidate extends PluginVersion {
  type: PluginType;
  compatibleAgents: AgentProductId[];
  candidateId: string;
  sourceAgent: AgentProductId;
}

interface PluginSettingsProps {
  installedVersions: InstalledPluginVersion[];
  importCandidates: PluginImportCandidate[];
  error?: string | null;
  scope: PluginScope;
  conversationAgentProductId?: AgentProductId | null;
  enabledVersions: PluginVersion[];
  enablementsLoading?: boolean;
  enablementsLocked: boolean;
  onAcceptCandidate(candidateId: string): void;
  onInstallLocalPath(path: string, type: PluginType, compatibleAgents: AgentProductId[]): void;
  onRefreshImports(): void;
  onScopeChange(scope: PluginScope): void;
  onEnableChange(
    scope: PluginScope,
    change: PluginVersion & { enabled: boolean },
  ): void;
  onRepairMaterialization(agentProductId: AgentProductId, plugin: PluginVersion): void;
}

const agentLabels: Record<AgentProductId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  trae: "Trae",
  opencode: "OpenCode",
};

const phaseOneAgentProducts: AgentProductId[] = ["codex", "claude", "trae"];

export function PluginSettings(props: PluginSettingsProps) {
  const [installType, setInstallType] = useState<PluginType>("skill");

  return (
    <section className="plugin-settings" aria-label="Plugin settings">
      <h1>Plugins</h1>
      {props.error ? <p role="alert">Plugin inventory unavailable: {props.error}</p> : null}
      <button type="button" onClick={props.onRefreshImports}>
        Refresh imports
      </button>

      <form
        className="plugin-settings__install"
        onSubmit={(event) => {
          event.preventDefault();
          const path = new FormData(event.currentTarget).get("path");
          const compatibleAgents = new FormData(event.currentTarget)
            .getAll("compatibleAgents")
            .filter(isAgentProductId);
          if (
            typeof path === "string" &&
            path.trim() &&
            (installType === "mcp" || compatibleAgents.length > 0)
          ) {
            props.onInstallLocalPath(path.trim(), installType, compatibleAgents);
          }
        }}
      >
        <label htmlFor="local-plugin-type">Local plugin type</label>
        <select
          id="local-plugin-type"
          value={installType}
          onChange={(event) => setInstallType(event.currentTarget.value as PluginType)}
        >
          <option value="skill">Skill directory</option>
          <option value="mcp">Ain One MCP definition</option>
        </select>
        <label htmlFor="local-plugin-path">Local plugin path</label>
        <input id="local-plugin-path" name="path" type="text" required />
        <fieldset>
          <legend>Compatible Agent Products</legend>
          {phaseOneAgentProducts.map((agentProductId) => (
            <label key={agentProductId}>
              <input
                type="checkbox"
                name="compatibleAgents"
                value={agentProductId}
                aria-label={`Compatible with ${agentLabels[agentProductId]}`}
                disabled={installType === "mcp"}
              />
              {agentLabels[agentProductId]}
            </label>
          ))}
        </fieldset>
        <button type="submit">Install local plugin</button>
      </form>

      <label htmlFor="plugin-scope">Plugin scope</label>
      <select
        id="plugin-scope"
        value={props.scope}
        onChange={(event) => props.onScopeChange(event.currentTarget.value as PluginScope)}
      >
        <option value="global">Global</option>
        <option value="project">Project</option>
        <option value="conversation">Conversation</option>
      </select>
      {props.enablementsLocked ? (
        <p role="status">Active Turns must finish before changing this plugin scope.</p>
      ) : null}

      <section aria-label="Installed plugin versions">
        <h2>Installed versions</h2>
        <ul className="plugin-settings__versions">
          {props.installedVersions.map((version) => {
            const unavailable = !version.compatibleAgents.some(isPhaseOneAgentProductId);
            const incompatible =
              props.scope === "conversation" &&
              props.conversationAgentProductId != null &&
              !version.compatibleAgents.includes(props.conversationAgentProductId);
            return (
            <li key={`${version.pluginId}:${version.versionId}`}>
              <article className="plugin-settings__version">
                <p>Plugin: {version.pluginId}</p>
                <p>Version: {version.versionId}</p>
                <p>Type: {version.type}</p>
                <p>{compatibilityText(version.compatibleAgents)}</p>
                <ul aria-label={`Materialization status for ${version.pluginId} ${version.versionId}`}>
                  {version.materializations
                    .filter((materialization) =>
                      isPhaseOneAgentProductId(materialization.agentProductId)
                    )
                    .map((materialization) => (
                    <li key={materialization.agentProductId}>
                      {agentLabels[materialization.agentProductId]}: {statusLabel(materialization.status)}
                      {materialization.repairable ? (
                        <button
                          type="button"
                          aria-label={`Repair ${version.pluginId} ${version.versionId} for ${agentLabels[materialization.agentProductId]}`}
                          onClick={() => props.onRepairMaterialization(materialization.agentProductId, version)}
                        >
                          Repair
                        </button>
                      ) : null}
                    </li>
                    ))}
                </ul>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Enable ${version.pluginId} ${version.versionId}`}
                    disabled={
                      props.enablementsLoading ||
                      props.enablementsLocked ||
                      unavailable ||
                      incompatible
                    }
                    checked={props.enabledVersions.some(
                      (enabled) =>
                        enabled.pluginId === version.pluginId &&
                        enabled.versionId === version.versionId,
                    )}
                    onChange={(event) =>
                      props.onEnableChange(props.scope, {
                        pluginId: version.pluginId,
                        versionId: version.versionId,
                        enabled: event.currentTarget.checked,
                      })
                    }
                  />
                  Enabled for {props.scope}
                </label>
                {incompatible ? (
                  <p>Incompatible with {agentLabels[props.conversationAgentProductId!]}</p>
                ) : null}
                {unavailable ? <p>Unavailable in Phase 1</p> : null}
              </article>
            </li>
            );
          })}
        </ul>
      </section>

      <section aria-label="Plugin import candidates">
        <h2>Import candidates</h2>
        <ul className="plugin-settings__candidates">
          {props.importCandidates
            .filter((candidate) => isPhaseOneAgentProductId(candidate.sourceAgent))
            .map((candidate) => (
            <li key={`${candidate.pluginId}:${candidate.versionId}:${candidate.sourceAgent}`}>
              <article className="plugin-settings__candidate">
                <p>Plugin: {candidate.pluginId}</p>
                <p>Version: {candidate.versionId}</p>
                <p>Type: {candidate.type}</p>
                <p>Source agent: {agentLabels[candidate.sourceAgent]}</p>
                <p>{compatibilityText(candidate.compatibleAgents)}</p>
                <button
                  type="button"
                  aria-label={`Accept ${candidate.pluginId} ${candidate.versionId}`}
                  onClick={() => props.onAcceptCandidate(candidate.candidateId)}
                >
                  Accept
                </button>
              </article>
            </li>
            ))}
        </ul>
      </section>
    </section>
  );
}

function compatibilityText(agents: AgentProductId[]): string {
  const visibleAgents = agents.filter(isPhaseOneAgentProductId);
  return `Compatible agents: ${
    visibleAgents.length > 0
      ? visibleAgents.map((agent) => agentLabels[agent]).join(", ")
      : "None declared"
  }`;
}

function statusLabel(status: PluginMaterializationView["status"]): string {
  switch (status) {
    case "materialized":
      return "Materialized";
    case "not_materialized":
      return "Not materialized";
    case "conflicted":
      return "Conflict";
    case "turn_scoped":
      return "Generated per Turn";
  }
}

function isAgentProductId(value: FormDataEntryValue): value is AgentProductId {
  return isPhaseOneAgentProductId(value);
}
