import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "markdown-to-jsx";
import { applyNodeChanges, Background, BaseEdge, Controls, EdgeLabelRenderer, getSmoothStepPath, MarkerType, ReactFlow, SelectionMode, useReactFlow, type Connection, type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphDefinition, GraphInputField, GraphNode, GraphNodeRun, GraphPort, GraphProject, GraphRun, GraphRunEvent, GraphValues, NormalizedEvent, PermissionMode } from "../../shared/contracts.js";
import { validateGraphDefinition, validateGraphDraft } from "../../shared/validation.js";
import type { AinOneApi, AgentSettingsView } from "../api.js";
import { agentLabel, sortAgents } from "../agent-meta.js";
import { GraphNodeView, type GraphNodeData } from "./graph-node.js";
import { TrajectoryCanvas } from "./trajectory-canvas.js";

interface GraphCanvasProps { language?: "zh" | "en"; api?: AinOneApi; graphId: string; agents?: AgentSettingsView[]; view?: "editor" | "runs"; clearRequest?: number; onGraphSaved?(graph: GraphProject): void; onValidationChange?(errors: string[]): void; }
interface ClipboardGraph { nodes: GraphNode[]; edges: GraphDefinition["edges"]; positions: GraphProject["positions"]; }
interface RoutableEdgeData extends Record<string, unknown> { route?: { x: number; y: number }; routeLabel?: string; onRoute?(edgeId: string, route: { x: number; y: number }): void; }
const nodeTypes = { workflow: GraphNodeView };
const edgeTypes = { routable: RoutableEdge };
const permissionLabels: Record<PermissionMode, { zh: string; en: string }> = { request_approval: { zh: "需要审批", en: "Ask for approval" }, help_me_approve: { zh: "自动审批", en: "Auto approve" }, full_access: { zh: "完全访问", en: "Full access" } };

function RoutableEdge({ id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, markerEnd, label, style, selected, data }: EdgeProps<Edge<RoutableEdgeData>>) {
  const { screenToFlowPosition } = useReactFlow();
  const route = data?.route;
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, centerX: route?.x, centerY: route?.y, borderRadius: 8 });
  const beginRoute = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const move = (next: PointerEvent) => data?.onRoute?.(id, screenToFlowPosition({ x: next.clientX, y: next.clientY }));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };
  return <><BaseEdge id={id} path={path} markerEnd={markerEnd} label={label} style={style} />{selected && data?.onRoute ? <EdgeLabelRenderer><button type="button" className="graph-edge-route nodrag nopan" aria-label={data.routeLabel} style={{ transform: `translate(-50%, -50%) translate(${route?.x ?? labelX}px, ${route?.y ?? labelY}px)` }} onPointerDown={beginRoute} /></EdgeLabelRenderer> : null}</>;
}

export function GraphCanvas({ language = "en", api, graphId, agents = [], view = "editor", clearRequest = 0, onGraphSaved, onValidationChange }: GraphCanvasProps) {
  const zh = language === "zh";
  const [graph, setGraph] = useState<GraphProject | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<string>>(new Set());
  const [run, setRun] = useState<GraphRun | null>(null);
  const [runs, setRuns] = useState<GraphRun[]>([]);
  const [nodeRuns, setNodeRuns] = useState<GraphNodeRun[]>([]);
  const [runEvents, setRunEvents] = useState<GraphRunEvent[]>([]);
  const [runInput, setRunInput] = useState<GraphValues>({});
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [interactionMode, setInteractionMode] = useState<"select" | "pan">("select");
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorWidth, setInspectorWidth] = useState(() => Number(globalThis.localStorage?.getItem("ain-one.graph.inspector-width")) || 300);
  const flow = useRef<ReactFlowInstance<Node<GraphNodeData>, Edge> | null>(null);
  const lastClearRequest = useRef(clearRequest);
  const lastSaved = useRef("");
  const savingFingerprint = useRef("");
  const saveChain = useRef(Promise.resolve());
  const measurements = useRef(new Map<string, { width: number; height: number }>());
  const clipboard = useRef<ClipboardGraph | null>(null);
  const pasteCount = useRef(0);
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  const selectedEdgeIdsRef = useRef(selectedEdgeIds);
  const graphIdRef = useRef(graphId);
  const onGraphSavedRef = useRef(onGraphSaved);
  graphIdRef.current = graphId; onGraphSavedRef.current = onGraphSaved; selectedNodeIdsRef.current = selectedNodeIds; selectedEdgeIdsRef.current = selectedEdgeIds;

  const loadRun = async (target: GraphRun) => {
    setRun(target); setNodeRuns([]); setRunEvents([]);
    if (!api?.getGraphRun) return;
    const detail = await api.getGraphRun(target.id);
    if (graphIdRef.current === graphId) { setRun(detail.run); setNodeRuns(detail.nodeRuns); setRunEvents(detail.events); }
  };

  useEffect(() => {
    let mounted = true;
    setGraph(null); setRun(null); setRuns([]); setNodeRuns([]); setRunEvents([]); setRunInput({}); setSelectedNodeIds(new Set()); setSelectedEdgeIds(new Set()); setError(null);
    if (!api?.getGraph) return;
    void api.getGraph(graphId).then(async (detail) => {
      if (!mounted) return;
      const repaired = repairGraphConnections(detail.graph);
      lastSaved.current = editableFingerprint(detail.graph); setGraph(repaired);
      const inputNode = repaired.definition.nodes.find((node) => node.type === "input");
      if (inputNode?.type === "input") setRunInput(Object.fromEntries(inputNode.config.fields.map((field) => [field.id, ""])));
      const history = api.listGraphRuns ? await api.listGraphRuns(graphId) : detail.latestRun ? [detail.latestRun] : [];
      if (!mounted) return;
      setRuns(history);
      if (detail.latestRun) await loadRun(detail.latestRun);
    }).catch((cause) => { if (mounted) setError(message(cause)); });
    return () => { mounted = false; };
  }, [api, graphId]);

  useEffect(() => { if (clearRequest !== lastClearRequest.current) { lastClearRequest.current = clearRequest; if (graph) setConfirmClear(true); } }, [clearRequest, graph]);
  useEffect(() => {
    if (!graph || !api?.saveGraph || graph.id !== graphId) return;
    const fingerprint = editableFingerprint(graph);
    if (fingerprint === lastSaved.current || fingerprint === savingFingerprint.current) return;
    const draftErrors = validateGraphDraft(graph.definition);
    if (draftErrors.length) return;
    const snapshot = structuredClone(graph); const requestedGraphId = graph.id;
    const timer = setTimeout(() => {
      savingFingerprint.current = fingerprint;
      saveChain.current = saveChain.current.catch(() => undefined).then(async () => {
        const saved = await api.saveGraph!(snapshot);
        if (graphIdRef.current !== requestedGraphId) return;
        lastSaved.current = fingerprint; savingFingerprint.current = ""; onGraphSavedRef.current?.(saved); setError(null);
      }).catch((cause) => { savingFingerprint.current = ""; if (graphIdRef.current === requestedGraphId) setError(message(cause)); });
    }, 350);
    return () => clearTimeout(timer);
  }, [api, graph, graphId]);

  useEffect(() => {
    if (!api?.getGraphRun || run?.status !== "running") return;
    const timer = setInterval(() => { void api.getGraphRun!(run.id).then((detail) => { if (graphIdRef.current !== graphId) return; setRun(detail.run); setNodeRuns(detail.nodeRuns); setRunEvents(detail.events); setRuns((current) => [detail.run, ...current.filter((item) => item.id !== detail.run.id)]); }); }, 400);
    return () => clearInterval(timer);
  }, [api, graphId, run?.id, run?.status]);

  const selectedNode = graph?.definition.nodes.find((node) => selectedNodeIds.size === 1 && selectedNodeIds.has(node.id)) ?? null;
  const flowNodes = useMemo(() => graph ? toFlowNodes(graph, nodeRuns, measurements.current, selectedNodeIds, zh) : [], [graph, nodeRuns, selectedNodeIds, zh]);
  const setEdgeRoute = useCallback((edgeId: string, route: { x: number; y: number }) => setGraph((current) => current ? { ...current, definition: { ...current.definition, edges: current.definition.edges.map((edge) => edge.id === edgeId ? { ...edge, route } : edge) } } : current), []);
  const flowEdges = useMemo(() => graph ? toFlowEdges(graph, selectedEdgeIds, setEdgeRoute, zh ? "调整连线路径" : "Adjust connection path") : [], [graph, selectedEdgeIds, setEdgeRoute, zh]);
  const validation = graph ? validateGraphDefinition(graph.definition) : [];
  const validationKey = validation.join("\n");
  useEffect(() => { onValidationChange?.(validation); }, [onValidationChange, validationKey]);
  const updateGraph = (change: (current: GraphProject) => GraphProject) => setGraph((current) => current ? change(current) : current);
  const replaceSelection = (nodes: Set<string>, edges: Set<string>) => { selectedNodeIdsRef.current = nodes; selectedEdgeIdsRef.current = edges; setSelectedNodeIds(nodes); setSelectedEdgeIds(edges); };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!graph || view !== "editor" || isEditableTarget(event.target)) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "a") { event.preventDefault(); replaceSelection(new Set(graph.definition.nodes.map((node) => node.id)), new Set(graph.definition.edges.map((edge) => edge.id))); return; }
      if (command && event.key.toLowerCase() === "c") { event.preventDefault(); clipboard.current = copySelection(graph, selectedNodeIdsRef.current, selectedEdgeIdsRef.current); pasteCount.current = 0; return; }
      if (command && event.key.toLowerCase() === "x") { event.preventDefault(); clipboard.current = copySelection(graph, selectedNodeIdsRef.current, selectedEdgeIdsRef.current); updateGraph((current) => removeSelection(current, selectedNodeIdsRef.current, selectedEdgeIdsRef.current)); replaceSelection(new Set(), new Set()); return; }
      if (command && event.key.toLowerCase() === "v" && clipboard.current) { event.preventDefault(); pasteCount.current += 1; const pasted = pasteSelection(graph, clipboard.current, pasteCount.current); updateGraph(() => pasted.graph); replaceSelection(new Set(pasted.nodeIds), new Set(pasted.edgeIds)); return; }
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); updateGraph((current) => removeSelection(current, selectedNodeIdsRef.current, selectedEdgeIdsRef.current)); replaceSelection(new Set(), new Set()); }
    };
    window.addEventListener("keydown", onKeyDown); return () => window.removeEventListener("keydown", onKeyDown);
  }, [graph, selectedEdgeIds, selectedNodeIds, view]);

  const changeNodes = (changes: NodeChange[]) => {
    for (const change of changes) if (change.type === "dimensions" && change.dimensions) measurements.current.set(change.id, change.dimensions);
    const selection = changes.filter((change): change is Extract<NodeChange, { type: "select" }> => change.type === "select");
    if (selection.length) { const next = new Set(selectedNodeIdsRef.current); for (const change of selection) change.selected ? next.add(change.id) : next.delete(change.id); selectedNodeIdsRef.current = next; setSelectedNodeIds(next); }
    const positions = changes.filter((change) => change.type === "position");
    if (positions.length) updateGraph((current) => applyPositionChanges(current, positions));
  };
  const startRun = async () => {
    if (!graph || !api?.runGraph || !api.saveGraph || validation.length) { setError(validation.join(" · ")); return; }
    try {
      await saveChain.current.catch(() => undefined);
      const saved = await api.saveGraph(graph); lastSaved.current = editableFingerprint(saved); onGraphSaved?.(saved); setGraph(saved);
      const next = await api.runGraph(saved.id, runInput);
      if (graphIdRef.current !== saved.id) return;
      setRun(next); setRuns((current) => [next, ...current.filter((item) => item.id !== next.id)]); setNodeRuns([]); setRunEvents([]); setError(null);
      await loadRun(next);
    } catch (cause) { if (graphIdRef.current === graph.id) setError(message(cause)); }
  };
  const rerun = async (target: GraphRun) => {
    if (!api?.runGraph) return;
    try {
      const next = await api.runGraph(graphId, target.inputValues ?? target.input);
      if (graphIdRef.current !== graphId) return;
      setRun(next); setRuns((current) => [next, ...current.filter((item) => item.id !== next.id)]); setNodeRuns([]); setRunEvents([]); setError(null);
      await loadRun(next);
    } catch (cause) { if (graphIdRef.current === graphId) setError(message(cause)); }
  };
  const deleteRun = async (target: GraphRun) => {
    if (!api?.deleteGraphRun) return;
    try {
      await api.deleteGraphRun(target.id);
      if (graphIdRef.current !== graphId) return;
      const remaining = runs.filter((item) => item.id !== target.id);
      setRuns(remaining); setError(null);
      if (run?.id !== target.id) return;
      if (remaining[0]) await loadRun(remaining[0]);
      else { setRun(null); setNodeRuns([]); setRunEvents([]); }
    } catch (cause) { if (graphIdRef.current === graphId) setError(message(cause)); }
  };

  if (view === "runs") return <><RunHistory zh={zh} graph={graph} runs={runs} run={run} nodeRuns={nodeRuns} events={runEvents} onOpen={(item) => void loadRun(item)} onRerun={(item) => void rerun(item)} onDelete={(item) => void deleteRun(item)} canDelete={Boolean(api?.deleteGraphRun)} />{error && <div className="graph-toast graph-toast--runs" role="alert"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}</>;

  const inputNode = graph?.definition.nodes.find((node) => node.type === "input");
  return <section className="graph-canvas" data-library-open={libraryOpen} data-inspector-open={inspectorOpen} style={{ "--graph-inspector-width": `${inspectorWidth}px` } as React.CSSProperties} data-testid="graph-canvas" aria-label="Graph Canvas">
    <aside className="graph-sidebar"><header><strong>{zh ? "节点" : "Nodes"}</strong><button type="button" title={zh ? "收起节点栏" : "Collapse node library"} aria-label={zh ? "收起节点栏" : "Collapse node library"} onClick={() => setLibraryOpen(false)}>‹</button></header><div className="graph-library">{(["input", "agent", "loop_counter", "output"] as const).map((type) => <button type="button" key={type} aria-label={nodeAction(type, zh)} disabled={!graph || ((type === "input" || type === "output") && graph.definition.nodes.some((node) => node.type === type))} onClick={() => updateGraph((current) => appendNode(current, type, agents))}>{nodeIcon(type)} {nodeName(type, zh)}</button>)}</div></aside>
    {!libraryOpen && <button type="button" className="graph-panel-toggle graph-panel-toggle--left" aria-label={zh ? "展开节点栏" : "Expand node library"} onClick={() => setLibraryOpen(true)}>›</button>}
    <div className="graph-workspace">
      <div className="graph-flow" data-testid="graph-flow"><ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView minZoom={0.25} maxZoom={1.8} deleteKeyCode={null} nodesDraggable={interactionMode === "select"} nodesConnectable={interactionMode === "select"} elementsSelectable={interactionMode === "select"} selectionOnDrag={interactionMode === "select"} selectionMode={SelectionMode.Partial} panOnDrag={interactionMode === "pan"} onInit={(instance) => { flow.current = instance; }} onNodesChange={changeNodes} onNodesDelete={(nodes) => updateGraph((current) => removeSelection(current, new Set(nodes.map((node) => node.id)), new Set()))} onEdgesChange={(changes: EdgeChange[]) => { const selection = changes.filter((change): change is Extract<EdgeChange, { type: "select" }> => change.type === "select"); if (selection.length) { const next = new Set(selectedEdgeIdsRef.current); for (const change of selection) change.selected ? next.add(change.id) : next.delete(change.id); selectedEdgeIdsRef.current = next; setSelectedEdgeIds(next); } const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id)); if (removed.size) updateGraph((current) => removeSelection(current, new Set(), removed)); }} onConnect={(connection) => updateGraph((current) => connect(current, connection))} onReconnect={(_oldEdge, connection) => updateGraph((current) => reconnect(current, _oldEdge.id, connection))} edgesReconnectable onMoveEnd={(_event, viewport) => updateGraph((current) => ({ ...current, viewport }))}><Background gap={18} size={1} color="#c9d8e8" /><Controls showInteractive={false} /><div className="graph-canvas-controls"><button type="button" title={interactionMode === "select" ? (zh ? "切换到拖动画布" : "Switch to pan mode") : (zh ? "切换到选择模式" : "Switch to select mode")} aria-label={interactionMode === "select" ? (zh ? "切换到拖动画布" : "Switch to pan mode") : (zh ? "切换到选择模式" : "Switch to select mode")} data-active={interactionMode === "pan"} onClick={() => setInteractionMode((current) => current === "select" ? "pan" : "select")}>{interactionMode === "select" ? <HandIcon /> : <PointerIcon />}</button></div></ReactFlow></div>
      <div className="graph-runbar"><div className="graph-runbar__fields">{inputNode?.type === "input" ? inputNode.config.fields.map((field) => <label key={field.id}><span>{field.name}{field.required !== false ? " *" : ""}</span>{field.multiline ? <textarea aria-label={field.name} placeholder={field.description || (zh ? "输入本次运行内容…" : "Enter input for this run…")} value={runInput[field.id] ?? ""} onChange={(event) => { const value = event.currentTarget.value; setRunInput((current) => ({ ...current, [field.id]: value })); }} /> : <input aria-label={field.name} value={runInput[field.id] ?? ""} onChange={(event) => { const value = event.currentTarget.value; setRunInput((current) => ({ ...current, [field.id]: value })); }} />}</label>) : <textarea aria-label={zh ? "图输入" : "Graph input"} value={runInput.input ?? ""} onChange={(event) => setRunInput({ input: event.currentTarget.value })} />}</div><div>{run?.status === "running" && <button type="button" className="graph-stop" aria-label={zh ? "停止图" : "Stop graph"} onClick={() => { if (run && api?.cancelGraphRun) void api.cancelGraphRun(run.id).then(() => setRun((current) => current ? { ...current, status: "cancelled" } : current)); }}>■</button>}<button type="button" aria-label={zh ? "运行图" : "Run graph"} disabled={run?.status === "running" || validation.length > 0 || !hasRequiredInput(inputNode, runInput)} onClick={() => void startRun()}>▶ {zh ? "运行" : "Run"}</button></div></div>
    </div>
    {!inspectorOpen && <button type="button" className="graph-panel-toggle graph-panel-toggle--right" aria-label={zh ? "展开检查器" : "Expand inspector"} onClick={() => setInspectorOpen(true)}>‹</button>}
    <aside className="graph-inspector" aria-label={zh ? "图检查器" : "Graph inspector"}><button type="button" className="graph-inspector__resize" aria-label={zh ? "调整检查器宽度" : "Resize inspector"} onPointerDown={(event) => beginResize(event, inspectorWidth, setInspectorWidth)} />{selectedNode ? <NodeInspector node={selectedNode} agents={agents} zh={zh} latest={nodeRuns.filter((item) => item.nodeId === selectedNode.id).at(-1)} events={runEvents.filter((event) => event.nodeId === selectedNode.id)} onClose={() => replaceSelection(new Set(), new Set())} onChange={(next) => updateGraph((current) => ({ ...current, definition: { ...current.definition, nodes: current.definition.nodes.map((node) => node.id === next.id ? next : node) } }))} onDelete={() => { updateGraph((current) => removeSelection(current, new Set([selectedNode.id]), new Set())); replaceSelection(new Set(), new Set()); }} /> : <GraphInspector zh={zh} graph={graph} validation={validation} run={run} nodeRuns={nodeRuns} events={runEvents} onCollapse={() => setInspectorOpen(false)} onDescription={(description) => updateGraph((current) => ({ ...current, description }))} />}</aside>
    {error && <div className="graph-toast" role="alert"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
    {confirmClear && <div className="client-dialog"><button type="button" className="client-dialog__backdrop" aria-label={zh ? "取消清空" : "Cancel clearing"} onPointerDown={() => setConfirmClear(false)}/><div className="client-dialog__panel" role="dialog" aria-modal="true" aria-label={zh ? "清空图" : "Clear graph"}><h2>{zh ? "清空此图？" : "Clear this graph?"}</h2><p>{zh ? "将移除全部节点和连线，但保留图及其运行记录。" : "All nodes and edges will be removed. The Graph and its run history remain."}</p><div><button onClick={() => setConfirmClear(false)}>{zh ? "取消" : "Cancel"}</button><button className="danger" onClick={() => { setRun(null); setNodeRuns([]); setRunEvents([]); updateGraph((current) => ({ ...current, definition: { nodes: [], edges: [], start: [], end: [] }, positions: {} })); setConfirmClear(false); }}>{zh ? "清空" : "Clear"}</button></div></div></div>}
  </section>;
}

function GraphInspector({ zh, graph, validation, run, nodeRuns, events, onCollapse, onDescription }: { zh: boolean; graph: GraphProject | null; validation: string[]; run: GraphRun | null; nodeRuns: GraphNodeRun[]; events: GraphRunEvent[]; onCollapse(): void; onDescription(value: string): void }) {
  return <><InspectorHeader title={zh ? "图信息" : "Graph information"} label={zh ? "收起检查器" : "Collapse inspector"} onClose={onCollapse} /><label>{zh ? "描述" : "Description"}<textarea value={graph?.description ?? ""} onChange={(event) => onDescription(event.currentTarget.value)} /></label>{validation.length ? <div className="graph-errors" role="alert">{validation.map((item) => <p key={item}>{item}</p>)}</div> : <p className="graph-valid">{zh ? "图结构完整，可以运行" : "Graph is ready to run"}</p>}{run && <section className="graph-run-state"><h3>{zh ? "最近一次执行" : "Latest execution"}</h3><RunStatus run={run} zh={zh} /><div className="graph-run-summary"><span>{zh ? "节点" : "Nodes"} {new Set(nodeRuns.map((item) => item.nodeId)).size}</span><span>{zh ? "步骤" : "Steps"} {nodeRuns.length}</span><span>{zh ? "事件" : "Events"} {events.length}</span></div><EventLog events={events.filter((event) => event.type.startsWith("node_") || event.type.startsWith("run_"))} graph={graph} zh={zh} /></section>}</>;
}

function NodeInspector({ node, agents, zh, latest, events, onClose, onChange, onDelete }: { node: GraphNode; agents: AgentSettingsView[]; zh: boolean; latest?: GraphNodeRun; events: GraphRunEvent[]; onClose(): void; onChange(node: GraphNode): void; onDelete(): void }) {
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const instructionSelection = useRef<{ start: number; end: number } | null>(null);
  const availableAgents = sortAgents(agents);
  const selectedAgent = node.type === "agent" ? agents.find((agent) => agent.id === node.config.agentProductId) : undefined;
  const modelId = node.type === "agent" && selectedAgent?.catalog.models.includes(node.config.modelId ?? "") ? node.config.modelId ?? "" : "";
  const insertParameter = (port: GraphPort) => {
    if (node.type !== "agent") return;
    const textarea = instructionRef.current;
    const instruction = node.config.instruction ?? node.config.prompt ?? "";
    const start = instructionSelection.current?.start ?? instruction.length;
    const end = instructionSelection.current?.end ?? start;
    const token = `{{${port.id}}}`;
    onChange({ ...node, config: { ...node.config, instruction: `${instruction.slice(0, start)}${token}${instruction.slice(end)}` } });
    const cursor = start + token.length;
    instructionSelection.current = { start: cursor, end: cursor };
    requestAnimationFrame(() => { textarea?.focus(); textarea?.setSelectionRange(cursor, cursor); });
  };
  const rememberSelection = (textarea: HTMLTextAreaElement) => { instructionSelection.current = { start: textarea.selectionStart, end: textarea.selectionEnd }; };
  return <><InspectorHeader title={zh ? "节点设置" : "Node settings"} label={zh ? "关闭节点检查器" : "Close node inspector"} onClose={onClose} /><label>{zh ? "名称" : "Name"}<input value={node.name} onChange={(event) => { const name = event.currentTarget.value; onChange({ ...node, name }); }} /></label>{node.type === "input" && <PortEditor title={zh ? "用户输入字段" : "User input fields"} ports={node.config.fields} inputFields zh={zh} onChange={(fields) => onChange({ ...node, config: { fields: fields as GraphInputField[] } })} />}{node.type === "output" && <PortEditor title={zh ? "输出字段" : "Output fields"} ports={node.config.fields} zh={zh} onChange={(fields) => onChange({ ...node, config: { fields } })} />}{node.type === "loop_counter" && <label>{zh ? "最大迭代次数" : "Maximum iterations"}<input type="number" min="1" aria-label={zh ? "最大迭代次数" : "Maximum iterations"} value={node.config.maxIterations} onChange={(event) => onChange({ ...node, config: { maxIterations: Number(event.currentTarget.value) } })} /></label>}{node.type === "agent" && <><label>Agent<select aria-label="Agent" value={node.config.agentProductId} onChange={(event) => { const agent = availableAgents.find((item) => item.id === event.currentTarget.value); if (agent && isRunnableAgent(agent)) onChange({ ...node, config: { ...node.config, agentProductId: agent.id, modelId: agent.catalog.models[0] ?? null, permissionMode: agent.catalog.permissionModes[0] ?? "request_approval" } }); }}>{availableAgents.map((agent) => <option key={agent.id} value={agent.id} disabled={!isRunnableAgent(agent)}>{agentLabel(agent.id)}</option>)}</select></label><label>{zh ? "模型" : "Model"}<select aria-label={zh ? "模型" : "Model"} value={modelId} onChange={(event) => onChange({ ...node, config: { ...node.config, modelId: event.currentTarget.value || null } })}><option value="">{zh ? "默认" : "Default"}</option>{selectedAgent?.catalog.models.map((model) => <option key={model}>{model}</option>)}</select></label><label>{zh ? "权限模式" : "Permission mode"}<select aria-label={zh ? "权限模式" : "Permission mode"} value={node.config.permissionMode} onChange={(event) => onChange({ ...node, config: { ...node.config, permissionMode: event.currentTarget.value as PermissionMode } })}>{(selectedAgent?.catalog.permissionModes ?? [node.config.permissionMode]).map((mode) => <option key={mode} value={mode}>{permissionLabels[mode][zh ? "zh" : "en"]}</option>)}</select></label><label>{zh ? "收到输入后执行" : "Instruction"}<textarea ref={instructionRef} aria-label={zh ? "提示词" : "Instruction"} value={node.config.instruction ?? node.config.prompt ?? ""} onSelect={(event) => rememberSelection(event.currentTarget)} onChange={(event) => { rememberSelection(event.currentTarget); onChange({ ...node, config: { ...node.config, instruction: event.currentTarget.value } }); }} /></label><div className="graph-prompt-parameters"><span>{zh ? "插入参数" : "Insert parameter"}</span><div>{(node.config.inputs ?? [{ id: "input", name: zh ? "输入" : "Input", required: true }]).map((port) => <button type="button" key={port.id} title={`{{${port.id}}}`} aria-label={`${zh ? "插入" : "Insert"} ${port.name} ${zh ? "参数" : "parameter"}`} onClick={() => insertParameter(port)}>＋ {port.name}</button>)}</div></div><PortEditor title={zh ? "输入端口" : "Input ports"} ports={node.config.inputs ?? [{ id: "input", name: zh ? "输入" : "Input", required: true }]} allowFeedback zh={zh} onChange={(inputs) => onChange({ ...node, config: { ...node.config, inputs } })} /><PortEditor title={zh ? "输出端口" : "Output ports"} ports={node.config.outputs ?? [{ id: "output", name: zh ? "输出" : "Output" }]} zh={zh} onChange={(outputs) => onChange({ ...node, config: { ...node.config, outputs } })} /></>}{latest && <section className="graph-node-run"><h3>{zh ? "最近一次运行" : "Latest node run"}</h3><span data-status={latest.status}>{statusLabel(latest.status, zh)}</span><Values title={zh ? "输入" : "Input"} values={latest.inputValues ?? { input: latest.input }} /><Values title={zh ? "输出" : "Output"} values={latest.outputValues ?? (latest.output !== null ? { output: latest.output } : {})} /><EventLog events={events} graph={null} zh={zh} /></section>}{node.type !== "input" && node.type !== "output" && <button type="button" className="graph-inspector__delete" aria-label={zh ? "删除节点" : "Delete node"} onClick={onDelete}>{zh ? "删除节点" : "Delete node"}</button>}</>;
}

function PortEditor({ title, ports, zh, inputFields = false, allowFeedback = false, onChange }: { title: string; ports: GraphPort[]; zh: boolean; inputFields?: boolean; allowFeedback?: boolean; onChange(ports: GraphPort[]): void }) {
  const add = () => { const index = ports.length + 1; onChange([...ports, inputFields ? { id: `input_${index}`, name: `${zh ? "输入" : "Input"} ${index}`, description: "", multiline: true } as GraphInputField : { id: `port_${index}`, name: `${zh ? "端口" : "Port"} ${index}` }]); };
  return <section className="graph-ports-editor"><header><span>{title}</span><button type="button" aria-label={`${zh ? "添加" : "Add"} ${title}`} onClick={add}>＋</button></header>{ports.map((port, index) => <div key={`${port.id}-${index}`}><input aria-label={`${title} ${index + 1}`} value={port.name} onChange={(event) => { const name = event.currentTarget.value; onChange(ports.map((item, itemIndex) => itemIndex === index ? { ...item, name } : item)); }} />{allowFeedback ? <select aria-label={`${port.name} ${zh ? "类型" : "type"}`} value={port.kind ?? "input"} onChange={(event) => onChange(ports.map((item, itemIndex) => itemIndex === index ? { ...item, kind: event.currentTarget.value as "input" | "feedback" } : item))}><option value="input">{zh ? "普通输入" : "Input"}</option><option value="feedback">{zh ? "循环输入" : "Loop input"}</option></select> : <span className="graph-port-type">{inputFields ? (zh ? "用户输入" : "User input") : (zh ? "输出" : "Output")}</span>}<button type="button" aria-label={`${zh ? "删除" : "Remove"} ${port.name}`} disabled={ports.length === 1} onClick={() => onChange(ports.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}</section>;
}

function RunHistory({ zh, graph, runs, run, nodeRuns, events, onOpen, onRerun, onDelete, canDelete }: { zh: boolean; graph: GraphProject | null; runs: GraphRun[]; run: GraphRun | null; nodeRuns: GraphNodeRun[]; events: GraphRunEvent[]; onOpen(run: GraphRun): void; onRerun(run: GraphRun): void; onDelete(run: GraphRun): void; canDelete: boolean }) {
  const snapshot = run?.graphSnapshot;
  const [snapshotNodeId, setSnapshotNodeId] = useState<string | null>(null);
  const [tab, setTab] = useState<"details" | "trajectory">("details");
  const [pendingDelete, setPendingDelete] = useState<GraphRun | null>(null);
  const snapshotNode = snapshot?.definition.nodes.find((node) => node.id === snapshotNodeId);
  const selectedRuns = snapshotNodeId ? nodeRuns.filter((item) => item.nodeId === snapshotNodeId) : [];
  const busy = runs.some((item) => item.status === "running");
  return <section className="graph-run-view" data-testid="graph-canvas" aria-label={zh ? "最近运行" : "Recent runs"}><aside><h2>{zh ? "最近运行" : "Recent runs"}</h2>{runs.length ? runs.map((item) => <div className="graph-run-row" key={item.id} data-active={item.id === run?.id}><button type="button" className="graph-run-row__open" aria-label={`Run ${item.id}`} onClick={() => { setSnapshotNodeId(null); setTab("details"); onOpen(item); }}><RunStatus run={item} zh={zh} /><p>{item.input}</p></button><div className="graph-run-row__actions"><button type="button" aria-label={`${zh ? "重新运行" : "Rerun"} ${item.id}`} data-tooltip={zh ? "重新运行" : "Rerun"} disabled={busy} onClick={() => onRerun(item)}>↻</button><button type="button" className="danger" aria-label={`${zh ? "删除" : "Delete"} ${item.id}`} data-tooltip={zh ? "删除" : "Delete"} disabled={!canDelete || item.status === "running"} onClick={() => setPendingDelete(item)}>×</button></div></div>) : <p>{zh ? "暂无运行" : "No runs yet"}</p>}</aside><main><div className="graph-run-view__tabs" role="tablist"><button type="button" role="tab" aria-selected={tab === "details"} onClick={() => setTab("details")}>{zh ? "运行详情" : "Run details"}</button><button type="button" role="tab" aria-selected={tab === "trajectory"} onClick={() => setTab("trajectory")}>{zh ? "轨迹" : "Trajectory"}</button></div>{run ? tab === "trajectory" ? <TrajectoryCanvas language={zh ? "zh" : "en"} events={graphTrajectoryEvents(run, events, graph)} /> : <>{snapshot ? <RunSnapshot snapshot={snapshot} nodeRuns={nodeRuns} selectedNodeId={snapshotNodeId} onSelectNode={setSnapshotNodeId} zh={zh} /> : null}<div className="graph-run-view__details">{snapshotNode ? <section className="graph-run-detail"><h3>{snapshotNode.name}</h3>{selectedRuns.map((item) => <div key={item.id}><span>{zh ? `第 ${item.iteration} 次` : `Iteration ${item.iteration}`}</span><NodeRunValues node={snapshotNode} run={item} zh={zh} /></div>)}</section> : <><Values title={zh ? "用户输入" : "User input"} values={run.inputValues ?? { input: run.input }} /><Values title={zh ? "最终输出" : "Final output"} values={run.outputValues ?? (run.output ? { output: run.output } : {})} /></>}</div></> : <div className="graph-run-view__empty">{zh ? "选择一次运行查看详情" : "Select a run to inspect it"}</div>}</main>{pendingDelete && <div className="client-dialog"><button type="button" className="client-dialog__backdrop" aria-label={zh ? "取消删除" : "Cancel deletion"} onPointerDown={() => setPendingDelete(null)}/><div className="client-dialog__panel" role="dialog" aria-modal="true" aria-label={zh ? "删除运行" : "Delete run"}><h2>{zh ? "删除这次运行？" : "Delete this run?"}</h2><p>{zh ? "将删除本次运行详情与轨迹，此操作无法撤销。" : "This removes the run details and trajectory. This cannot be undone."}</p><div><button type="button" onClick={() => setPendingDelete(null)}>{zh ? "取消" : "Cancel"}</button><button type="button" className="danger" aria-label={zh ? "确认删除运行" : "Confirm run deletion"} onClick={() => { const target = pendingDelete; setPendingDelete(null); onDelete(target); }}>{zh ? "删除" : "Delete"}</button></div></div></div>}</section>;
}

function graphTrajectoryEvents(run: GraphRun, events: GraphRunEvent[], graph: GraphProject | null): NormalizedEvent[] {
  return events.map((event) => {
    const nodeName = event.nodeId ? graph?.definition.nodes.find((node) => node.id === event.nodeId)?.name ?? event.nodeId : null;
    const iteration = typeof event.payload.iteration === "number" ? event.payload.iteration : 1;
    const status = event.type.endsWith("completed") ? "completed" : event.type.endsWith("failed") ? "failed" : "running";
    const type: NormalizedEvent["type"] = event.type.startsWith("node_") ? "tool" : event.type.endsWith("failed") ? "warning" : "turn_status";
    const summary = nodeName ? `${nodeName} · ${status}` : status;
    return { id: event.id, conversationId: run.id, sequence: event.sequence, type, payload: { ...event.payload, id: event.nodeId ? `${event.nodeId}:${iteration}` : event.id, name: nodeName ?? undefined, status, summary }, createdAt: event.createdAt };
  });
}

function RunSnapshot({ snapshot, nodeRuns, selectedNodeId, onSelectNode, zh }: { snapshot: NonNullable<GraphRun["graphSnapshot"]>; nodeRuns: GraphNodeRun[]; selectedNodeId: string | null; onSelectNode(id: string): void; zh: boolean }) {
  const selected = selectedNodeId ? new Set([selectedNodeId]) : new Set<string>();
  return <div className="graph-run-snapshot" aria-label={zh ? "运行快照" : "Run snapshot"}><ReactFlow nodes={toFlowNodes(snapshot, nodeRuns, new Map(), selected, zh)} edges={toFlowEdges(snapshot, new Set())} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.2} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} elementsSelectable panOnDrag onNodeClick={(_event, node) => onSelectNode(node.id)}><Background gap={18} size={1} color="#c9d8e8" /><Controls showInteractive={false} /></ReactFlow></div>;
}
function NodeRunValues({ node, run, zh }: { node: GraphNode; run: GraphNodeRun; zh: boolean }) {
  if (node.type !== "agent") return <Values title={zh ? "内容" : "Content"} values={run.outputValues ?? run.inputValues ?? (run.output !== null ? { content: run.output } : { content: run.input })} />;
  return <><Values title={zh ? "输入" : "Input"} values={run.inputValues ?? { input: run.input }} /><Values title={zh ? "输出" : "Output"} values={run.outputValues ?? (run.output !== null ? { output: run.output } : {})} /></>;
}

function InspectorHeader({ title, label, onClose }: { title: string; label: string; onClose(): void }) { return <header className="graph-inspector__header"><h3>{title}</h3><button type="button" aria-label={label} title={label} onClick={onClose}>×</button></header>; }
function Values({ title, values }: { title: string; values: GraphValues }) { return <section className="graph-values"><h4>{title}</h4>{Object.entries(values).length ? Object.entries(values).map(([key, value]) => <div key={key}><strong>{key}</strong><Markdown options={{ disableParsingRawHTML: true }}>{value}</Markdown></div>) : <p>—</p>}</section>; }
function EventLog({ events, graph, zh }: { events: GraphRunEvent[]; graph: GraphProject | null; zh: boolean }) { return events.length ? <ol className="graph-event-log" role="log" aria-label={zh ? "运行事件" : "Run events"}>{events.map((event) => <li key={event.id}><span className="graph-event-log__dot"/><div><code>{eventLabel(event.type, zh)}</code>{event.nodeId ? <span>{graph?.definition.nodes.find((node) => node.id === event.nodeId)?.name ?? event.nodeId}</span> : null}</div></li>)}</ol> : null; }
function RunStatus({ run, zh }: { run: GraphRun; zh: boolean }) { return <span className="graph-status" data-status={run.status}>{statusLabel(run.status, zh)}</span>; }
function statusLabel(status: string, zh: boolean): string { const labels: Record<string, [string, string]> = { running: ["运行中", "Running"], completed: ["已完成", "Completed"], failed: ["失败", "Failed"], cancelled: ["已取消", "Cancelled"], interrupted: ["已中断", "Interrupted"] }; return labels[status]?.[zh ? 0 : 1] ?? status; }
function eventLabel(type: string, zh: boolean): string { const labels: Record<string, [string, string]> = { run_started: ["开始运行", "Run started"], run_completed: ["运行完成", "Run completed"], run_failed: ["运行失败", "Run failed"], node_started: ["节点开始", "Node started"], node_completed: ["节点完成", "Node completed"] }; return labels[type]?.[zh ? 0 : 1] ?? type.replaceAll("_", " "); }

export function defaultGraph(agents: AgentSettingsView[] = []): Omit<GraphProject, "id" | "projectId" | "createdAt" | "updatedAt"> {
  const agent = sortAgents(agents.filter(isRunnableAgent))[0];
  return { name: "Untitled graph", description: "", definition: { nodes: [{ id: "input-1", type: "input", name: "User Input", config: { fields: [{ id: "task", name: "Task", description: "Describe what the Agent should do", required: true, multiline: true }] } }, { id: "agent-1", type: "agent", name: "Agent 1", config: { agentProductId: agent?.id ?? "codex", modelId: agent?.catalog.models[0] ?? null, permissionMode: agent?.catalog.permissionModes[0] ?? "request_approval", instruction: "Complete the task and return the result.", inputs: [{ id: "task", name: "Task", required: true }], outputs: [{ id: "result", name: "Result" }] } }, { id: "output-1", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } }], edges: [{ id: "input-agent", source: "input-1", sourcePort: "task", target: "agent-1", targetPort: "task" }, { id: "agent-output", source: "agent-1", sourcePort: "result", target: "output-1", targetPort: "result" }], start: ["input-1"], end: ["output-1"] }, viewport: { x: 0, y: 0, zoom: 1 }, positions: { "input-1": { x: 80, y: 180 }, "agent-1": { x: 350, y: 180 }, "output-1": { x: 640, y: 180 } } };
}

function toFlowNodes(graph: Pick<GraphProject, "definition" | "positions">, nodeRuns: GraphNodeRun[], measurements: Map<string, { width: number; height: number }>, selected: Set<string>, zh = false): Node<GraphNodeData>[] { return graph.definition.nodes.map((node, index) => ({ id: node.id, type: "workflow", position: graph.positions[node.id] ?? { x: 100 + index * 250, y: 180 }, measured: measurements.get(node.id), selected: selected.has(node.id), data: { kind: node.type, label: node.name, subtitle: node.type === "agent" ? agentLabel(node.config.agentProductId) : node.type === "loop_counter" ? `× ${node.config.maxIterations}` : undefined, inputs: nodeInputs(node, zh), outputs: nodeOutputs(node, zh), status: nodeRuns.findLast((item) => item.nodeId === node.id)?.status } })); }
function toFlowEdges(graph: Pick<GraphProject, "definition">, selected: Set<string>, onRoute?: RoutableEdgeData["onRoute"], routeLabel?: string): Edge<RoutableEdgeData>[] { return graph.definition.edges.map((edge) => ({ ...edge, sourceHandle: edge.sourcePort, targetHandle: edge.targetPort, label: edge.condition?.branch, type: "routable", reconnectable: Boolean(onRoute), selected: selected.has(edge.id), data: { route: edge.route, routeLabel, onRoute }, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: selected.has(edge.id) ? "#4f83d1" : "#8fa8bf", strokeWidth: selected.has(edge.id) ? 2 : 1.4 } })); }
function displayPorts(ports: GraphPort[], zh: boolean): GraphPort[] { return ports.length === 1 ? [{ ...ports[0]!, name: zh ? "内容" : "Content" }] : ports; }
function nodeInputs(node: GraphNode, zh = false): GraphPort[] { if (node.type === "agent") return node.config.inputs ?? [{ id: "input", name: "Input", required: true }]; if (node.type === "output") return displayPorts(node.config.fields, zh); if (node.type === "loop_counter") return [{ id: "input", name: zh ? "内容" : "Content", required: true }]; if (node.type === "literal" || node.type === "template" || node.type === "passthrough") return [{ id: "input", name: zh ? "内容" : "Content" }]; return []; }
function nodeOutputs(node: GraphNode, zh = false): GraphPort[] { if (node.type === "agent") return node.config.outputs ?? [{ id: "output", name: "Output" }]; if (node.type === "input") return displayPorts(node.config.fields, zh); if (node.type === "loop_counter") return [{ id: "loop", name: zh ? "循环" : "Loop" }, { id: "done", name: zh ? "完成" : "Done" }]; if (node.type === "literal" || node.type === "template" || node.type === "passthrough") return [{ id: "output", name: zh ? "内容" : "Content" }]; return []; }
function appendNode(graph: GraphProject, type: "input" | "agent" | "loop_counter" | "output", agents: AgentSettingsView[]): GraphProject { const count = graph.definition.nodes.filter((node) => node.type === type).length + 1; const id = `${type}-${crypto.randomUUID()}`; const agent = sortAgents(agents.filter(isRunnableAgent))[0]; const node: GraphNode = type === "input" ? { id, type, name: `Input ${count}`, config: { fields: [{ id: "input", name: "Input", description: "", required: true, multiline: true }] } } : type === "output" ? { id, type, name: `Output ${count}`, config: { fields: [{ id: "output", name: "Output", required: true }] } } : type === "loop_counter" ? { id, type, name: `Loop ${count}`, config: { maxIterations: 3 } } : { id, type, name: `Agent ${count}`, config: { agentProductId: agent?.id ?? "codex", modelId: agent?.catalog.models[0] ?? null, permissionMode: agent?.catalog.permissionModes[0] ?? "request_approval", instruction: "", inputs: [{ id: "input", name: "Input", required: true }], outputs: [{ id: "output", name: "Output" }] } }; const definition = { ...graph.definition, nodes: [...graph.definition.nodes, node], ...(type === "input" ? { start: [id] } : {}), ...(type === "output" ? { end: [id] } : {}) }; return { ...graph, definition, positions: { ...graph.positions, [id]: { x: 180 + graph.definition.nodes.length * 220, y: 260 } } }; }
function applyPositionChanges(graph: GraphProject, changes: NodeChange[]): GraphProject { const nodes = applyNodeChanges(changes, toFlowNodes(graph, [], new Map(), new Set())); const positions = { ...graph.positions }; for (const node of nodes) positions[node.id] = node.position; return { ...graph, positions }; }
function repairGraphConnections(graph: GraphProject): GraphProject {
  const nodes = new Map(graph.definition.nodes.map((node) => [node.id, node]));
  let changed = false;
  const repaired = graph.definition.edges.map((edge) => {
    const source = nodes.get(edge.source); const target = nodes.get(edge.target);
    const outputs = source ? nodeOutputs(source) : []; const inputs = target ? nodeInputs(target) : [];
    let sourcePort = edge.sourcePort; let targetPort = edge.targetPort;
    if (!outputs.some((port) => port.id === sourcePort)) {
      if (source?.type === "loop_counter" && edge.condition?.branch) sourcePort = edge.condition.branch;
      else if (outputs.length === 1) sourcePort = outputs[0]!.id;
    }
    if (!inputs.some((port) => port.id === targetPort)) {
      const candidates = target?.type === "agent" ? inputs.filter((port) => edge.condition?.branch === "loop" ? port.kind === "feedback" : port.kind !== "feedback") : inputs;
      if (candidates.length === 1) targetPort = candidates[0]!.id;
    }
    if (sourcePort === edge.sourcePort && targetPort === edge.targetPort) return edge;
    changed = true;
    return { ...edge, sourcePort, targetPort };
  });
  const lastIncoming = new Map<string, number>();
  repaired.forEach((edge, index) => { if (edge.targetPort) lastIncoming.set(`${edge.target}:${edge.targetPort}`, index); });
  const edges = repaired.filter((edge, index) => !edge.targetPort || lastIncoming.get(`${edge.target}:${edge.targetPort}`) === index);
  if (edges.length !== repaired.length) changed = true;
  return changed ? { ...graph, definition: { ...graph.definition, edges } } : graph;
}
function connect(graph: GraphProject, connection: Connection): GraphProject { if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return graph; const source = graph.definition.nodes.find((node) => node.id === connection.source); const branch = connection.sourceHandle === "loop" || connection.sourceHandle === "done" ? connection.sourceHandle : null; const condition: GraphDefinition["edges"][number]["condition"] = source?.type === "loop_counter" && branch ? { branch } : undefined; const edge: GraphDefinition["edges"][number] = { id: crypto.randomUUID(), source: connection.source, sourcePort: connection.sourceHandle, target: connection.target, targetPort: connection.targetHandle, ...(condition ? { condition } : {}) }; const edges = graph.definition.edges.filter((item) => item.target !== edge.target || item.targetPort !== edge.targetPort); return { ...graph, definition: { ...graph.definition, edges: [...edges, edge] } }; }
function reconnect(graph: GraphProject, edgeId: string, connection: Connection): GraphProject { if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return graph; const without = { ...graph, definition: { ...graph.definition, edges: graph.definition.edges.filter((edge) => edge.id !== edgeId) } }; return connect(without, connection); }
function removeSelection(graph: GraphProject, nodeIds: Set<string>, edgeIds: Set<string>): GraphProject { return { ...graph, definition: { ...graph.definition, nodes: graph.definition.nodes.filter((node) => !nodeIds.has(node.id)), edges: graph.definition.edges.filter((edge) => !edgeIds.has(edge.id) && !nodeIds.has(edge.source) && !nodeIds.has(edge.target)), start: graph.definition.start.filter((id) => !nodeIds.has(id)), end: graph.definition.end.filter((id) => !nodeIds.has(id)) }, positions: Object.fromEntries(Object.entries(graph.positions).filter(([id]) => !nodeIds.has(id))) }; }
function copySelection(graph: GraphProject, nodeIds: Set<string>, edgeIds: Set<string>): ClipboardGraph { const ids = nodeIds.size ? nodeIds : new Set<string>(); return { nodes: structuredClone(graph.definition.nodes.filter((node) => ids.has(node.id))), edges: structuredClone(graph.definition.edges.filter((edge) => edgeIds.has(edge.id) || (ids.has(edge.source) && ids.has(edge.target)))), positions: structuredClone(Object.fromEntries(Object.entries(graph.positions).filter(([id]) => ids.has(id)))) }; }
function pasteSelection(graph: GraphProject, copied: ClipboardGraph, count: number): { graph: GraphProject; nodeIds: string[]; edgeIds: string[] } { const idMap = new Map(copied.nodes.map((node) => [node.id, crypto.randomUUID()])); const nodes = copied.nodes.filter((node) => node.type !== "input" && node.type !== "output").map((node) => ({ ...structuredClone(node), id: idMap.get(node.id)!, name: `${node.name} copy` })); const edges = copied.edges.filter((edge) => nodes.some((node) => node.id === idMap.get(edge.source)) && nodes.some((node) => node.id === idMap.get(edge.target))).map((edge) => ({ ...edge, id: crypto.randomUUID(), source: idMap.get(edge.source)!, target: idMap.get(edge.target)! })); const positions = Object.fromEntries(nodes.map((node) => { const original = [...idMap].find(([, id]) => id === node.id)![0]; const position = copied.positions[original] ?? { x: 0, y: 0 }; return [node.id, { x: position.x + 32 * count, y: position.y + 32 * count }]; })); return { graph: { ...graph, definition: { ...graph.definition, nodes: [...graph.definition.nodes, ...nodes], edges: [...graph.definition.edges, ...edges] }, positions: { ...graph.positions, ...positions } }, nodeIds: nodes.map((node) => node.id), edgeIds: edges.map((edge) => edge.id) }; }
function beginResize(event: React.PointerEvent, width: number, setWidth: (width: number) => void) { event.currentTarget.setPointerCapture?.(event.pointerId); const start = event.clientX; const move = (next: PointerEvent) => setWidth(Math.min(520, Math.max(240, width + start - next.clientX))); const up = (next: PointerEvent) => { const value = Math.min(520, Math.max(240, width + start - next.clientX)); globalThis.localStorage?.setItem("ain-one.graph.inspector-width", String(value)); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); }
function hasRequiredInput(node: GraphNode | undefined, values: GraphValues): boolean { return node?.type === "input" ? node.config.fields.every((field) => field.required === false || Boolean(values[field.id]?.trim())) : Boolean(values.input?.trim()); }
function isEditableTarget(target: EventTarget | null): boolean { return target instanceof HTMLElement && (target.matches("input, textarea, select, [contenteditable='true']") || Boolean(target.closest("input, textarea, select, [contenteditable='true']"))); }
function nodeAction(type: "input" | "agent" | "loop_counter" | "output", zh: boolean): string { const labels = { input: ["添加输入", "Add Input"], agent: ["添加 Agent", "Add Agent"], loop_counter: ["添加循环", "Add Loop"], output: ["添加输出", "Add Output"] } as const; return labels[type][zh ? 0 : 1]; }
function nodeName(type: "input" | "agent" | "loop_counter" | "output", zh: boolean): string { const labels = { input: ["用户输入", "User Input"], agent: ["Agent", "Agent"], loop_counter: ["循环", "Loop"], output: ["输出", "Output"] } as const; return labels[type][zh ? 0 : 1]; }
function nodeIcon(type: GraphNode["type"]): string { return type === "input" ? "↳" : type === "agent" ? "✦" : type === "loop_counter" ? "↻" : "↗"; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isRunnableAgent(agent: AgentSettingsView): boolean { return agent.enabled !== false && agent.status !== "not_installed" && agent.status !== "runtime_error" && agent.status !== "version_unsupported"; }
function editableFingerprint(graph: GraphProject): string { return JSON.stringify([graph.name, graph.description, graph.definition, graph.viewport, graph.positions]); }
function HandIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 9V5.5a1.2 1.2 0 0 1 2.4 0V8m0-3.5a1.2 1.2 0 0 1 2.4 0V8m0-2.5a1.2 1.2 0 0 1 2.4 0V9m0-1.5a1.2 1.2 0 0 1 2.4 0v4c0 3-2 5-5 5H9c-2 0-3.1-.8-4.1-2.2L2.8 12a1.2 1.2 0 0 1 1.9-1.5L6.5 12Z" /></svg>; }
function PointerIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3l10 8-5 .8-2.4 4.5Z" /></svg>; }
