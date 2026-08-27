import { useEffect, useMemo, useRef, useState } from "react";
import { addEdge, applyNodeChanges, Background, Controls, MarkerType, ReactFlow, type Connection, type Edge, type Node, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphDefinition, GraphNode, GraphNodeRun, GraphProject, GraphRun, GraphRunEvent } from "../../shared/contracts.js";
import { validateGraphDefinition } from "../../shared/validation.js";
import type { AinOneApi, AgentSettingsView } from "../api.js";
import { GraphNodeView, type GraphNodeData } from "./graph-node.js";
import { agentLabel, sortAgents } from "../agent-meta.js";

interface GraphCanvasProps {
  language?: "zh" | "en";
  api?: AinOneApi;
  graphId: string;
  agents?: AgentSettingsView[];
  view?: "editor" | "runs";
  onGraphSaved?(graph: GraphProject): void;
  onGraphDeleted?(graphId: string): void;
}
const nodeTypes = { workflow: GraphNodeView };

export function GraphCanvas({ language = "en", api, graphId, agents = [], view = "editor", onGraphSaved, onGraphDeleted }: GraphCanvasProps) {
  const zh = language === "zh";
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
  const graphIdRef = useRef(graphId);
  graphIdRef.current = graphId;

  useEffect(() => {
    let mounted = true;
    setGraph(null); setRun(null); setNodeRuns([]); setRunEvents([]); setResult(null); setRunInput(""); setSelectedNodeId(null); setError(null);
    if (!api?.getGraph) { setGraph(null); return; }
    void api.getGraph(graphId).then(async (detail) => {
      if (!mounted) return;
      setGraph(detail.graph);
      setRun(detail.latestRun);
      if (detail.latestRun && api.getGraphRun) {
        const runDetail = await api.getGraphRun(detail.latestRun.id);
        if (mounted) { setRun(runDetail.run); setNodeRuns(runDetail.nodeRuns); setRunEvents(runDetail.events); setResult(runDetail.run.output); }
      }
    }).catch((cause) => { if (mounted) setError(message(cause)); });
    return () => { mounted = false; };
  }, [api, graphId]);

  useEffect(() => {
    if (!api?.getGraphRun || run?.status !== "running") return;
    const requestedGraphId = graphId;
    const refresh = () => { void api.getGraphRun!(run.id).then((detail) => { if (graphIdRef.current !== requestedGraphId) return; setRun(detail.run); setNodeRuns(detail.nodeRuns); setRunEvents(detail.events); if (detail.run.output !== null) setResult(detail.run.output); }); };
    refresh();
    const timer = setInterval(refresh, 400);
    return () => clearInterval(timer);
  }, [api, graphId, run?.id, run?.status]);

  const flowNodes = useMemo(() => graph ? toFlowNodes(graph, nodeRuns, measurements.current) : [], [graph, nodeRuns]);
  const flowEdges = useMemo(() => graph ? toFlowEdges(graph) : [], [graph]);
  useEffect(() => {
    if (flowNodes.length === 0) return;
    const frame = requestAnimationFrame(() => { void flow.current?.fitView({ padding: 0.12, duration: 250 }); });
    return () => cancelAnimationFrame(frame);
  }, [flowNodes.length]);
  const selectedNode = graph?.definition.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const validation = graph ? validateGraphDefinition(graph.definition) : [];
  const clearRunState = () => { setRun(null); setNodeRuns([]); setRunEvents([]); setResult(null); setSelectedNodeId(null); };
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
    const requestedGraphId = graph.id;
    try { const saved = await api.saveGraph(graph); onGraphSaved?.(saved); if (graphIdRef.current === requestedGraphId) { setGraph(saved); setError(null); } }
    catch (cause) { if (graphIdRef.current === requestedGraphId) setError(message(cause)); }
  };
  const startRun = async () => {
    if (!graph || !api?.runGraph || !api.saveGraph || validation.length) { setError(validation.join(" · ")); return; }
    try {
      const requestedGraphId = graph.id;
      const saved = await api.saveGraph(graph);
      onGraphSaved?.(saved);
      if (graphIdRef.current !== requestedGraphId) return;
      setGraph(saved);
      const next = await api.runGraph(saved.id, runInput);
      if (graphIdRef.current !== requestedGraphId) return;
      setRun(next); setNodeRuns([]); setRunEvents([]); setResult(next.output); setError(null);
      const detail = await api.getGraphRun?.(next.id); if (detail && graphIdRef.current === requestedGraphId) { setRun(detail.run); setNodeRuns(detail.nodeRuns); setRunEvents(detail.events); setResult(detail.run.output); }
    } catch (cause) { if (graphIdRef.current === graph.id) setError(message(cause)); }
  };

  if (view === "runs") return <section className="graph-run-view" data-testid="graph-canvas" aria-label={zh ? "最近运行" : "Latest run"}>{run ? <div className="graph-run-view__panel"><div><span data-status={run.status}>{run.status}</span><time dateTime={run.updatedAt}>{new Date(run.updatedAt).toLocaleString()}</time></div><h3>{zh ? "输入" : "Input"}</h3><pre>{run.input}</pre>{result !== null ? <><h3>{zh ? "最终结果" : "Final result"}</h3><pre>{result}</pre></> : null}{run.error ? <><h3>{zh ? "错误" : "Error"}</h3><pre>{run.error.message}</pre></> : null}{runEvents.length ? <><h3>{zh ? "运行事件" : "Run events"}</h3><ol className="graph-event-log" role="log" aria-label={zh ? "运行事件" : "Run events"}>{runEvents.map((event) => <li key={event.id}><code>{event.type}</code>{event.nodeId ? <span>{graph?.definition.nodes.find((node) => node.id === event.nodeId)?.name ?? event.nodeId}</span> : null}</li>)}</ol></> : null}</div> : <div className="graph-run-view__empty"><h2>{zh ? "暂无运行" : "No runs yet"}</h2><p>{zh ? "运行图后，最近一次结果会显示在这里。" : "Run this graph to see its latest result here."}</p></div>}</section>;

  return <section className="graph-canvas" data-testid="graph-canvas" aria-label="Graph Canvas">
    <aside className="graph-sidebar">
      <div className="graph-library"><h3>{zh ? "节点" : "Nodes"}</h3><button type="button" aria-label={zh ? "添加 Agent" : "Add Agent"} disabled={!graph} onClick={() => addNode("agent")}>✦ Agent</button><button type="button" aria-label={zh ? "添加循环计数器" : "Add Loop Counter"} disabled={!graph} onClick={() => addNode("loop_counter")}>↻ Loop Counter</button><button type="button" aria-label={zh ? "添加直通节点" : "Add Pass-through"} disabled={!graph} onClick={() => addNode("passthrough")}>→ Pass-through</button></div>
    </aside>
    <div className="graph-workspace">
      <header className="graph-toolbar"><input aria-label={zh ? "图名称" : "Graph name"} value={graph?.name ?? ""} disabled={!graph} onChange={(event) => updateGraph((current) => ({ ...current, name: event.currentTarget.value }))} /><span className="graph-toolbar__state">{graph ? (validation.length ? (zh ? "需修复" : "Needs attention") : (zh ? "可运行" : "Ready")) : (zh ? "加载中" : "Loading")}</span><button type="button" aria-label={zh ? "保存图" : "Save graph"} disabled={!graph} onClick={() => void save()}>{zh ? "保存" : "Save"}</button><button type="button" className="danger-ghost" aria-label={zh ? "删除图" : "Delete graph"} disabled={!graph || run?.status === "running"} onClick={() => setConfirmDelete(true)}>⌫</button></header>
      <div className="graph-flow" data-testid="graph-flow"><ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} fitView minZoom={0.25} maxZoom={1.8} deleteKeyCode={["Backspace", "Delete"]} onInit={(instance) => { flow.current = instance; }} onNodeClick={(_event, node) => { if (!String(node.id).startsWith("virtual-")) setSelectedNodeId(node.id); }} onNodesChange={changeNodes} onNodesDelete={(nodes) => updateGraph((current) => removeNodes(current, nodes.map((node) => node.id)))} onEdgesDelete={(edges) => updateGraph((current) => ({ ...current, definition: { ...current.definition, edges: current.definition.edges.filter((edge) => !edges.some((deleted) => deleted.id === edge.id)) } }))} onConnect={(connection: Connection) => updateGraph((current) => connect(current, connection))} onMoveEnd={(_event, viewport) => updateGraph((current) => ({ ...current, viewport }))}><Background gap={18} size={1} color="#c9d8e8" /><Controls showInteractive={false} /></ReactFlow></div>
      <div className="graph-runbar"><textarea aria-label={zh ? "图输入" : "Graph input"} placeholder={zh ? "输入任务…" : "Describe the task…"} value={runInput} onChange={(event) => setRunInput(event.currentTarget.value)} /><div>{run?.status === "running" && <button type="button" className="graph-stop" aria-label={zh ? "停止图" : "Stop graph"} onClick={() => { if (run && api?.cancelGraphRun) void api.cancelGraphRun(run.id).then(() => setRun((current) => current ? { ...current, status: "cancelled" } : current)); }}>■</button>}<button type="button" aria-label={zh ? "运行图" : "Run graph"} disabled={!runInput.trim() || run?.status === "running" || validation.length > 0} onClick={() => void startRun()}>▶ {zh ? "运行" : "Run"}</button></div></div>
    </div>
    <aside className="graph-inspector" aria-label={zh ? "图检查器" : "Graph inspector"}>{selectedNode ? <NodeInspector node={selectedNode} agents={agents} zh={zh} onChange={(next) => updateGraph((current) => ({ ...current, definition: { ...current.definition, nodes: current.definition.nodes.map((node) => node.id === next.id ? next : node) } }))} onDelete={() => { updateGraph((current) => removeNodes(current, [selectedNode.id])); setSelectedNodeId(null); }} /> : <><h3>{zh ? "图设置" : "Graph settings"}</h3><label>{zh ? "描述" : "Description"}<textarea value={graph?.description ?? ""} onChange={(event) => updateGraph((current) => ({ ...current, description: event.currentTarget.value }))} /></label>{validation.length > 0 && <div className="graph-errors" role="alert">{validation.map((item) => <p key={item}>{item}</p>)}</div>}</>}{run && <section className="graph-run-state"><h3>{zh ? "最近运行" : "Latest run"}</h3><span data-status={run.status}>{run.status}</span>{result !== null && <><h4>{zh ? "最终结果" : "Final result"}</h4><pre>{result}</pre></>}{runEvents.length > 0 && <><h4>{zh ? "运行事件" : "Run events"}</h4><ol className="graph-event-log" role="log" aria-label={zh ? "运行事件" : "Run events"}>{runEvents.map((event) => <li key={event.id}><code>{event.type}</code>{event.nodeId ? <span>{graph?.definition.nodes.find((node) => node.id === event.nodeId)?.name ?? event.nodeId}</span> : null}</li>)}</ol></>}</section>}</aside>
    {error && <div className="graph-toast" role="alert"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
    {confirmDelete && <div className="client-dialog"><button type="button" className="client-dialog__backdrop" aria-label={zh ? "取消删除" : "Cancel deletion"} onPointerDown={() => setConfirmDelete(false)}/><div className="client-dialog__panel" role="dialog" aria-modal="true" aria-label={zh ? "删除图" : "Delete graph"}><h2>{zh ? "删除此图？" : "Delete this graph?"}</h2><p>{zh ? "运行记录也会被删除。" : "Its run history will also be removed."}</p><div><button onClick={() => setConfirmDelete(false)}>{zh ? "取消" : "Cancel"}</button><button className="danger" onClick={() => { if (!graph) return; const id = graph.id; clearRunState(); void api?.deleteGraph(id).then(() => onGraphDeleted?.(id), (cause) => setError(message(cause))); setConfirmDelete(false); }}>{zh ? "删除" : "Delete"}</button></div></div></div>}
  </section>;
}

function NodeInspector({ node, agents, zh, onChange, onDelete }: { node: GraphNode; agents: AgentSettingsView[]; zh: boolean; onChange(node: GraphNode): void; onDelete(): void }) {
  const availableAgents = sortAgents(agents.filter(isRunnableAgent));
  const selectedAgent = node.type === "agent" ? agents.find((agent) => agent.id === node.config.agentProductId) : undefined;
  return <><h3>{zh ? "节点设置" : "Node settings"}</h3><label>{zh ? "名称" : "Name"}<input value={node.name} onChange={(event) => onChange({ ...node, name: event.currentTarget.value })} /></label>{node.type === "loop_counter" && <label>{zh ? "最大迭代次数" : "Maximum iterations"}<input type="number" min="1" aria-label={zh ? "最大迭代次数" : "Maximum iterations"} value={node.config.maxIterations} onChange={(event) => onChange({ ...node, config: { maxIterations: Number(event.currentTarget.value) } })} /></label>}{node.type === "agent" && <><label>Agent<select aria-label="Agent" value={node.config.agentProductId} onChange={(event) => { const agent = availableAgents.find((item) => item.id === event.currentTarget.value); if (agent) onChange({ ...node, config: { ...node.config, agentProductId: agent.id, modelId: agent.catalog.models[0] ?? null, permissionMode: agent.catalog.permissionModes[0] ?? "request_approval" } }); }}>{availableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agentLabel(agent.id)}</option>)}</select></label><label>{zh ? "模型" : "Model"}<select value={node.config.modelId ?? ""} onChange={(event) => onChange({ ...node, config: { ...node.config, modelId: event.currentTarget.value || null } })}><option value="">Default</option>{selectedAgent?.catalog.models.map((model) => <option key={model}>{model}</option>)}</select></label><label>{zh ? "权限模式" : "Permission mode"}<select aria-label={zh ? "权限模式" : "Permission mode"} value={node.config.permissionMode} onChange={(event) => onChange({ ...node, config: { ...node.config, permissionMode: event.currentTarget.value as typeof node.config.permissionMode } })}>{selectedAgent?.catalog.permissionModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label><label>{zh ? "提示词" : "Prompt"}<textarea value={node.config.prompt} onChange={(event) => onChange({ ...node, config: { ...node.config, prompt: event.currentTarget.value } })} /></label></>}<button type="button" className="graph-inspector__delete" aria-label={zh ? "删除节点" : "Delete node"} onClick={onDelete}>{zh ? "删除节点" : "Delete node"}</button></>;
}

export function defaultGraph(agents: AgentSettingsView[] = []): Omit<GraphProject, "id" | "projectId" | "createdAt" | "updatedAt"> {
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

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRunnableAgent(agent: AgentSettingsView): boolean { return agent.enabled !== false && (agent.status === "available" || agent.status === "capability_limited"); }
