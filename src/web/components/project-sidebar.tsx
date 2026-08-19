import type { ConversationView, ProjectView } from "../api.js";

interface ProjectSidebarProps {
  projects: ProjectView[];
  conversations: ConversationView[];
  selectedProjectId: string | null;
  selectedConversationId: string | null;
  onSelectProject(projectId: string): void;
  onSelectConversation(conversationId: string): void;
}

export function ProjectSidebar(props: ProjectSidebarProps) {
  return (
    <nav className="project-sidebar" aria-label="Projects and conversations">
      <h2 className="project-sidebar__heading">Projects</h2>
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
                        {conversation.latestTurnStatus === "failed" ||
                        conversation.latestTurnStatus === "interrupted" ? (
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
