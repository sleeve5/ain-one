import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { addEdge, applyNodeChanges, Background, Controls, MarkerType, ReactFlow, type Connection, type Edge, type Node, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphDefinition, GraphNode, GraphNodeRun, GraphProject, GraphRun, GraphRunEvent } from "../../shared/contracts.js";
import { validateGraphDefinition } from "../../shared/validation.js";
import type { AinOneApi, AgentSettingsView } from "../api.js";
import { GraphNodeView, type GraphNodeData } from "./graph-node.js";
import { agentLabel, sortAgents } from "../agent-meta.js";

interface GraphCanvasProps { language?: "zh" | "en"; api?: AinOneApi; projectId?: string | null; agents?: AgentSettingsView[]; active?: boolean; }
const nodeTypes = { workflow: GraphNodeView };

export function GraphCanvas({ language = "en", api, projectId = null, agents = [], active = true }: GraphCanvasProps) {
  const zh = language === "zh";
  const [graphs, setGraphs] = useState<GraphProject[]>([]);
  const [graph, setGraph] = useState<GraphProject | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [run, setRun] = useState<GraphRun | null>(null);
  const [nodeRuns, setNodeRuns] = useState<GraphNodeRun[]>([]);
  const [runEvents, setRunEvents] = useState<GraphRunEvent[]>([]);
  const [runInput, setRunInput] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const flow = useRef<ReactFlowInstance<Node<GraphNodeData>, Edge> | null>(null);
  const measurements = useRef(new Map<string, { width: number; height: number }>());
  const fitAfterMeasurement = useRef(false);

  useEffect(() => {
    let mounted = true;
    if (!active) return;
    setRun(null); setNodeRuns([]); setRunEvents([]); setResult(null); setSelectedNodeId(null);
    if (!api || !projectId || !api.listGraphs || !api.createGraph) { setGraphs([]); setGraph(null); return; }
    void api.listGraphs(projectId).then(async (items) => {
      if (!mounted) return;
      const selected = items[0] ?? await api.createGraph!(projectId, defaultGraph(agents));
      if (!mounted) return;
      const detail = await api.getGraph?.(selected.id);
      if (!mounted) return;
      setGraphs(items.length ? items : [selected]); setGraph(detail?.graph ?? selected);
      if (detail) {
        setRun(detail.latestRun);
        if (detail.latestRun && api.getGraphRun) {
          const runDetail = await api.getGraphRun(detail.latestRun.id);
          if (mounted) { setRun(runDetail.run); setNodeRuns(runDetail.nodeRuns); setRunEvents(runDetail.events); setResult(runDetail.run.output); }
        }
      }
    }).catch((cause) => { if (mounted) setError(message(cause)); });
    return () => { mounted = false; };
  }, [active, api, projectId]);

  useEffect(() => {
    if (!api?.getGraphRun || run?.status !== "running") return;
    const refresh = () => { void api.getGraphRun!(run.id).then((detail) => { setRun(detail.run); setNodeRuns(detail.nodeRuns); setRunEvents(detail.events); if (detail.run.output !== null) setResult(detail.run.output); }); };
    refresh();
    const timer = setInterval(refresh, 400);
    return () => clearInterval(timer);
  }, [api, run?.id, run?.status]);

  const flowNodes = useMemo(() => graph ? toFlowNodes(graph, nodeRuns, measurements.current) : [], [graph, nodeRuns]);
  const flowEdges = useMemo(() => graph ? toFlowEdges(graph) : [], [graph]);
  useEffect(() => {
    if (!active || flowNodes.length === 0) return;
    const frame = requestAnimationFrame(() => { void flow.current?.fitView({ padding: 0.12, duration: 250 }); });
    return () => cancelAnimationFrame(frame);
  }, [active, flowNodes.length]);
  const selectedNode = graph?.definition.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const validation = graph ? validateGraphDefinition(graph.definition) : [];
  const clearRunState = () => { setRun(null); setNodeRuns([]); setRunEvents([]); setResult(null); setSelectedNodeId(null); };
  const selectGraph = async (id: string) => {
    clearRunState();
    try {
      const detail = await api?.getGraph?.(id);
      if (!detail) return;
      setGraph(detail.graph); setRun(detail.latestRun); setResult(detail.latestRun?.output ?? null);
      if (detail.latestRun && api?.getGraphRun) {
        const runDetail = await api.getGraphRun(detail.latestRun.id);
        setRun(runDetail.run); setNodeRuns(runDetail.nodeRuns); setRunEvents(runDetail.events); setResult(runDetail.run.output);
      }
    } catch (cause) { setError(message(cause)); }
  };
  const updateGraph = (change: (current: GraphProject) => GraphProject) => setGraph((current) => current ? change(current) : current);
  const addNode = (type: GraphNode["type"]) => { fitAfterMeasurement.current = true; updateGraph((current) => appendNode(current, type, agents)); };
  const changeNodes = (changes: NodeChange[]) => {
    for (const change of changes) if (change.type === "dimensions" && change.dimensions) measurements.current.set(change.id, change.dimensions);
    updateGraph((current) => applyPositionChanges(current, changes));
    if (fitAfterMeasurement.current && changes.some((change) => change.type === "dimensions")) {
      fitAfterMeasurement.current = false;
      requestAnimationFrame(() => { void flow.current?.fitView({ padding: 0.12, duration: 250 }); });
    }
  };
  const save = async () => {
    if (!graph || !api?.saveGraph) return;
    if (validation.length) { setError(validation.join(" · ")); return; }
    try { const saved = await api.saveGraph(graph); setGraph(saved); setGraphs((items) => items.map((item) => item.id === saved.id ? saved : item)); setError(null); }
    catch (cause) { setError(message(cause)); }
  };
  const startRun = async () => {
    if (!graph || !api?.runGraph || !api.saveGraph || validation.length) { setError(validation.join(" · ")); return; }
    try {
      const saved = await api.saveGraph(graph);
      setGraph(saved); setGraphs((items) => items.map((item) => item.id === saved.id ? saved : item));
      const next = await api.runGraph(saved.id, runInput); setRun(next); setNodeRuns([]); setRunEvents([]); setResult(next.output); setError(null);
      const detail = await api.getGraphRun?.(next.id); if (detail) { setRun(detail.run); setNodeRuns(detail.nodeRuns); setRunEvents(detail.events); setResult(detail.run.output); }
    } catch (cause) { setError(message(cause)); }
  };

  if (!projectId) return <section className="graph-canvas graph-canvas--empty" data-testid="graph-canvas" aria-label="Graph Canvas"><div><h2>{zh ? "导入项目后开始编排" : "Import a project to build a graph"}</h2><p>{zh ? "Graph 会保存到当前工作区。" : "Graphs are stored in the selected workspace."}</p></div></section>;

  return <section className="graph-canvas" data-testid="graph-canvas" aria-label="Graph Canvas">
    <aside className="graph-sidebar">
      <header><strong>{zh ? "图工程" : "Graphs"}</strong><button type="button" aria-label={zh ? "新建图" : "New graph"} onClick={() => { clearRunState(); void createNew(api, projectId, agents, setGraphs, setGraph, setError); }}>＋</button></header>
      <div className="graph-list">{graphs.map((item) => <button type="button" key={item.id} data-active={item.id === graph?.id || undefined} onClick={() => void selectGraph(item.id)}><span>{item.name}</span><small>{item.definition.nodes.length} {zh ? "节点" : "nodes"}</small></button>)}</div>
      <div className="graph-library"><h3>{zh ? "节点" : "Nodes"}</h3><button type="button" aria-label={zh ? "添加 Agent" : "Add Agent"} disabled={!graph} onClick={() => addNode("agent")}>✦ Agent</button><button type="button" aria-label={zh ? "添加循环计数器" : "Add Loop Counter"} disabled={!graph} onClick={() => addNode("loop_counter")}>↻ Loop Counter</button><button type="button" aria-label={zh ? "添加直通节点" : "Add Pass-through"} disabled={!graph} onClick={() => addNode("passthrough")}>→ Pass-through</button></div>
    </aside>
    <div className="graph-workspace">
      <header className="graph-toolbar"><input aria-label={zh ? "图名称" : "Graph name"} value={graph?.name ?? ""} onChange={(event) => updateGraph((current) => ({ ...current, name: event.currentTarget.value }))} /><span className="graph-toolbar__state">{validation.length ? (zh ? "需修复" : "Needs attention") : (zh ? "可运行" : "Ready")}</span><button type="button" aria-label={zh ? "保存图" : "Save graph"} onClick={() => void save()}>{zh ? "保存" : "Save"}</button><button type="button" className="danger-ghost" aria-label={zh ? "删除图" : "Delete graph"} disabled={run?.status === "running"} onClick={() => setConfirmDelete(true)}>⌫</button></header>
      <div className="graph-flow" data-testid="graph-flow"><ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} fitView minZoom={0.25} maxZoom={1.8} deleteKeyCode={["Backspace", "Delete"]} onInit={(instance) => { flow.current = instance; }} onNodeClick={(_event, node) => { if (!String(node.id).startsWith("virtual-")) setSelectedNodeId(node.id); }} onNodesChange={changeNodes} onNodesDelete={(nodes) => updateGraph((current) => removeNodes(current, nodes.map((node) => node.id)))} onEdgesDelete={(edges) => updateGraph((current) => ({ ...current, definition: { ...current.definition, edges: current.definition.edges.filter((edge) => !edges.some((deleted) => deleted.id === edge.id)) } }))} onConnect={(connection: Connection) => updateGraph((current) => connect(current, connection))} onMoveEnd={(_event, viewport) => updateGraph((current) => ({ ...current, viewport }))}><Background gap={18} size={1} color="#c9d8e8" /><Controls showInteractive={false} /></ReactFlow></div>
      <div className="graph-runbar"><textarea aria-label={zh ? "图输入" : "Graph input"} placeholder={zh ? "输入任务…" : "Describe the task…"} value={runInput} onChange={(event) => setRunInput(event.currentTarget.value)} /><div>{run?.status === "running" && <button type="button" className="graph-stop" aria-label={zh ? "停止图" : "Stop graph"} onClick={() => { if (run && api?.cancelGraphRun) void api.cancelGraphRun(run.id).then(() => setRun((current) => current ? { ...current, status: "cancelled" } : current)); }}>■</button>}<button type="button" aria-label={zh ? "运行图" : "Run graph"} disabled={!runInput.trim() || run?.status === "running" || validation.length > 0} onClick={() => void startRun()}>▶ {zh ? "运行" : "Run"}</button></div></div>
    </div>
    <aside className="graph-inspector" aria-label={zh ? "图检查器" : "Graph inspector"}>{selectedNode ? <NodeInspector node={selectedNode} agents={agents} zh={zh} onChange={(next) => updateGraph((current) => ({ ...current, definition: { ...current.definition, nodes: current.definition.nodes.map((node) => node.id === next.id ? next : node) } }))} onDelete={() => { updateGraph((current) => removeNodes(current, [selectedNode.id])); setSelectedNodeId(null); }} /> : <><h3>{zh ? "图设置" : "Graph settings"}</h3><label>{zh ? "描述" : "Description"}<textarea value={graph?.description ?? ""} onChange={(event) => updateGraph((current) => ({ ...current, description: event.currentTarget.value }))} /></label>{validation.length > 0 && <div className="graph-errors" role="alert">{validation.map((item) => <p key={item}>{item}</p>)}</div>}</>}{run && <section className="graph-run-state"><h3>{zh ? "最近运行" : "Latest run"}</h3><span data-status={run.status}>{run.status}</span>{result !== null && <><h4>{zh ? "最终结果" : "Final result"}</h4><pre>{result}</pre></>}{runEvents.length > 0 && <><h4>{zh ? "运行事件" : "Run events"}</h4><ol className="graph-event-log" role="log" aria-label={zh ? "运行事件" : "Run events"}>{runEvents.map((event) => <li key={event.id}><code>{event.type}</code>{event.nodeId ? <span>{graph?.definition.nodes.find((node) => node.id === event.nodeId)?.name ?? event.nodeId}</span> : null}</li>)}</ol></>}</section>}</aside>
    {error && <div className="graph-toast" role="alert"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
    {confirmDelete && <div className="client-dialog"><button type="button" className="client-dialog__backdrop" aria-label={zh ? "取消删除" : "Cancel deletion"} onPointerDown={() => setConfirmDelete(false)}/><div className="client-dialog__panel" role="dialog" aria-modal="true" aria-label={zh ? "删除图" : "Delete graph"}><h2>{zh ? "删除此图？" : "Delete this graph?"}</h2><p>{zh ? "运行记录也会被删除。" : "Its run history will also be removed."}</p><div><button onClick={() => setConfirmDelete(false)}>{zh ? "取消" : "Cancel"}</button><button className="danger" onClick={() => { clearRunState(); void removeGraph(api, graph, graphs, setGraphs, setGraph, setConfirmDelete, setError); }}>{zh ? "删除" : "Delete"}</button></div></div></div>}
  </section>;
}

function NodeInspector({ node, agents, zh, onChange, onDelete }: { node: GraphNode; agents: AgentSettingsView[]; zh: boolean; onChange(node: GraphNode): void; onDelete(): void }) {
  const availableAgents = sortAgents(agents.filter(isRunnableAgent));
  const selectedAgent = node.type === "agent" ? agents.find((agent) => agent.id === node.config.agentProductId) : undefined;
  return <><h3>{zh ? "节点设置" : "Node settings"}</h3><label>{zh ? "名称" : "Name"}<input value={node.name} onChange={(event) => onChange({ ...node, name: event.currentTarget.value })} /></label>{node.type === "loop_counter" && <label>{zh ? "最大迭代次数" : "Maximum iterations"}<input type="number" min="1" aria-label={zh ? "最大迭代次数" : "Maximum iterations"} value={node.config.maxIterations} onChange={(event) => onChange({ ...node, config: { maxIterations: Number(event.currentTarget.value) } })} /></label>}{node.type === "agent" && <><label>Agent<select aria-label="Agent" value={node.config.agentProductId} onChange={(event) => { const agent = availableAgents.find((item) => item.id === event.currentTarget.value); if (agent) onChange({ ...node, config: { ...node.config, agentProductId: agent.id, modelId: agent.catalog.models[0] ?? null, permissionMode: agent.catalog.permissionModes[0] ?? "request_approval" } }); }}>{availableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agentLabel(agent.id)}</option>)}</select></label><label>{zh ? "模型" : "Model"}<select value={node.config.modelId ?? ""} onChange={(event) => onChange({ ...node, config: { ...node.config, modelId: event.currentTarget.value || null } })}><option value="">Default</option>{selectedAgent?.catalog.models.map((model) => <option key={model}>{model}</option>)}</select></label><label>{zh ? "权限模式" : "Permission mode"}<select aria-label={zh ? "权限模式" : "Permission mode"} value={node.config.permissionMode} onChange={(event) => onChange({ ...node, config: { ...node.config, permissionMode: event.currentTarget.value as typeof node.config.permissionMode } })}>{selectedAgent?.catalog.permissionModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label><label>{zh ? "提示词" : "Prompt"}<textarea value={node.config.prompt} onChange={(event) => onChange({ ...node, config: { ...node.config, prompt: event.currentTarget.value } })} /></label></>}<button type="button" className="graph-inspector__delete" aria-label={zh ? "删除节点" : "Delete node"} onClick={onDelete}>{zh ? "删除节点" : "Delete node"}</button></>;
}

function defaultGraph(agents: AgentSettingsView[] = []): Omit<GraphProject, "id" | "projectId" | "createdAt" | "updatedAt"> {
  const agent = sortAgents(agents.filter(isRunnableAgent))[0];
  return { name: "Untitled graph", description: "", definition: { nodes: [{ id: "agent-1", type: "agent", name: "Agent 1", config: { agentProductId: agent?.id ?? "codex", modelId: agent?.catalog.models[0] ?? null, permissionMode: agent?.catalog.permissionModes[0] ?? "request_approval", prompt: "{{input}}" } }, { id: "loop-1", type: "loop_counter", name: "Loop Counter 1", config: { maxIterations: 3 } }, { id: "end-1", type: "passthrough", name: "Result", config: {} }], edges: [{ id: "agent-loop", source: "agent-1", target: "loop-1" }, { id: "loop-agent", source: "loop-1", target: "agent-1", condition: { branch: "loop" } }, { id: "loop-end", source: "loop-1", target: "end-1", condition: { branch: "done" } }], start: ["agent-1"], end: ["end-1"] }, viewport: { x: 0, y: 0, zoom: 1 }, positions: { "agent-1": { x: 220, y: 180 }, "loop-1": { x: 440, y: 180 }, "end-1": { x: 660, y: 180 } } };
}

function toFlowNodes(graph: GraphProject, nodeRuns: GraphNodeRun[], measurements = new Map<string, { width: number; height: number }>()): Node<GraphNodeData>[] {
  const startId = graph.definition.start[0];
  const endId = graph.definition.end[0];
  return [
    { id: "virtual-start", type: "workflow", position: { x: 20, y: 180 }, draggable: false, selectable: false, data: { kind: "start", label: "Start", subtitle: startId } },
    ...graph.definition.nodes.map((node, index) => ({ id: node.id, type: "workflow", position: graph.positions[node.id] ?? { x: 220 + index * 210, y: 180 }, measured: measurements.get(node.id), data: { kind: node.type, label: node.name, subtitle: node.type === "agent" ? agentLabel(node.config.agentProductId) : node.type === "loop_counter" ? `× ${node.config.maxIterations}` : undefined, status: nodeRuns.findLast((item) => item.nodeId === node.id)?.status } })),
    { id: "virtual-end", type: "workflow", position: { x: 480 + graph.definition.nodes.length * 180, y: 180 }, draggable: false, selectable: false, data: { kind: "end", label: "End", subtitle: endId } },
  ] as Node<GraphNodeData>[];
}

function toFlowEdges(graph: GraphProject): Edge[] {
  return [
    { id: "virtual-start-edge", source: "virtual-start", target: graph.definition.start[0] ?? "virtual-end", selectable: false },
    ...graph.definition.edges.map((edge) => ({ ...edge, sourceHandle: edge.condition?.branch, label: edge.condition?.branch })),
    { id: "virtual-end-edge", source: graph.definition.end[0] ?? "virtual-start", target: "virtual-end", selectable: false },
  ].map((edge) => ({ ...edge, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#8fa8bf" } }));
}

function appendNode(graph: GraphProject, type: GraphNode["type"], agents: AgentSettingsView[]): GraphProject {
  const count = graph.definition.nodes.filter((node) => node.type === type).length + 1;
  const id = `${type}-${crypto.randomUUID()}`;
  const agent = sortAgents(agents.filter(isRunnableAgent))[0];
  const node: GraphNode = type === "agent"
    ? { id, type, name: `Agent ${count}`, config: { agentProductId: agent?.id ?? "codex", modelId: agent?.catalog.models[0] ?? null, permissionMode: agent?.catalog.permissionModes[0] ?? "request_approval", prompt: "{{input}}" } }
    : type === "loop_counter"
      ? { id, type, name: `Loop Counter ${count}`, config: { maxIterations: 3 } }
      : { id, type, name: `Pass-through ${count}`, config: {} };
  return { ...graph, definition: { ...graph.definition, nodes: [...graph.definition.nodes, node] }, positions: { ...graph.positions, [id]: { x: 260 + graph.definition.nodes.length * 190, y: 300 } } };
}

function applyPositionChanges(graph: GraphProject, changes: NodeChange[]): GraphProject {
  const nodes = applyNodeChanges(changes, toFlowNodes(graph, []));
  const positions = { ...graph.positions };
  for (const node of nodes) if (!node.id.startsWith("virtual-")) positions[node.id] = node.position;
  return { ...graph, positions };
}

function connect(graph: GraphProject, connection: Connection): GraphProject {
  if (!connection.source || !connection.target || connection.source.startsWith("virtual-") || connection.target.startsWith("virtual-")) return graph;
  const edge = { id: crypto.randomUUID(), source: connection.source, target: connection.target, ...(connection.sourceHandle === "loop" || connection.sourceHandle === "done" ? { condition: { branch: connection.sourceHandle } } : {}) } as GraphDefinition["edges"][number];
  return { ...graph, definition: { ...graph.definition, edges: addEdge(edge, graph.definition.edges) as GraphDefinition["edges"] } };
}
function removeNodes(graph: GraphProject, ids: string[]): GraphProject {
  const removed = new Set(ids.filter((id) => !id.startsWith("virtual-")));
  return { ...graph, definition: { ...graph.definition, nodes: graph.definition.nodes.filter((node) => !removed.has(node.id)), edges: graph.definition.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)) }, positions: Object.fromEntries(Object.entries(graph.positions).filter(([id]) => !removed.has(id))) };
}

async function createNew(api: AinOneApi | undefined, projectId: string, agents: AgentSettingsView[], setGraphs: Dispatch<SetStateAction<GraphProject[]>>, setGraph: Dispatch<SetStateAction<GraphProject | null>>, setError: Dispatch<SetStateAction<string | null>>) {
  try { const graph = await api?.createGraph?.(projectId, defaultGraph(agents)); if (graph) { setGraphs((items) => [graph, ...items]); setGraph(graph); } } catch (cause) { setError(message(cause)); }
}
async function removeGraph(api: AinOneApi | undefined, graph: GraphProject | null, graphs: GraphProject[], setGraphs: Dispatch<SetStateAction<GraphProject[]>>, setGraph: Dispatch<SetStateAction<GraphProject | null>>, setConfirm: Dispatch<SetStateAction<boolean>>, setError: Dispatch<SetStateAction<string | null>>) {
  if (!graph) return;
  try { await api?.deleteGraph?.(graph.id); const next = graphs.filter((item) => item.id !== graph.id); setGraphs(next); setGraph(next[0] ?? null); setConfirm(false); } catch (cause) { setError(message(cause)); }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRunnableAgent(agent: AgentSettingsView): boolean { return agent.enabled !== false && (agent.status === "available" || agent.status === "capability_limited"); }
