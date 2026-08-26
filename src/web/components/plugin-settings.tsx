import { useState } from "react";
import type { AgentProductId, PluginVersion } from "../../shared/contracts.js";
import { isPhaseOneAgentProductId, type PluginMaterializationView } from "../api.js";
import { AgentBadge } from "./agent-badge.js";

export type PluginType = "skill" | "mcp"; export type PluginScope = "global" | "project" | "conversation";
export interface InstalledPluginVersion extends PluginVersion { type: PluginType; compatibleAgents: AgentProductId[]; materializations: PluginMaterializationView[]; }
interface Props { installedVersions: InstalledPluginVersion[]; error?: string | null; scope: PluginScope; conversationAgentProductId?: AgentProductId | null; enabledVersions: PluginVersion[]; enablementsLoading?: boolean; language?: "zh" | "en"; onInstallLocalPath(path:string,type:PluginType,agents:AgentProductId[]):void; onPickLocalPath(kind:"directory"|"file"):Promise<string|null>; onRefreshImports():void; onScopeChange(scope:PluginScope):void; onEnableChange(scope:PluginScope, change:PluginVersion & {enabled:boolean}):void; onRepairMaterialization(agent:AgentProductId,plugin:PluginVersion):void; }
const labels: Record<AgentProductId,string>={codex:"Codex",claude:"Claude Code",trae:"Trae CLI",opencode:"OpenCode"};
const agents: AgentProductId[]=["codex","claude","trae"];
export function PluginSettings(props: Props) {
  const [type,setType]=useState<PluginType>("skill"); const [query,setQuery]=useState(""); const zh=props.language==="zh";
  const installed=[...props.installedVersions].filter((v)=>v.type===type&&v.pluginId.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort(byName);
  const choose=async()=>{ const path=await props.onPickLocalPath(type==="skill"?"directory":"file"); if(path) props.onInstallLocalPath(path,type,type==="skill"?agents:[]); };
  return <section className="plugin-settings" aria-label="Plugin settings">
    <div className="plugin-settings__heading"><div><h1>{zh?"插件":"Plugins"}</h1><p>{zh?"已自动发现本机 Skills 与 MCP。开关决定它们是否在所选范围生效；只有添加其他位置时才需要选择文件。":"Installed Skills and MCP are automatically discovered. Use the switch for the selected scope; choose a file only to add another location."}</p></div><button type="button" onClick={props.onRefreshImports}>{zh?"自动导入":"Auto import"}</button></div>
    {props.error?<p role="alert">{zh?"插件清单不可用":"Plugin inventory unavailable"}: {props.error}</p>:null}
    <div className="plugin-settings__tabs" role="group" aria-label="Plugin types"><button type="button" data-active={type==="skill"} onClick={()=>setType("skill")}>Skills</button><button type="button" data-active={type==="mcp"} onClick={()=>setType("mcp")}>MCP</button></div>
    <div className="plugin-settings__toolbar"><label>{zh?"生效范围":"Apply to"}<select aria-label="Plugin scope" value={props.scope} onChange={(e)=>props.onScopeChange(e.currentTarget.value as PluginScope)}><option value="global">{zh?"所有项目":"All projects"}</option><option value="project">{zh?"当前项目":"Current project"}</option><option value="conversation">{zh?"当前对话":"Current conversation"}</option></select></label><input type="search" aria-label="Search plugins" placeholder={zh?"搜索插件":"Search plugins"} value={query} onChange={(event)=>setQuery(event.currentTarget.value)}/><button type="button" onClick={()=>void choose()}>{type==="skill"?(zh?"添加 Skill":"Add Skill"):(zh?"添加 MCP":"Add MCP")}</button></div>
    <PluginList title={zh?"可用插件":"Available plugins"} ariaLabel="Installed plugin versions" empty={zh?"没有匹配的插件":"No matching plugins"} rows={installed.map((v)=>{
      const enabled=props.enabledVersions.some((e)=>e.pluginId===v.pluginId&&e.versionId===v.versionId);
      const compatible=v.compatibleAgents.filter(isPhaseOneAgentProductId);
      const incompatible=!compatible.length||(props.scope==="conversation"&&props.conversationAgentProductId!=null&&!compatible.includes(props.conversationAgentProductId));
      return {key:`${v.pluginId}:${v.versionId}`,name:v.pluginId,kind:v.type==="skill"?"Skill":"MCP",version:short(v.versionId),action:<label className="plugin-settings__switch"><input type="checkbox" aria-label={`Enable ${v.pluginId} ${v.versionId}`} disabled={props.enablementsLoading||(!enabled&&incompatible)} checked={enabled} onChange={(e)=>props.onEnableChange(props.scope,{pluginId:v.pluginId,versionId:v.versionId,enabled:e.currentTarget.checked})}/><span aria-hidden="true"/></label>,agents:<>{compatible.map((agent)=>{const materialization=v.materializations.find((item)=>item.agentProductId===agent);return <span className="plugin-settings__agent" key={agent} title={materialization?statusText(materialization.status,zh):undefined}><AgentBadge agent={agent}/>{materialization?.repairable?<button type="button" aria-label={`Repair ${v.pluginId} ${v.versionId} for ${labels[agent]}`} onClick={()=>props.onRepairMaterialization(agent,v)}>{zh?"同步":"Sync"}</button>:null}</span>;})}</>};
    })}/>
  </section>;
}
function PluginList({title,ariaLabel,empty,rows}:{title:string;ariaLabel:string;empty:string;rows:Array<{key:string;name:string;kind:string;version:string;action:React.ReactNode;agents:React.ReactNode}>}) { return <section aria-label={ariaLabel} className="plugin-settings__section"><h2>{title}<span>{rows.length}</span></h2>{rows.length?<ul className="plugin-settings__list">{rows.map((row)=><li key={row.key}><div className="plugin-settings__card"><div className="plugin-settings__name"><span className="plugin-settings__kind">{row.kind}</span><strong>{row.name}</strong></div><span className="plugin-settings__version">{row.version}</span><div className="plugin-settings__agents">{row.agents}</div></div>{row.action}</li>)}</ul>:<p className="plugin-settings__empty">{empty}</p>}</section>; }
function byName<T extends PluginVersion>(a:T,b:T){return a.pluginId.localeCompare(b.pluginId)||a.versionId.localeCompare(b.versionId);}
function short(value:string){return value.length>12?`${value.slice(0,12)}…`:value;}
function statusText(status:PluginMaterializationView["status"],zh:boolean){if(status==="materialized")return zh?"可用":"Ready";if(status==="not_materialized")return zh?"待同步":"Needs sync";if(status==="turn_scoped")return zh?"按对话使用":"Per turn";return zh?"冲突":"Conflict";}
