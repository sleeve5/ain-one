import { useMemo, useState } from "react";
import type { ArchivedWorkspaceState } from "../api.js";

interface Props {
  state: ArchivedWorkspaceState; language: "zh" | "en";
  onRestoreProject(id: string): Promise<void>; onRestoreConversation(id: string): Promise<void>; onRestoreGraph?(id: string): Promise<void>;
  onDeleteConversation(id: string): Promise<void>; onDeleteGraph?(id: string): Promise<void>; onDeleteProject?(id: string): Promise<void>;
}
type DeleteTarget = { type: "conversation" | "graph" | "project"; id: string; title: string };

export function ArchivedSettings(props: Props) {
  const zh = props.language === "zh";
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  const groups = useMemo(() => archivedGroups(props.state), [props.state]);
  const projectDelete = pendingDelete?.type === "project";
  return <section className="archived-settings"><h1>{zh ? "已归档" : "Archived"}</h1><p>{zh ? "可恢复归档内容；删除只清理 Ain One 记录，不会删除本地文件。" : "Restore archived items or remove their Ain One records. Local files are never deleted."}</p><div className="archived-settings__projects">{groups.length ? groups.map((group) => <section className="archived-settings__project" role="group" aria-label={group.name} key={group.id}><header><strong>{group.name}</strong>{group.archived ? <div className="archived-settings__actions"><button type="button" onClick={() => void props.onRestoreProject(group.id)}>{zh ? "恢复项目" : "Restore Project"}</button><button type="button" className="archived-settings__delete" aria-label={zh ? `从 Ain One 删除 ${group.name}` : `Delete ${group.name} from Ain One`} onClick={() => setPendingDelete({ type: "project", id: group.id, title: group.name })}>{zh ? "删除项目" : "Delete Project"}</button></div> : null}</header><div className="archived-settings__resources">{group.resources.map((resource) => <div className="archived-settings__item" key={`${resource.type}:${resource.id}`}><span className="project-sidebar__resource-kind" data-kind={resource.type === "conversation" ? "chat" : "graph"}>{resource.type === "conversation" ? "Chat" : "Graph"}</span><span className="archived-settings__title">{resource.title}</span>{resource.archived ? <div className="archived-settings__actions"><button type="button" onClick={() => void (resource.type === "graph" ? props.onRestoreGraph?.(resource.id) : props.onRestoreConversation(resource.id))}>{zh ? "恢复" : "Restore"}</button><button type="button" className="archived-settings__delete" aria-label={`${zh ? "永久删除" : "Delete"} ${resource.title}${zh ? "" : " permanently"}`} onClick={() => setPendingDelete({ type: resource.type, id: resource.id, title: resource.title })}>{zh ? "删除" : "Delete"}</button></div> : null}</div>)}</div></section>) : <div className="archived-settings__empty">{zh ? "暂无归档内容" : "No archived items"}</div>}</div>{pendingDelete ? <div className="archived-settings__confirm-layer"><button type="button" className="archived-settings__confirm-backdrop" aria-label={zh ? "取消删除" : "Cancel deletion"} onClick={() => setPendingDelete(null)}/><section className="archived-settings__confirm" role="dialog" aria-modal="true" aria-label={projectDelete ? (zh ? "删除归档项目" : "Delete archived project") : pendingDelete.type === "graph" ? (zh ? "删除归档图" : "Delete archived graph") : (zh ? "删除归档会话" : "Delete archived conversation")}><h2>{projectDelete ? (zh ? "从 Ain One 删除项目？" : "Delete project from Ain One?") : pendingDelete.type === "graph" ? (zh ? "永久删除 Graph？" : "Permanently delete Graph?") : (zh ? "永久删除 Chat？" : "Permanently delete Chat?")}</h2><p>{projectDelete ? (zh ? `将删除“${pendingDelete.title}”及其所有客户端资源，本地文件不会被删除。` : `This removes “${pendingDelete.title}” and all its client resources. Local files will not be deleted.`) : (zh ? `永久删除“${pendingDelete.title}”？此操作无法撤销。` : `Permanently delete “${pendingDelete.title}”? This cannot be undone.`)}</p><div><button type="button" onClick={() => setPendingDelete(null)}>{zh ? "取消" : "Cancel"}</button><button type="button" className="archived-settings__delete" aria-label={projectDelete ? (zh ? "确认删除项目" : "Confirm project deletion") : (zh ? "确认永久删除" : "Confirm permanent deletion")} onClick={() => { const target = pendingDelete; setPendingDelete(null); void (target.type === "project" ? props.onDeleteProject?.(target.id) : target.type === "graph" ? props.onDeleteGraph?.(target.id) : props.onDeleteConversation(target.id)); }}>{zh ? "删除" : "Delete"}</button></div></section></div> : null}</section>;
}

function archivedGroups(state: ArchivedWorkspaceState) {
  const archivedProjects = new Map(state.projects.map((project) => [project.id, project]));
  const ids = new Set([...archivedProjects.keys(), ...state.conversations.map((item) => item.projectId), ...(state.graphs ?? []).map((item) => item.projectId)]);
  return [...ids].map((id) => {
    const project = archivedProjects.get(id);
    const resources = [
      ...(state.graphs ?? []).filter((item) => item.projectId === id).map((item) => ({ type: "graph" as const, id: item.id, title: item.name, updatedAt: item.updatedAt, archived: Boolean(item.archivedAt) })),
      ...state.conversations.filter((item) => item.projectId === id).map((item) => ({ type: "conversation" as const, id: item.id, title: item.title ?? `Conversation ${item.id.slice(0, 8)}`, updatedAt: item.updatedAt, archived: Boolean(item.archivedAt) })),
    ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { id, name: project?.name ?? state.projectNames?.[id] ?? `Project ${id.slice(0, 8)}`, archived: Boolean(project), resources };
  }).sort((left, right) => left.name.localeCompare(right.name));
}
