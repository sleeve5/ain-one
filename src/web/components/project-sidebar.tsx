import { useEffect, useState } from "react";
import type { ConversationView, ProjectView } from "../api.js";

interface ProjectSidebarProps {
  projects: ProjectView[]; conversations: ConversationView[]; selectedProjectId: string | null; selectedConversationId: string | null;
  onOpenProject(): Promise<void>; onRestartWorkspace(): Promise<void>; onCreateConversation(): void; onSelectProject(id: string): void; onSelectConversation(id: string): void; onOpenSettings(): void;
  onRenameProject?(id: string, name: string): Promise<void>; onArchiveProject?(id: string): Promise<void>; onRenameConversation?(id: string, title: string): Promise<void>; onArchiveConversation?(id: string): Promise<void>; onForkConversation?(id: string): Promise<void>;
  collapsed: boolean; onToggleCollapsed(): void; language?: "zh" | "en";
  unreadConversationIds?: ReadonlySet<string>;
}

export function ProjectSidebar(props: ProjectSidebarProps) {
  const zh = props.language === "zh";
  const [searchOpen, setSearchOpen] = useState(false); const [query, setQuery] = useState(""); const [menu, setMenu] = useState<string | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [opening, setOpening] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [rename, setRename] = useState<{ kind: "project" | "conversation"; id: string; value: string } | null>(null);
  const matches = (value: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".project-sidebar__menu, .project-sidebar__more")) {
        setMenu(null);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [menu]);

  return <nav className="project-sidebar" aria-label={zh ? "项目与对话" : "Projects and conversations"}>
    <div className="project-sidebar__brand"><span className="project-sidebar__logo">A1</span><strong>Ain One</strong><button type="button" aria-label={props.collapsed ? (zh ? "展开侧栏" : "Expand sidebar") : (zh ? "收起侧栏" : "Collapse sidebar")} onClick={props.onToggleCollapsed}>{props.collapsed ? "›" : "‹"}</button></div>
    <button type="button" className="project-sidebar__new" aria-label={zh ? "新对话" : "New chat"} disabled={!props.selectedProjectId} onClick={props.onCreateConversation}>＋ {!props.collapsed ? <span>{zh ? "新对话" : "New chat"}</span> : null}</button>
    <div className="project-sidebar__workspace-heading"><h2>{zh ? "工作区" : "Workspace"}</h2><div>{opening ? <span className="project-sidebar__opening" role="status">{zh ? "正在打开…" : "Opening…"}</span> : null}<button type="button" data-tooltip={zh ? "重启工作区" : "Restart workspace"} data-tooltip-side="bottom" aria-label={zh ? "重启工作区" : "Restart workspace"} aria-busy={restarting} disabled={restarting} onClick={() => { setRestarting(true); void props.onRestartWorkspace().finally(() => setRestarting(false)); }}>{restarting ? <span className="project-sidebar__spinner" aria-hidden="true" /> : <RestartIcon />}</button><button type="button" data-tooltip={zh ? "搜索工作区" : "Search workspace"} data-tooltip-side="bottom" aria-label={zh ? "搜索工作区" : "Search workspace"} onClick={() => setSearchOpen((v) => !v)}><SearchIcon /></button><button type="button" data-tooltip={zh ? "新建项目" : "New project"} data-tooltip-side="bottom" aria-label={opening ? (zh ? "正在打开项目文件夹" : "Opening Project Folder") : (zh ? "打开项目文件夹" : "Open Project Folder")} aria-busy={opening} disabled={opening} onClick={() => { setOpening(true); void props.onOpenProject().finally(() => setOpening(false)); }}>{opening ? <span className="project-sidebar__spinner" aria-hidden="true" /> : <PlusIcon />}</button></div></div>
    {searchOpen ? <div className="project-sidebar__search"><input autoFocus aria-label={zh ? "搜索项目与对话" : "Search projects and conversations"} value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={zh ? "搜索项目与对话" : "Search projects and chats"}/>{query ? <button type="button" aria-label={zh ? "清除搜索" : "Clear search"} onClick={() => setQuery("")}>×</button> : null}</div> : null}
    <ul className="project-sidebar__project-list">{props.projects.map((project) => { const conversations = props.conversations.filter((item) => item.projectId === project.id && (!query || matches(item.title))); const expanded = Boolean(query) || !collapsedProjects.has(project.id); if (query && !matches(project.name) && !conversations.length) return null; return <li key={project.id} className="project-sidebar__project-item">
      <div className="project-sidebar__row"><button type="button" className="project-sidebar__project-button" data-active={props.selectedProjectId === project.id} aria-pressed={props.selectedProjectId === project.id} aria-expanded={expanded} onClick={() => { props.onSelectProject(project.id); setCollapsedProjects((current) => { const next = new Set(current); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next; }); }}><ProjectChevron /><span>{project.name}</span></button><button type="button" className="project-sidebar__more" aria-label={`${zh ? "管理项目" : "Manage project"} ${project.name}`} onClick={() => setMenu(menu === `p:${project.id}` ? null : `p:${project.id}`)}>•••</button>{menu === `p:${project.id}` ? <div className="project-sidebar__menu"><button type="button" onClick={() => { setRename({ kind: "project", id: project.id, value: project.name }); setMenu(null); }}>{zh ? "重命名项目" : "Rename project"}</button><button type="button" onClick={() => { void props.onArchiveProject?.(project.id); setMenu(null); }}>{zh ? "归档项目" : "Archive project"}</button></div> : null}</div>
      {expanded ? <ul className="project-sidebar__conversation-list">{conversations.map((conversation) => <li key={conversation.id}><div className="project-sidebar__row"><button type="button" className="project-sidebar__conversation-button" data-active={props.selectedConversationId === conversation.id} aria-pressed={props.selectedConversationId === conversation.id} onClick={() => props.onSelectConversation(conversation.id)}><span>{conversation.title}</span><span className="project-sidebar__badges">{props.unreadConversationIds?.has(conversation.id) ? <span className="project-sidebar__badge" aria-label={zh ? "未读" : "Unread"} /> : null}</span></button><button type="button" className="project-sidebar__more" aria-label={`${zh ? "管理会话" : "Manage conversation"} ${conversation.title}`} onClick={() => setMenu(menu === `c:${conversation.id}` ? null : `c:${conversation.id}`)}>•••</button>{menu === `c:${conversation.id}` ? <div className="project-sidebar__menu"><button type="button" onClick={() => { setRename({ kind: "conversation", id: conversation.id, value: conversation.title }); setMenu(null); }}>{zh ? "重命名" : "Rename"}</button><button type="button" onClick={() => { void props.onForkConversation?.(conversation.id); setMenu(null); }}>{zh ? "分叉会话" : "Branch conversation"}</button><button type="button" onClick={() => { void props.onArchiveConversation?.(conversation.id); setMenu(null); }}>{zh ? "归档会话" : "Archive conversation"}</button></div> : null}</div></li>)}</ul> : null}
    </li>; })}</ul>
    <div className="project-sidebar__footer"><button type="button" aria-label={zh ? "设置" : "Settings"} onClick={props.onOpenSettings}><SettingsIcon />{!props.collapsed ? <span>{zh ? "设置" : "Settings"}</span> : null}</button></div>
    {rename ? <div className="client-dialog"><button type="button" className="client-dialog__backdrop" aria-label={zh ? "取消重命名" : "Cancel rename"} onPointerDown={() => setRename(null)}/><form className="client-dialog__panel" role="dialog" aria-modal="true" aria-label={rename.kind === "project" ? (zh ? "重命名项目" : "Rename project") : (zh ? "重命名会话" : "Rename conversation")} onSubmit={(event) => { event.preventDefault(); const value = rename.value.trim(); if (!value) return; const action = rename.kind === "project" ? props.onRenameProject?.(rename.id, value) : props.onRenameConversation?.(rename.id, value); setRename(null); void action; }}><h2>{rename.kind === "project" ? (zh ? "重命名项目" : "Rename project") : (zh ? "重命名会话" : "Rename conversation")}</h2><input autoFocus value={rename.value} onChange={(event) => setRename({ ...rename, value: event.currentTarget.value })}/><div><button type="button" onClick={() => setRename(null)}>{zh ? "取消" : "Cancel"}</button><button type="submit">{zh ? "保存" : "Save"}</button></div></form></div> : null}
  </nav>;
}

function SearchIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="4.5"/><path d="m12 12 4 4"/></svg>; }
function PlusIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>; }
function RestartIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.4 7.2A6 6 0 1 0 16 11"/><path d="M15.5 3.8v3.8h-3.8"/></svg>; }
function ProjectChevron() { return <svg className="project-sidebar__chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg>; }
function SettingsIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4"/></svg>; }
