import { useMemo, useState } from "react";
import Markdown from "markdown-to-jsx";
import type { GraphNode, GraphNodeRun, GraphPort, GraphRunEvent, GraphValues } from "../../shared/contracts.js";

interface GraphTrajectoryProps {
  language: "zh" | "en";
  nodes: GraphNode[];
  nodeRuns: GraphNodeRun[];
  events: GraphRunEvent[];
}

interface GraphStep { run: GraphNodeRun; node: GraphNode | null; activities: GraphActivity[]; }
interface GraphActivity { id: string; kind: "reasoning" | "tool" | "warning" | "error"; label: string; content: string; }

export function GraphTrajectory({ language, nodes, nodeRuns, events }: GraphTrajectoryProps) {
  const zh = language === "zh";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const steps = useMemo(() => projectGraphSteps(nodes, nodeRuns, events), [nodes, nodeRuns, events]);
  const selected = steps.find((step) => step.run.id === selectedId) ?? null;
  const agents = steps.filter((step) => step.node?.type === "agent").length;
  const loops = steps.filter((step) => step.node?.type === "loop_counter").length;
  return <section className="graph-trajectory" aria-label={zh ? "图运行轨迹" : "Graph trajectory"}>
    <header><div className="graph-trajectory__metrics"><span><strong>{steps.length}</strong> {zh ? "个步骤" : "steps"}</span><span><strong>{agents}</strong> {zh ? "次 Agent 执行" : `Agent run${agents === 1 ? "" : "s"}`}</span><span><strong>{loops}</strong> {zh ? "次 Loop 判断" : `Loop decision${loops === 1 ? "" : "s"}`}</span></div></header>
    <div className="graph-trajectory__timeline" aria-label={zh ? "节点执行顺序" : "Node execution order"}>{steps.map((step, index) => <button type="button" key={step.run.id} data-kind={step.node?.type ?? "unknown"} data-status={step.run.status} aria-label={`${step.node?.name ?? (zh ? "未知节点" : "Unknown node")} · ${statusLabel(step.run.status, zh)}`} aria-pressed={selected?.run.id === step.run.id} onClick={() => setSelectedId(step.run.id)}><span>{index + 1}</span><small>{shortNodeName(step.node, zh)}</small></button>)}</div>
    <div className="graph-trajectory__body"><ol className="graph-trajectory__steps">{steps.map((step, index) => <li key={step.run.id}><button type="button" aria-pressed={selected?.run.id === step.run.id} onClick={() => setSelectedId(step.run.id)}><span className="graph-trajectory__rail" data-kind={step.node?.type ?? "unknown"}/><span className="graph-trajectory__order">{index + 1}</span><span className="graph-trajectory__kind" data-kind={step.node?.type ?? "unknown"}>{nodeKind(step.node, zh)}</span><span className="graph-trajectory__name">{step.node?.name ?? (zh ? "未知节点" : "Unknown node")}{step.run.iteration > 1 ? <small className="graph-trajectory__iteration">#{step.run.iteration}</small> : null}</span><span className="graph-trajectory__result">{stepSummary(step, zh)}</span><span className="graph-status" data-status={step.run.status}>{statusLabel(step.run.status, zh)}</span></button></li>)}</ol>{selected ? <aside className="graph-trajectory__details" aria-label={zh ? "节点步骤详情" : "Node step details"}><header><div><span className="graph-trajectory__kind" data-kind={selected.node?.type ?? "unknown"}>{nodeKind(selected.node, zh)}</span><strong>{selected.node?.name}</strong>{selected.run.iteration > 1 ? <small className="graph-trajectory__iteration">#{selected.run.iteration}</small> : null}</div><button type="button" aria-label={zh ? "关闭步骤详情" : "Close step details"} onClick={() => setSelectedId(null)}>×</button></header><div>{selected.node?.type === "agent" ? <><Values title={zh ? "输入" : "Input"} values={selected.run.inputValues ?? { input: selected.run.input }} labels={selected.node.config.inputs} /><Values title={zh ? "输出" : "Output"} values={selected.run.outputValues ?? (selected.run.output ? { output: selected.run.output } : {})} labels={selected.node.config.outputs} /></> : <Values title={zh ? "内容" : "Content"} values={selected.run.outputValues ?? selected.run.inputValues ?? contentValue(selected.run)} labels={contentPorts(selected.node)} compact />}{selected.run.error ? <section className="graph-trajectory__error"><h4>{zh ? "错误" : "Error"}</h4><p>{selected.run.error.message}</p></section> : null}{selected.activities.length ? <section className="graph-trajectory__activity"><h4>{zh ? "执行活动" : "Activity"}</h4>{selected.activities.map((activity) => <div key={activity.id} data-kind={activity.kind}><span>{activity.label}</span><Markdown options={{ disableParsingRawHTML: true }}>{activity.content}</Markdown></div>)}</section> : null}</div></aside> : null}</div>
  </section>;
}

function projectGraphSteps(nodes: GraphNode[], nodeRuns: GraphNodeRun[], events: GraphRunEvent[]): GraphStep[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sorted = [...nodeRuns].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
  return sorted.map((run, index) => {
    const nextStart = sorted[index + 1] ? Date.parse(sorted[index + 1]!.createdAt) : Number.POSITIVE_INFINITY;
    const start = orderedEvents.findIndex((event) => event.type === "node_started" && event.nodeId === run.nodeId && event.payload.iteration === run.iteration);
    const end = start < 0 ? -1 : orderedEvents.findIndex((event, eventIndex) => eventIndex > start && event.nodeId === run.nodeId && ["node_completed", "node_failed"].includes(event.type) && event.payload.iteration === run.iteration);
    const stepEvents = start >= 0 ? orderedEvents.slice(start + 1, end < 0 ? undefined : end) : orderedEvents.filter((event) => event.nodeId === run.nodeId && Date.parse(event.createdAt) >= Date.parse(run.createdAt) && Date.parse(event.createdAt) < nextStart);
    const activities = stepEvents.flatMap(toActivity);
    return { run, node: byId.get(run.nodeId) ?? null, activities };
  });
}
function toActivity(event: GraphRunEvent): GraphActivity[] {
  const type = event.type.replace(/^agent_/, "");
  const content = errorMessage(event.payload.error) ?? textValue(event.payload.summary) ?? textValue(event.payload.message) ?? textValue(event.payload.command) ?? textValue(event.payload.path) ?? textValue(event.payload.request) ?? textValue(event.payload.aggregated_output) ?? textValue(event.payload.output) ?? textValue(event.payload.result) ?? textValue(event.payload.line) ?? textValue(event.payload.event);
  if (!content) return [];
  if (event.payload.error !== undefined || event.payload.status === "failed") return [{ id: event.id, kind: "error", label: "Error", content }];
  if (type === "reasoning") return [{ id: event.id, kind: "reasoning", label: "Reasoning", content }];
  if (["tool", "shell", "file"].includes(type)) return [{ id: event.id, kind: "tool", label: type === "tool" ? textValue(event.payload.name) ?? "Tool" : type[0]!.toUpperCase() + type.slice(1), content }];
  if (type === "warning") return [{ id: event.id, kind: "warning", label: "Warning", content }];
  return [];
}
function stepSummary(step: GraphStep, zh: boolean): string {
  if (step.run.error) return step.run.error.message;
  if (step.node?.type === "loop_counter") {
    const branch = Object.keys(step.run.outputValues ?? {})[0];
    return branch === "done" ? (zh ? "结束循环" : "Exit Loop") : branch === "loop" ? (zh ? "继续循环" : "Continue Loop") : statusLabel(step.run.status, zh);
  }
  const values = step.run.outputValues ?? (step.run.output ? { output: step.run.output } : {});
  return Object.values(values).find(Boolean)?.slice(0, 100) ?? statusLabel(step.run.status, zh);
}
function nodeKind(node: GraphNode | null, zh: boolean): string { if (!node) return zh ? "未知" : "Unknown"; if (node.type === "input") return "Input"; if (node.type === "output") return "Output"; if (node.type === "loop_counter") return "Loop"; return "Agent"; }
function shortNodeName(node: GraphNode | null, zh: boolean): string { return node ? nodeKind(node, zh) : "?"; }
function statusLabel(status: string, zh: boolean): string { const labels: Record<string, [string, string]> = { running: ["运行中", "Running"], completed: ["已完成", "Completed"], failed: ["失败", "Failed"], cancelled: ["已取消", "Cancelled"] }; return labels[status]?.[zh ? 0 : 1] ?? status; }
function contentValue(run: GraphNodeRun): GraphValues { return run.output !== null ? { content: run.output } : { content: run.input }; }
function contentPorts(node: GraphNode | null): GraphPort[] { return node?.type === "input" || node?.type === "output" ? node.config.fields : []; }
function Values({ title, values, labels = [], compact = false }: { title: string; values: GraphValues; labels?: GraphPort[]; compact?: boolean }) { const entries = Object.entries(values); return <section className="graph-values"><h4>{title}</h4>{entries.length ? entries.map(([key, value]) => <div key={key}>{!compact || entries.length > 1 ? <strong>{labels.find((port) => port.id === key)?.name ?? key}</strong> : null}<Markdown options={{ disableParsingRawHTML: true }}>{value}</Markdown></div>) : <p>—</p>}</section>; }
function textValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function errorMessage(value: unknown): string | null { return value && typeof value === "object" ? textValue((value as Record<string, unknown>).message) : textValue(value); }
