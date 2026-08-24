import { useState } from "react";
import type { AgentProductId, CreateConversationInput } from "../../shared/contracts.js";
import type { AgentSettingsView, ConversationView, ProjectView } from "../api.js";

interface ProjectSidebarProps {
  projects: ProjectView[];
  conversations: ConversationView[];
  selectedProjectId: string | null;
  selectedConversationId: string | null;
  agents: AgentSettingsView[];
  onOpenProject(): Promise<void>;
  onCreateConversation(input: CreateConversationInput): Promise<void>;
  onSelectProject(projectId: string): void;
  onSelectConversation(conversationId: string): void;
}

export function ProjectSidebar(props: ProjectSidebarProps) {
  const [openingProject, setOpeningProject] = useState(false);
  const [agentProductId, setAgentProductId] = useState<AgentProductId>(
    props.agents.find(isRunnableAgent)?.id ?? "codex",
  );
  const selectedAgent = props.agents.find((agent) => agent.id === agentProductId);
  const selectedCatalog = props.selectedProjectId
    ? selectedAgent?.projectCatalogs?.[props.selectedProjectId] ?? selectedAgent?.catalog
    : selectedAgent?.catalog;

  return (
    <nav className="project-sidebar" aria-label="Projects and conversations">
      <h2 className="project-sidebar__heading">Projects</h2>
      <div className="project-sidebar__form">
        <button
          type="button"
          disabled={openingProject}
          onClick={() => {
            setOpeningProject(true);
            void props.onOpenProject()
              .catch(() => undefined)
              .finally(() => setOpeningProject(false));
          }}
        >
          {openingProject ? "Opening Folder..." : "Open Project Folder"}
        </button>
      </div>

      <form
        className="project-sidebar__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.selectedProjectId || !selectedAgent || !isRunnableAgent(selectedAgent)) {
            return;
          }
          const data = new FormData(event.currentTarget);
          const model = data.get("modelId");
          void props.onCreateConversation({
            projectId: props.selectedProjectId,
            agentProductId,
            modelId: typeof model === "string" && model ? model : null,
            permissionMode: selectedCatalog?.permissionModes[0] ?? "request_approval",
          });
        }}
      >
        <label htmlFor="new-conversation-agent">New conversation Agent Product</label>
        <select
          id="new-conversation-agent"
          value={agentProductId}
          onChange={(event) => setAgentProductId(event.currentTarget.value as AgentProductId)}
        >
          {props.agents.map((agent) => (
            <option key={agent.id} value={agent.id} disabled={!isRunnableAgent(agent)}>
              {agent.name}
            </option>
          ))}
        </select>
        <label htmlFor="new-conversation-model">New conversation model</label>
        <select id="new-conversation-model" name="modelId">
          <option value="">Default</option>
          {selectedCatalog?.models.map((model) => (
            <option key={model} value={model}>{model}</option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!props.selectedProjectId || !selectedAgent || !isRunnableAgent(selectedAgent)}
        >
          Create Conversation
        </button>
      </form>

      <ul className="project-sidebar__project-list">
        {props.projects.map((project) => {
          const projectConversations = props.conversations.filter(
            (conversation) => conversation.projectId === project.id,
          );

          return (
            <li key={project.id} className="project-sidebar__project-item">
              <button
                type="button"
                className="project-sidebar__project-button"
                data-active={props.selectedProjectId === project.id}
                aria-pressed={props.selectedProjectId === project.id}
                onClick={() => props.onSelectProject(project.id)}
              >
                {project.name}
              </button>
              <ul className="project-sidebar__conversation-list">
                {projectConversations.map((conversation) => (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className="project-sidebar__conversation-button"
                      data-active={props.selectedConversationId === conversation.id}
                      aria-pressed={props.selectedConversationId === conversation.id}
                      onClick={() => props.onSelectConversation(conversation.id)}
                    >
                      <span>{conversation.title}</span>
                      <span className="project-sidebar__badges">
                        {conversation.activeTurnStatus ? (
                          <span className="project-sidebar__badge">running</span>
                        ) : null}
                        {conversation.queuedMessages.length > 0 ? (
                          <span className="project-sidebar__badge">queued</span>
                        ) : null}
                        {conversation.latestTurnStatus === "start_failed" ||
                        conversation.latestTurnStatus === "failed" ||
                        conversation.latestTurnStatus === "interrupted" ||
                        conversation.latestTurnStatus === "cancel_failed" ? (
                          <span className="project-sidebar__badge">error</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function isRunnableAgent(agent: AgentSettingsView): boolean {
  return agent.status === "available" || agent.status === "capability_limited";
}
