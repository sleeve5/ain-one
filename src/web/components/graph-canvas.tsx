import { useEffect, useMemo, useRef, useState } from "react";
import { addEdge, applyNodeChanges, Background, Controls, MarkerType, ReactFlow, type Connection, type Edge, type Node, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphDefinition, GraphNode, GraphNodeRun, GraphProject, GraphRun, GraphRunEvent } from "../../shared/contracts.js";
import { validateGraphDefinition, validateGraphDraft } from "../../shared/validation.js";
import type { AinOneApi, AgentSettingsView } from "../api.js";
import { GraphNodeView, type GraphNodeData } from "./graph-node.js";
import { agentLabel, sortAgents } from "../agent-meta.js";

interface GraphCanvasProps {
  language?: "zh" | "en";
  api?: AinOneApi;
  graphId: string;
  agents?: AgentSettingsView[];
  view?: "editor" | "runs";
  clearRequest?: number;
  onGraphSaved?(graph: GraphProject): void;
  onValidationChange?(errors: string[]): void;
}
const nodeTypes = { workflow: GraphNodeView };

export function GraphCanvas({ language = "en", api, graphId, agents = [], view = "editor", clearRequest = 0, onGraphSaved, onValidationChange }: GraphCanvasProps) {
  const zh = language === "zh";
  const [graph, setGraph] = useState<GraphProject | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [run, setRun] = useState<GraphRun | null>(null);
  const [nodeRuns, setNodeRuns] = useState<GraphNodeRun[]>([]);
  const [runEvents, setRunEvents] = useState<GraphRunEvent[]>([]);
  const [runInput, setRunInput] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [interactionMode, setInteractionMode] = useState<"select" | "pan">("select");
  const flow = useRef<ReactFlowInstance<Node<GraphNodeData>, Edge> | null>(null);
  const flowElement = useRef<HTMLDivElement | null>(null);
  const lastClearRequest = useRef(clearRequest);
  const lastSaved = useRef("");
  const savingFingerprint = useRef("");
  const saveChain = useRef(Promise.resolve());
  const measurements = useRef(new Map<string, { width: number; height: number }>());
  const fitAfterMeasurement = useRef(false);
  const graphIdRef = useRef(graphId);
  const onGraphSavedRef = useRef(onGraphSaved);
  graphIdRef.current = graphId;
  onGraphSavedRef.current = onGraphSaved;

  useEffect(() => {
    let mounted = true;
    setGraph(null); setRun(null); setNodeRuns([]); setRunEvents([]); setResult(null); setRunInput(""); setSelectedNodeId(null); setError(null);
    if (!api?.getGraph) { setGraph(null); return; }
    void api.getGraph(graphId).then(async (detail) => {
      if (!mounted) return;
      lastSaved.current = editableFingerprint(detail.graph);
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
    if (clearRequest === lastClearRequest.current) return;
    lastClearRequest.current = clearRequest;
    if (graph) setConfirmClear(true);
  }, [clearRequest, graph]);

  useEffect(() => {
    if (!graph || !api?.saveGraph || graph.id !== graphId) return;
    const fingerprint = editableFingerprint(graph);
    if (fingerprint === lastSaved.current || fingerprint === savingFingerprint.current) return;
    const draftErrors = validateGraphDraft(graph.definition);
    if (draftErrors.length) { setError(draftErrors.join(" · ")); return; }
    const snapshot = structuredClone(graph);
    const requestedGraphId = graph.id;
    const timer = setTimeout(() => {
      savingFingerprint.current = fingerprint;
      saveChain.current = saveChain.current.catch(() => undefined).then(async () => {
        const saved = await api.saveGraph(snapshot);
        if (graphIdRef.current !== requestedGraphId) return;
        lastSaved.current = fingerprint;
        savingFingerprint.current = "";
        onGraphSavedRef.current?.(saved);
        setError(null);
      }).catch((cause) => { savingFingerprint.current = ""; if (graphIdRef.current === requestedGraphId) setError(message(cause)); });
    }, 350);
    return () => clearTimeout(timer);
  }, [api, graph, graphId]);

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
  const validationKey = validation.join("\n");
  useEffect(() => { onValidationChange?.(validation); }, [onValidationChange, validationKey]);
  const clearRunState = () => { setRun(null); setNodeRuns([]); setRunEvents([]); setResult(null); setSelectedNodeId(null); };
  const updateGraph = (change: (current: GraphProject) => GraphProject) => setGraph((current) => current ? change(current) : current);
  const addNode = (type: GraphNode["type"]) => { fitAfterMeasurement.current = true; updateGraph((current) => appendNode(current, type, agents)); };
  const changeNodes = (changes: NodeChange[]) => {
    for (const change of changes) if (change.type === "dimensions" && change.dimensions) measurements.current.set(change.id, change.dimensions);
    const positionChanges = changes.filter((change) => change.type === "position");
    if (positionChanges.length) updateGraph((current) => applyPositionChanges(current, positionChanges));
    if (fitAfterMeasurement.current && changes.some((change) => change.type === "dimensions")) {
      fitAfterMeasurement.current = false;
      requestAnimationFrame(() => { void flow.current?.fitView({ padding: 0.12, duration: 250 }); });
    }
  };
  const startRun = async () => {
    if (!graph || !api?.runGraph || !api.saveGraph || validation.length) { setError(validation.join(" · ")); return; }
    try {
      const requestedGraphId = graph.id;
      await saveChain.current.catch(() => undefined);
      const saved = await api.saveGraph(graph);
      lastSaved.current = editableFingerprint(saved);
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
      <div className="graph-library"><h3>{zh ? "节点" : "Nodes"}</h3><button type="button" aria-label={zh ? "添加 Agent" : "Add Agent"} disabled={!graph} onClick={() => addNode("agent")}>✦ Agent</button><button type="button" aria-label={zh ? "添加固定文本" : "Add Literal"} disabled={!graph} onClick={() => addNode("literal")}>T Literal</button><button type="button" aria-label={zh ? "添加文本模板" : "Add Template"} disabled={!graph} onClick={() => addNode("template")}>{`{ } Template`}</button><button type="button" aria-label={zh ? "添加循环计数器" : "Add Loop Counter"} disabled={!graph} onClick={() => addNode("loop_counter")}>↻ Loop Counter</button><button type="button" aria-label={zh ? "添加直通节点" : "Add Pass-through"} disabled={!graph} onClick={() => addNode("passthrough")}>→ Pass-through</button></div>
    </aside>
    <div className="graph-workspace">
      <div className="graph-flow" data-testid="graph-flow" ref={flowElement}><ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} fitView minZoom={0.25} maxZoom={1.8} deleteKeyCode={interactionMode === "select" ? ["Backspace", "Delete"] : null} nodesDraggable={interactionMode === "select"} nodesConnectable={interactionMode === "select"} elementsSelectable={interactionMode === "select"} selectionOnDrag={interactionMode === "select"} panOnDrag={interactionMode === "pan"} onInit={(instance) => { flow.current = instance; }} onNodeClick={(_event, node) => { if (interactionMode === "select" && !String(node.id).startsWith("virtual-")) setSelectedNodeId(node.id); }} onNodesChange={changeNodes} onNodesDelete={(nodes) => updateGraph((current) => removeNodes(current, nodes.map((node) => node.id)))} onEdgesDelete={(edges) => updateGraph((current) => ({ ...current, definition: { ...current.definition, edges: current.definition.edges.filter((edge) => !edges.some((deleted) => deleted.id === edge.id)) } }))} onConnect={(connection: Connection) => updateGraph((current) => connect(current, connection))} onMoveEnd={(_event, viewport) => updateGraph((current) => ({ ...current, viewport }))}><Background gap={18} size={1} color="#c9d8e8" /><Controls showInteractive={false} /><div className="graph-canvas-controls"><button type="button" aria-label={zh ? "全屏" : "Fullscreen"} onClick={() => void (document.fullscreenElement ? document.exitFullscreen?.() : flowElement.current?.requestFullscreen?.())}><FullscreenIcon /></button><button type="button" aria-label={interactionMode === "select" ? (zh ? "切换到拖动画布" : "Switch to pan mode") : (zh ? "切换到选择模式" : "Switch to select mode")} data-active={interactionMode === "pan"} onClick={() => setInteractionMode((current) => current === "select" ? "pan" : "select")}>{interactionMode === "select" ? <HandIcon /> : <PointerIcon />}</button></div></ReactFlow></div>
      <div className="graph-runbar"><textarea aria-label={zh ? "图输入" : "Graph input"} placeholder={zh ? "输入任务…" : "Describe the task…"} value={runInput} onChange={(event) => setRunInput(event.currentTarget.value)} /><div>{run?.status === "running" && <button type="button" className="graph-stop" aria-label={zh ? "停止图" : "Stop graph"} onClick={() => { if (run && api?.cancelGraphRun) void api.cancelGraphRun(run.id).then(() => setRun((current) => current ? { ...current, status: "cancelled" } : current)); }}>■</button>}<button type="button" aria-label={zh ? "运行图" : "Run graph"} disabled={!runInput.trim() || run?.status === "running" || validation.length > 0} onClick={() => void startRun()}>▶ {zh ? "运行" : "Run"}</button></div></div>
    </div>
    <aside className="graph-inspector" aria-label={zh ? "图检查器" : "Graph inspector"}>{selectedNode ? <NodeInspector node={selectedNode} agents={agents} zh={zh} isStart={graph?.definition.start.includes(selectedNode.id) ?? false} isEnd={graph?.definition.end.includes(selectedNode.id) ?? false} onSetBoundary={(boundary) => updateGraph((current) => ({ ...current, definition: { ...current.definition, [boundary]: [selectedNode.id] } }))} onChange={(next) => updateGraph((current) => ({ ...current, definition: { ...current.definition, nodes: current.definition.nodes.map((node) => node.id === next.id ? next : node) } }))} onDelete={() => { updateGraph((current) => removeNodes(current, [selectedNode.id])); setSelectedNodeId(null); }} /> : <><h3>{zh ? "图设置" : "Graph settings"}</h3><label>{zh ? "描述" : "Description"}<textarea value={graph?.description ?? ""} onChange={(event) => updateGraph((current) => ({ ...current, description: event.currentTarget.value }))} /></label>{validation.length > 0 && <div className="graph-errors" role="alert">{validation.map((item) => <p key={item}>{item}</p>)}</div>}</>}{run && <section className="graph-run-state"><h3>{zh ? "最近运行" : "Latest run"}</h3><span data-status={run.status}>{run.status}</span>{result !== null && <><h4>{zh ? "最终结果" : "Final result"}</h4><pre>{result}</pre></>}{runEvents.length > 0 && <><h4>{zh ? "运行事件" : "Run events"}</h4><ol className="graph-event-log" role="log" aria-label={zh ? "运行事件" : "Run events"}>{runEvents.map((event) => <li key={event.id}><code>{event.type}</code>{event.nodeId ? <span>{graph?.definition.nodes.find((node) => node.id === event.nodeId)?.name ?? event.nodeId}</span> : null}</li>)}</ol></>}</section>}</aside>
    {error && <div className="graph-toast" role="alert"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
    {confirmClear && <div className="client-dialog"><button type="button" className="client-dialog__backdrop" aria-label={zh ? "取消清空" : "Cancel clearing"} onPointerDown={() => setConfirmClear(false)}/><div className="client-dialog__panel" role="dialog" aria-modal="true" aria-label={zh ? "清空图" : "Clear graph"}><h2>{zh ? "清空此图？" : "Clear this graph?"}</h2><p>{zh ? "将移除全部节点和连线，但保留图及其运行记录。" : "All nodes and edges will be removed. The Graph and its run history remain."}</p><div><button onClick={() => setConfirmClear(false)}>{zh ? "取消" : "Cancel"}</button><button className="danger" onClick={() => { clearRunState(); updateGraph((current) => ({ ...current, definition: { nodes: [], edges: [], start: [], end: [] }, positions: {} })); setConfirmClear(false); }}>{zh ? "清空" : "Clear"}</button></div></div></div>}
  </section>;
}

function NodeInspector({ node, agents, zh, isStart, isEnd, onSetBoundary, onChange, onDelete }: { node: GraphNode; agents: AgentSettingsView[]; zh: boolean; isStart: boolean; isEnd: boolean; onSetBoundary(boundary: "start" | "end"): void; onChange(node: GraphNode): void; onDelete(): void }) {
  const availableAgents = sortAgents(agents.filter(isRunnableAgent));
  const selectedAgent = node.type === "agent" ? agents.find((agent) => agent.id === node.config.agentProductId) : undefined;
  const modelId = node.type === "agent" && selectedAgent?.catalog.models.includes(node.config.modelId ?? "") ? node.config.modelId ?? "" : "";
  return <><h3>{zh ? "节点设置" : "Node settings"}</h3><label>{zh ? "名称" : "Name"}<input value={node.name} onChange={(event) => onChange({ ...node, name: event.currentTarget.value })} /></label><div className="graph-inspector__boundaries"><button type="button" data-active={isStart} onClick={() => onSetBoundary("start")}>{zh ? "设为起点" : "Set as start"}</button><button type="button" data-active={isEnd} onClick={() => onSetBoundary("end")}>{zh ? "设为终点" : "Set as end"}</button></div>{node.type === "loop_counter" && <label>{zh ? "最大迭代次数" : "Maximum iterations"}<input type="number" min="1" aria-label={zh ? "最大迭代次数" : "Maximum iterations"} value={node.config.maxIterations} onChange={(event) => onChange({ ...node, config: { maxIterations: Number(event.currentTarget.value) } })} /></label>}{node.type === "literal" && <label>{zh ? "固定文本" : "Value"}<textarea aria-label={zh ? "固定文本" : "Value"} value={node.config.value} onChange={(event) => onChange({ ...node, config: { value: event.currentTarget.value } })} /></label>}{node.type === "template" && <label>{zh ? "文本模板" : "Template"}<textarea aria-label={zh ? "文本模板" : "Template"} value={node.config.template} onChange={(event) => onChange({ ...node, config: { template: event.currentTarget.value } })} /></label>}{node.type === "agent" && <><label>Agent<select aria-label="Agent" value={node.config.agentProductId} onChange={(event) => { const agent = availableAgents.find((item) => item.id === event.currentTarget.value); if (agent) onChange({ ...node, config: { ...node.config, agentProductId: agent.id, modelId: agent.catalog.models[0] ?? null, permissionMode: agent.catalog.permissionModes[0] ?? "request_approval" } }); }}>{availableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agentLabel(agent.id)}</option>)}</select></label><label>{zh ? "模型" : "Model"}<select aria-label={zh ? "模型" : "Model"} value={modelId} onChange={(event) => onChange({ ...node, config: { ...node.config, modelId: event.currentTarget.value || null } })}><option value="">Default</option>{selectedAgent?.catalog.models.map((model) => <option key={model}>{model}</option>)}</select></label><label>{zh ? "权限模式" : "Permission mode"}<select aria-label={zh ? "权限模式" : "Permission mode"} value={node.config.permissionMode} onChange={(event) => onChange({ ...node, config: { ...node.config, permissionMode: event.currentTarget.value as typeof node.config.permissionMode } })}>{selectedAgent?.catalog.permissionModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label><label>{zh ? "提示词" : "Prompt"}<textarea value={node.config.prompt} onChange={(event) => onChange({ ...node, config: { ...node.config, prompt: event.currentTarget.value } })} /></label></>}<button type="button" className="graph-inspector__delete" aria-label={zh ? "删除节点" : "Delete node"} onClick={onDelete}>{zh ? "删除节点" : "Delete node"}</button></>;
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
    ...graph.definition.nodes.map((node, index) => ({ id: node.id, type: "workflow", position: graph.positions[node.id] ?? { x: 220 + index * 210, y: 180 }, measured: measurements.get(node.id), data: { kind: node.type, label: node.name, subtitle: node.type === "agent" ? agentLabel(node.config.agentProductId) : node.type === "loop_counter" ? `× ${node.config.maxIterations}` : node.type === "literal" ? node.config.value : node.type === "template" ? "{{input}}" : undefined, status: nodeRuns.findLast((item) => item.nodeId === node.id)?.status } })),
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
      : type === "literal"
        ? { id, type, name: `Literal ${count}`, config: { value: "" } }
        : type === "template"
          ? { id, type, name: `Template ${count}`, config: { template: "{{input}}" } }
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
  return { ...graph, definition: { ...graph.definition, nodes: graph.definition.nodes.filter((node) => !removed.has(node.id)), edges: graph.definition.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)), start: graph.definition.start.filter((id) => !removed.has(id)), end: graph.definition.end.filter((id) => !removed.has(id)) }, positions: Object.fromEntries(Object.entries(graph.positions).filter(([id]) => !removed.has(id))) };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRunnableAgent(agent: AgentSettingsView): boolean { return agent.enabled !== false && agent.status !== "not_installed" && agent.status !== "runtime_error" && agent.status !== "version_unsupported"; }
function editableFingerprint(graph: GraphProject): string { return JSON.stringify([graph.name, graph.description, graph.definition, graph.viewport, graph.positions]); }
function FullscreenIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4M13 3h4v4M7 17H3v-4M13 17h4v-4" /></svg>; }
function HandIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 9V5.5a1.2 1.2 0 0 1 2.4 0V8m0-3.5a1.2 1.2 0 0 1 2.4 0V8m0-2.5a1.2 1.2 0 0 1 2.4 0V9m0-1.5a1.2 1.2 0 0 1 2.4 0v4c0 3-2 5-5 5H9c-2 0-3.1-.8-4.1-2.2L2.8 12a1.2 1.2 0 0 1 1.9-1.5L6.5 12Z" /></svg>; }
function PointerIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3l10 8-5 .8-2.4 4.5Z" /></svg>; }
