import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "markdown-to-jsx";
import type { AgentProductId, NormalizedEvent, PermissionMode } from "../../shared/contracts.js";
import type { AgentSettingsView, ConversationView } from "../api.js";
import { Composer } from "./composer.js";
import { AgentBadge } from "./agent-badge.js";

interface ConversationCanvasProps {
  conversation: ConversationView | null;
  newConversation?: NewConversationDraft | null;
  availableAgents?: AgentSettingsView[];
  onChangeAgent?(agentProductId: AgentProductId): void;
  onChangeModel(modelId: string | null): void;
  onChangePermissionMode(permissionMode: PermissionMode): void;
  onDeletePendingMessage(messageId: string): Promise<void>;
  onResolveUncertainMessage?(messageId: string, action: "retry" | "accept"): Promise<void>;
  onQueueMessage(content: string): Promise<void>;
  onCancelTurn(): Promise<void>;
  onContinueConversation(): Promise<void>;
  onRetryInterruptedTurn(turnId: string): Promise<void>;
  onRespondToPermission?(requestId: string, decision: "allow_once" | "deny_once"): Promise<void>;
  onForkConversation?(): Promise<void>;
  language?: "zh" | "en";
  showHeader?: boolean;
}

export interface NewConversationDraft {
  projectId: string;
  agentProductId: AgentProductId;
  agentProductLabel: string;
  modelId: string | null;
  permissionMode: PermissionMode;
  availableModels: string[];
  availablePermissionModes: PermissionMode[];
}

export function ConversationCanvas(props: ConversationCanvasProps) {
  const [openSelector, setOpenSelector] = useState<"agent" | "model" | "permission" | null>(null);
  const selectorRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousTurn = useRef<{ conversationId: string | null; active: boolean }>({ conversationId: null, active: false });
  const [timelineOpen, setTimelineOpen] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const zh = props.language === "zh";
  const conversation = props.conversation;
  const draft = props.newConversation ?? null;
  const session = conversation ?? draft;
  const turnActive = Boolean(conversation?.activeTurnStatus);
  const [submitting, setSubmitting] = useState(false);
  const [branchingEventId, setBranchingEventId] = useState<string | null>(null);
  const [respondingPermissionId, setRespondingPermissionId] = useState<string | null>(null);
  useEffect(() => { if (turnActive) setOpenSelector(null); }, [turnActive]);
  useEffect(() => {
    const current = { conversationId: conversation?.id ?? null, active: turnActive };
    const scroll = scrollRef.current;
    if (scroll && current.conversationId !== previousTurn.current.conversationId) {
      scroll.scrollTo?.({ top: scroll.scrollHeight, behavior: "auto" });
    } else if (scroll && previousTurn.current.active && !current.active) {
      const userMessages = scroll.querySelectorAll<HTMLElement>('[data-message-role="user"]');
      const lastUserMessage = userMessages.item(userMessages.length - 1);
      if (lastUserMessage?.scrollIntoView) lastUserMessage.scrollIntoView({ behavior: "smooth", block: "start" });
      else scroll.scrollTo?.({ top: scroll.scrollHeight, behavior: "smooth" });
    }
    previousTurn.current = current;
  }, [conversation?.id, turnActive]);
  useEffect(() => {
    if (!openSelector) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".composer-selectors")) setOpenSelector(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [openSelector]);

  const flow = useMemo(() => conversation ? buildFlow(
    conversation.events.filter((event) => event.type !== "user_message" || !conversation.queuedMessages.some((message) => message.id === event.payload.messageId)),
  ) : [], [conversation]);
  const approvals = useMemo(() => conversation ? pendingPermissions(conversation.events) : [], [conversation]);
  const sendBlocked = turnActive;
  const draftUnavailable = Boolean(draft && !(props.availableAgents ?? []).some(isRunnableAgent));
  if (!session) {
    return <section className="conversation-canvas" data-testid="conversation-canvas" aria-label="Conversation Canvas"><div className="workspace-empty">{zh ? "新建一个对话以开始。" : "Create a conversation to start."}</div></section>;
  }

  const recoveryStatus = conversation?.latestTurnStatus ?? null;
  const recoveryRequired = Boolean(conversation?.queuePaused && recoveryStatus !== null && ["start_failed", "failed", "interrupted", "cancel_failed"].includes(recoveryStatus));
  const leadingControls = (
    <div className="composer-selectors composer-selectors--leading" ref={selectorRef}>
      <button type="button" className="composer__attach" disabled title={zh ? "当前版本暂不支持附件" : "Attachments are not supported in this version"} aria-label={zh ? "添加附件（当前版本暂不支持）" : "Add attachment (not supported in this version)"}>+</button>
      <div className="permission-selector">
        <button type="button" aria-label="Permission mode" aria-haspopup="menu" aria-expanded={openSelector === "permission" && !turnActive} disabled={turnActive} onClick={() => setOpenSelector((value) => value === "permission" ? null : "permission")}><PermissionIcon /><span className="selector-value">{permissionLabel(session.permissionMode, zh)}</span><SelectorChevron /></button>
        {openSelector === "permission" && !turnActive ? <div role="menu" className="composer-popover">{session.availablePermissionModes.map((mode) => <button key={mode} type="button" role="menuitemradio" aria-checked={session.permissionMode === mode} onClick={() => { props.onChangePermissionMode(mode); setOpenSelector(null); }}>{permissionLabel(mode, zh)}</button>)}</div> : null}
      </div>
    </div>
  );
  const trailingControls = (
    <div className="composer-selectors composer-selectors--trailing">
      <div className="agent-selector">
        <button type="button" aria-label="Agent" aria-haspopup={draft ? "menu" : undefined} aria-expanded={draft ? openSelector === "agent" : undefined} disabled={!draft || turnActive} onClick={() => setOpenSelector((value) => value === "agent" ? null : "agent")}><span className="selector-value">{session.agentProductLabel}</span><SelectorChevron /></button>
        {openSelector === "agent" ? <div role="menu" className="composer-popover">{(props.availableAgents ?? []).filter(isRunnableAgent).map((agent) => <button key={agent.id} type="button" role="menuitemradio" aria-checked={draft?.agentProductId === agent.id} onClick={() => { props.onChangeAgent?.(agent.id); setOpenSelector(null); }}>{agent.name}</button>)}</div> : null}
      </div>
      <div className="composer-selector">
        <button type="button" aria-label="Model" aria-haspopup="menu" aria-expanded={openSelector === "model" && !turnActive} disabled={turnActive} onClick={() => setOpenSelector((value) => value === "model" ? null : "model")}><span className="selector-value">{session.modelId ?? (zh ? "默认模型" : "Default model")}</span><SelectorChevron /></button>
        {openSelector === "model" && !turnActive ? <div role="menu" className="composer-popover">{session.availableModels.map((model) => <button key={model} type="button" role="menuitemradio" aria-checked={session.modelId === model} onClick={() => { props.onChangeModel(model); setOpenSelector(null); }}>{model}</button>)}</div> : null}
      </div>
    </div>
  );

  return (
    <section className="conversation-canvas" data-testid="conversation-canvas" aria-label="Conversation Canvas">
      {props.showHeader !== false ? <header className="conversation-canvas__header"><h2>{conversation?.title ?? (zh ? "新对话" : "New conversation")}</h2><AgentBadge className="conversation-canvas__agent" agent={session.agentProductId}/></header> : null}
      <div className="conversation-canvas__scroll" ref={scrollRef}>
        {recoveryRequired && conversation?.latestTurnId ? <section className="conversation-canvas__recovery"><p>{zh ? `上一个 Turn 以 ${recoveryStatus} 结束。继续前请确认本地 Agent 已停止工作。` : `The last Turn ended with ${recoveryStatus}. Confirm native work is inactive before continuing.`}</p><div><button type="button" onClick={props.onContinueConversation}>{zh ? "继续发送" : "Continue sending"}</button>{recoveryStatus === "interrupted" ? <button type="button" onClick={() => props.onRetryInterruptedTurn(conversation.latestTurnId!)}>{zh ? "重试中断的 Turn" : "Retry interrupted Turn"}</button> : null}</div></section> : null}
        <div className="conversation-canvas__messages">
          {flow.map((item) => item.kind === "message" ? (
            <article key={item.event.id} data-message-role={item.event.type === "user_message" ? "user" : "assistant"} className={`conversation-message conversation-message--${item.event.type === "user_message" ? "user" : "assistant"}`}>
              <div className="conversation-message__body"><Markdown options={{ disableParsingRawHTML: true }}>{readString(item.event.payload, "text") ?? ""}</Markdown></div>
              {item.event.type === "assistant_message" ? <div className="conversation-message__actions"><button type="button" aria-label={zh ? "复制输出" : "Copy output"} onClick={() => void navigator.clipboard?.writeText(readString(item.event.payload, "text") ?? "")}><CopyIcon /></button>{props.onForkConversation ? <><button type="button" aria-label={zh ? "新对话分支" : "Branch conversation"} aria-busy={branchingEventId === item.event.id} disabled={branchingEventId !== null} onClick={() => { setBranchingEventId(item.event.id); void props.onForkConversation?.().finally(() => setBranchingEventId(null)); }}><BranchIcon /></button>{branchingEventId === item.event.id ? <span className="conversation-message__progress" role="status">{zh ? "正在创建分支…" : "Creating branch…"}</span> : null}</> : null}</div> : null}
            </article>
          ) : item.kind === "trajectory" ? (
            <section key={item.id} className="conversation-trajectory" data-open={Boolean(timelineOpen[item.id])}>
              <button type="button" className="conversation-trajectory__toggle" aria-label={(timelineOpen[item.id] ? (zh ? "收起执行轨迹" : "Collapse activity") : (zh ? "展开执行轨迹" : "Expand activity"))} onClick={() => setTimelineOpen((current) => ({ ...current, [item.id]: !current[item.id] }))}><span>⌁</span><strong>{zh ? "执行轨迹" : "Activity"}</strong><span className="conversation-trajectory__state">{zh ? `${item.events.length} 个步骤` : `${item.events.length} steps`}</span><span className="conversation-trajectory__chevron"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg></span></button>
              {timelineOpen[item.id] ? <ul>{item.events.map((event) => <li key={event.id} data-severity={eventSeverity(event)}><span className="conversation-canvas__event-dot"/><code>{eventLabel(event.type, zh)}</code><div className="conversation-trajectory__detail"><Markdown options={{ disableParsingRawHTML: true }}>{describeEvent(event, zh)}</Markdown></div></li>)}</ul> : null}
            </section>
          ) : <div key={item.event.id} className="conversation-turn-footer"><span>{turnStatusLabel(item.event, zh)}</span>{turnError(item.event) ? <strong>{turnError(item.event)}</strong> : null}<time dateTime={item.event.createdAt}>{formatEventTime(item.event.createdAt, props.language)}</time></div>)}
          {approvals.map((event) => {
            const requestId = readString(event.payload, "requestId");
            if (!requestId || !props.onRespondToPermission) return null;
            const responding = respondingPermissionId === requestId;
            const respond = async (decision: "allow_once" | "deny_once") => {
              setRespondingPermissionId(requestId);
              try { await props.onRespondToPermission?.(requestId, decision); }
              finally { setRespondingPermissionId(null); }
            };
            return <section key={event.id} className="conversation-permission" aria-label={zh ? "审批请求" : "Approval request"}><div><strong>{zh ? "需要审批" : "Approval required"}</strong><span>{describeEvent(event, zh)}</span></div><div><button type="button" disabled={responding} onClick={() => void respond("deny_once")}>{zh ? "拒绝" : "Deny"}</button><button type="button" disabled={responding} className="conversation-permission__allow" onClick={() => void respond("allow_once")}>{zh ? "允许一次" : "Allow once"}</button></div></section>;
          })}
          {conversation?.activeTurnStatus || submitting ? <div className="conversation-running" role="status"><span className="conversation-running__dot" />{activeTurnLabel(conversation?.activeTurnStatus ?? "starting", zh)}</div> : null}
          {conversation?.queuedMessages.length ? <section className="conversation-canvas__pending"><h3>{zh ? "待发送消息" : "Unsent messages"}</h3><ul>{conversation.queuedMessages.map((message, index) => <li key={message.id} data-status={message.status ?? "pending"}><span>{message.content}</span>{message.status === "uncertain" ? <div className="conversation-canvas__pending-recovery"><strong>{zh ? "投递结果待确认" : "Delivery needs confirmation"}</strong><button type="button" onClick={() => void props.onResolveUncertainMessage?.(message.id, "accept")}>{zh ? "确认已接收" : "Mark received"}</button><button type="button" onClick={() => void props.onResolveUncertainMessage?.(message.id, "retry")}>{zh ? "重新发送" : "Send again"}</button></div> : message.status === "staged" ? <strong>{zh ? "正在投递" : "Delivering"}</strong> : <button type="button" aria-label={`Delete pending message ${index + 1}: ${message.content}`} onClick={() => void props.onDeletePendingMessage(message.id).catch(() => undefined)}>{zh ? "删除" : "Delete"}</button>}</li>)}</ul></section> : null}
        </div>
        <button type="button" className="conversation-canvas__scroll-bottom" aria-label={zh ? "滑到底部" : "Scroll to bottom"} onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })}>↓</button>
        <div className="conversation-canvas__composer-seat">
          <Composer
            disabled={draftUnavailable || sendBlocked}
            language={props.language}
            leadingControls={leadingControls}
            trailingControls={trailingControls}
            stopControl={turnActive ? <button type="button" className="composer__stop" onClick={props.onCancelTurn}>{zh ? "停止" : "Stop"}</button> : null}
            value={drafts[conversation?.id ?? `new:${draft!.projectId}`] ?? ""}
            onChange={(value) => { const id = conversation?.id ?? `new:${draft!.projectId}`; setDrafts((current) => ({ ...current, [id]: value })); }}
            onSubmit={async (content) => { const id = conversation?.id ?? `new:${draft!.projectId}`; const value = drafts[id] ?? ""; setSubmitting(true); try { await props.onQueueMessage(content); setDrafts((current) => current[id] === value ? { ...current, [id]: "" } : current); } finally { setSubmitting(false); } }}
          />
        </div>
      </div>
    </section>
  );
}
function isRunnableAgent(agent: AgentSettingsView): boolean { return agent.enabled !== false && (agent.status === "available" || agent.status === "capability_limited"); }
function SelectorChevron() { return <span className="selector-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m4.25 9.5 3.75-4 3.75 4" /></svg></span>; }
function PermissionIcon() { return <span className="permission-selector__icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 2.25 12.5 4v3.45c0 2.75-1.7 4.9-4.5 6.3-2.8-1.4-4.5-3.55-4.5-6.3V4L8 2.25Z"/><path d="m6.1 7.8 1.2 1.2 2.7-2.75"/></svg></span>; }

type FlowItem = { kind: "message"; event: NormalizedEvent } | { kind: "trajectory"; id: string; events: NormalizedEvent[] } | { kind: "footer"; event: NormalizedEvent };
function buildFlow(events: NormalizedEvent[]): FlowItem[] {
  const flow: FlowItem[] = []; let activity: NormalizedEvent[] = [];
  const flush = () => { if (activity.length) { const merged = mergeActivityEvents(activity); flow.push({ kind: "trajectory", id: `activity-${activity[0]!.id}`, events: merged }); activity = []; } };
  for (const event of events) {
    if (event.type === "user_message") { flush(); flow.push({ kind: "message", event }); }
    else if (event.type === "assistant_message") { flush(); flow.push({ kind: "message", event }); }
    else if (event.type === "turn_status" && isTerminalStatus(event.payload.status)) { flush(); flow.push({ kind: "footer", event }); }
    else if (event.type !== "turn_status" && event.type !== "queue_status" && !(event.type === "permission" && readString(event.payload, "requestId"))) activity.push(event);
  }
  flush(); return flow;
}
function pendingPermissions(events: NormalizedEvent[]): NormalizedEvent[] {
  const pending = new Map<string, NormalizedEvent>();
  for (const event of events) {
    if (event.type === "turn_status" && isTerminalStatus(event.payload.status)) { pending.clear(); continue; }
    if (event.type !== "permission") continue;
    const requestId = readString(event.payload, "requestId");
    if (!requestId) continue;
    if (event.payload.status === "resolved") pending.delete(requestId);
    else pending.set(requestId, event);
  }
  return [...pending.values()];
}
function mergeActivityEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  const merged: NormalizedEvent[] = [];
  const tools = new Map<string, number>();
  for (const event of events) {
    const toolId = event.type === "tool" ? readString(event.payload, "id") : null;
    const index = toolId ? tools.get(toolId) : undefined;
    if (toolId && index !== undefined) {
      const first = merged[index]!;
      merged[index] = { ...first, payload: { ...first.payload, ...event.payload } };
    } else {
      if (toolId) tools.set(toolId, merged.length);
      merged.push(event);
    }
  }
  return merged;
}
export function formatEventTime(value: string, language: "zh" | "en" = "en"): string {
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));
}
function permissionLabel(mode: PermissionMode, zh: boolean): string {
  if (mode === "request_approval") return zh ? "需要审批" : "Ask for approval";
  if (mode === "help_me_approve") return zh ? "自动审批" : "Auto approve";
  return zh ? "完全访问" : "Full access";
}
function eventSeverity(event: NormalizedEvent): "normal" | "success" | "warning" | "error" {
  if (event.type === "warning") return "warning";
  if (event.type === "turn_status" && ["failed", "start_failed", "cancel_failed"].includes(String(event.payload.status))) return "error";
  if (event.type === "turn_status" && event.payload.status === "completed") return "success";
  return "normal";
}
function eventLabel(type: NormalizedEvent["type"], zh: boolean): string {
  const labels: Record<NormalizedEvent["type"], [string, string]> = { assistant_message:["助手消息","Assistant"], user_message:["用户消息","User"], reasoning:["思考","Reasoning"], tool:["工具","Tool"], shell:["终端","Shell"], file:["文件","File"], permission:["审批","Approval"], usage:["用量","Usage"], warning:["警告","Warning"], queue_status:["排队","Queue"], turn_status:["状态","Status"] };
  return labels[type][zh ? 0 : 1];
}
function describeEvent(event: NormalizedEvent, zh: boolean): string {
  if (event.type === "reasoning" || event.type === "usage") return readString(event.payload, "summary") ?? eventLabel(event.type, zh);
  if (event.type === "tool") return summarizePayload(event.payload, ["name", "input", "status", "result"], eventLabel(event.type, zh));
  if (event.type === "shell") return summarizePayload(event.payload, ["command", "status", "exit_code", "output"], eventLabel(event.type, zh));
  if (event.type === "file") return summarizePayload(event.payload, ["path", "status", "changes", "type"], eventLabel(event.type, zh));
  if (event.type === "permission") return readString(event.payload, "request") ?? eventLabel(event.type, zh);
  if (event.type === "warning") return readString(event.payload, "message") ?? eventLabel(event.type, zh);
  if (event.type === "turn_status") return `${readString(event.payload, "status") ?? "unknown"}${readErrorMessage(event.payload) ? `: ${readErrorMessage(event.payload)}` : ""}`;
  return readString(event.payload, "text") ?? eventLabel(event.type, zh);
}
function summarizePayload(payload: Record<string, unknown>, keys: string[], fallback: string): string {
  const values = keys.flatMap((key) => payload[key] === undefined || payload[key] === null ? [] : [`${key === keys[0] ? "" : `${key}: `}${formatPayloadValue(payload[key])}`]);
  return values.join(" · ") || fallback;
}
function formatPayloadValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 497)}…` : text;
}
function isTerminalStatus(status: unknown): boolean { return typeof status === "string" && ["completed", "cancelled", "start_failed", "failed", "interrupted", "cancel_failed"].includes(status); }
function turnStatusLabel(event: NormalizedEvent, zh: boolean): string {
  const status = readString(event.payload, "status") ?? "completed";
  if (status === "completed") return zh ? "已完成" : "Completed";
  if (status === "cancelled") return zh ? "已停止" : "Stopped";
  return `${zh ? "结束" : "Ended"}: ${status}`;
}
function turnError(event: NormalizedEvent): string | null { return readErrorMessage(event.payload); }
function activeTurnLabel(status: NonNullable<ConversationView["activeTurnStatus"]>, zh: boolean): string {
  if (status === "starting") return zh ? "正在连接…" : "Connecting…";
  if (status === "cancelling") return zh ? "正在停止…" : "Stopping…";
  return zh ? "正在分析…" : "Analyzing…";
}
function CopyIcon() { return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.25" y="5.25" width="8" height="8" rx="1.5"/><path d="M10.75 5.25V4.5A1.75 1.75 0 0 0 9 2.75H4.5A1.75 1.75 0 0 0 2.75 4.5V9A1.75 1.75 0 0 0 4.5 10.75h.75"/></svg>; }
function BranchIcon() { return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.5"/><circle cx="12" cy="5.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><path d="M4 5v6M5.5 8.8C8 8.8 8 5.5 10.5 5.5"/></svg>; }
function readString(payload: Record<string, unknown>, key: string): string | null { const value = payload[key]; return typeof value === "string" && value ? value : null; }
function readErrorMessage(payload: Record<string, unknown>): string | null { const error = payload.error; return error && typeof error === "object" ? readString(error as Record<string, unknown>, "message") : null; }
