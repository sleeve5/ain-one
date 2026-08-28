import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "markdown-to-jsx";
import { applyNodeChanges, Background, BaseEdge, ControlButton, Controls, MarkerType, ReactFlow, SelectionMode, useReactFlow, type Connection, type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphDefinition, GraphInputField, GraphNode, GraphNodeRun, GraphPort, GraphProject, GraphRun, GraphRunEvent, GraphValues, PermissionMode } from "../../shared/contracts.js";
import { validateGraphDefinition, validateGraphDraft } from "../../shared/validation.js";
import type { AinOneApi, AgentSettingsView } from "../api.js";
import { agentLabel, sortAgents } from "../agent-meta.js";
import { autoLayoutGraph, parseGraphConfig, serializeGraphConfig } from "../graph-config.js";
import { GRAPH_NODE_HEADER_HEIGHT, GRAPH_NODE_PORT_HEIGHT, GRAPH_NODE_PORT_PADDING, GRAPH_NODE_WIDTH, GraphNodeView, type GraphNodeData } from "./graph-node.js";
import { GraphTrajectory } from "./graph-trajectory.js";

interface GraphCanvasProps { language?: "zh" | "en"; api?: AinOneApi; graphId: string; agents?: AgentSettingsView[]; view?: "editor" | "runs"; clearRequest?: number; configRequest?: number; onGraphSaved?(graph: GraphProject): void; onValidationChange?(errors: string[]): void; }
interface ClipboardGraph { nodes: GraphNode[]; edges: GraphDefinition["edges"]; positions: GraphProject["positions"]; }
interface EdgeRoute { x: number; y: number; targetX?: number; }
interface RoutableEdgeData extends Record<string, unknown> { route?: EdgeRoute; automaticRoute?: EdgeRoute; routeLabel?: string; onRoute?(edgeId: string, route: EdgeRoute): void; }
const nodeTypes = { workflow: GraphNodeView };
const edgeTypes = { routable: RoutableEdge };
const permissionLabels: Record<PermissionMode, { zh: string; en: string }> = { request_approval: { zh: "需要审批", en: "Ask for approval" }, help_me_approve: { zh: "自动审批", en: "Auto approve" }, full_access: { zh: "完全访问", en: "Full access" } };

function RoutableEdge({ id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, markerEnd, label, style, selected, data }: EdgeProps<Edge<RoutableEdgeData>>) {
  const { screenToFlowPosition } = useReactFlow();
  void sourcePosition; void targetPosition;
  const route = normalizeRoute(data?.route ?? data?.automaticRoute, sourceX, sourceY, targetX, targetY);
  const path = data?.route || data?.automaticRoute ? roundedOrthogonalPath({ sourceX, sourceY, targetX, targetY, route }) : automaticOrthogonalPath({ sourceX, sourceY, targetX, targetY });
  const targetRouteX = route.targetX ?? targetX - 48;
  const beginRoute = (axis: "source" | "middle" | "target", event: React.PointerEvent<SVGPathElement>) => {
    event.stopPropagation();
    const move = (next: PointerEvent) => { const point = screenToFlowPosition({ x: next.clientX, y: next.clientY }); data?.onRoute?.(id, axis === "source" ? { ...route, x: point.x } : axis === "target" ? { ...route, targetX: point.x } : { ...route, y: point.y }); };
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end);
  };
  return <><BaseEdge id={id} path={path} markerEnd={markerEnd} label={label} labelX={(route.x + targetRouteX) / 2} labelY={route.y} style={style} />{selected && data?.onRoute ? <g className="graph-edge-routes"><path className="graph-edge-segment graph-edge-segment--source" role="button" tabIndex={0} aria-label={`${data.routeLabel} 1`} d={`M ${route.x} ${sourceY} L ${route.x} ${route.y}`} onPointerDown={(event) => beginRoute("source", event)} /><path className="graph-edge-segment graph-edge-segment--middle" role="button" tabIndex={0} aria-label={`${data.routeLabel} 2`} d={`M ${route.x} ${route.y} L ${targetRouteX} ${route.y}`} onPointerDown={(event) => beginRoute("middle", event)} /><path className="graph-edge-segment graph-edge-segment--target" role="button" tabIndex={0} aria-label={`${data.routeLabel} 3`} d={`M ${targetRouteX} ${route.y} L ${targetRouteX} ${targetY}`} onPointerDown={(event) => beginRoute("target", event)} /></g> : null}</>;
}

export function roundedOrthogonalPath({ sourceX, sourceY, targetX, targetY, route }: { sourceX: number; sourceY: number; targetX: number; targetY: number; route: EdgeRoute }): string {
  const endX = route.targetX ?? targetX - 48;
  return roundedPolyline([{ x: sourceX, y: sourceY }, { x: route.x, y: sourceY }, { x: route.x, y: route.y }, { x: endX, y: route.y }, { x: endX, y: targetY }, { x: targetX, y: targetY }]);
}
export function automaticOrthogonalPath({ sourceX, sourceY, targetX, targetY }: { sourceX: number; sourceY: number; targetX: number; targetY: number }): string {
  if (Math.abs(sourceY - targetY) < 0.5) return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  const middleX = (sourceX + targetX) / 2;
  return roundedPolyline([{ x: sourceX, y: sourceY }, { x: middleX, y: sourceY }, { x: middleX, y: targetY }, { x: targetX, y: targetY }]);
}
function normalizeRoute(route: EdgeRoute | undefined, sourceX: number, sourceY: number, targetX: number, targetY: number): EdgeRoute { const span = targetX - sourceX; return route ?? { x: sourceX + span * 0.25, y: span >= 0 ? (sourceY + targetY) / 2 : Math.max(sourceY, targetY) + 96, targetX: targetX - span * 0.25 }; }
function roundedPolyline(points: Array<{ x: number; y: number }>, radius = 10): string { const compact = points.filter((point, index) => index === 0 || point.x !== points[index - 1]!.x || point.y !== points[index - 1]!.y); if (compact.length < 2) return ""; let path = `M ${compact[0]!.x} ${compact[0]!.y}`; for (let index = 1; index < compact.length - 1; index++) { const previous = compact[index - 1]!; const corner = compact[index]!; const next = compact[index + 1]!; const incoming = Math.hypot(corner.x - previous.x, corner.y - previous.y); const outgoing = Math.hypot(next.x - corner.x, next.y - corner.y); const curve = Math.min(radius, incoming / 2, outgoing / 2); const before = { x: corner.x - Math.sign(corner.x - previous.x) * curve, y: corner.y - Math.sign(corner.y - previous.y) * curve }; const after = { x: corner.x + Math.sign(next.x - corner.x) * curve, y: corner.y + Math.sign(next.y - corner.y) * curve }; path += ` L ${before.x} ${before.y} Q ${corner.x} ${corner.y} ${after.x} ${after.y}`; } const last = compact.at(-1)!; return `${path} L ${last.x} ${last.y}`; }

export function GraphCanvas({ language = "en", api, graphId, agents = [], view = "editor", clearRequest = 0, configRequest = 0, onGraphSaved, onValidationChange }: GraphCanvasProps) {
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
  const [configDraft, setConfigDraft] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [interactionMode, setInteractionMode] = useState<"select" | "pan">("select");
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorWidth, setInspectorWidth] = useState(() => Number(globalThis.localStorage?.getItem("ain-one.graph.inspector-width")) || 300);
  const flow = useRef<ReactFlowInstance<Node<GraphNodeData>, Edge> | null>(null);
  const lastClearRequest = useRef(clearRequest);
  const lastConfigRequest = useRef(configRequest);
  const lastSaved = useRef("");
  const savingFingerprint = useRef("");
  const saveChain = useRef(Promise.resolve());
  const measurements = useRef(new Map<string, { width: number; height: number }>());
  const clipboard = useRef<ClipboardGraph | null>(null);
  const pasteCount = useRef(0);
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  const selectedEdgeIdsRef = useRef(selectedEdgeIds);
  const graphIdRef = useRef(graphId);
  const runLoad = useRef(0);
  const onGraphSavedRef = useRef(onGraphSaved);
  graphIdRef.current = graphId; onGraphSavedRef.current = onGraphSaved; selectedNodeIdsRef.current = selectedNodeIds; selectedEdgeIdsRef.current = selectedEdgeIds;

  const loadRun = async (target: GraphRun) => {
    const request = ++runLoad.current;
    setRun(target); setNodeRuns([]); setRunEvents([]);
    if (!api?.getGraphRun) return;
    const detail = await api.getGraphRun(target.id);
    if (graphIdRef.current === graphId && runLoad.current === request) { setRun(detail.run); setNodeRuns(detail.nodeRuns); setRunEvents(detail.events); }
  };

  useEffect(() => {
    let mounted = true;
    runLoad.current += 1;
    setGraph(null); setRun(null); setRuns([]); setNodeRuns([]); setRunEvents([]); setRunInput({}); setSelectedNodeIds(new Set()); setSelectedEdgeIds(new Set()); setError(null);
    if (!api?.getGraph) return;
    void api.getGraph(graphId).then(async (detail) => {
      if (!mounted) return;
      const repaired = repairGraphConnections(detail.graph);
      lastSaved.current = editableFingerprint(detail.graph); setGraph(repaired);
      requestAnimationFrame(() => fitGraph(flow.current, repaired));
      const inputNode = repaired.definition.nodes.find((node) => node.type === "input");
      if (inputNode?.type === "input") setRunInput(Object.fromEntries(inputNode.config.fields.map((field) => [field.id, ""])));
      const history = api.listGraphRuns ? await api.listGraphRuns(graphId) : detail.latestRun ? [detail.latestRun] : [];
      if (!mounted) return;
      setRuns(history);
      if (detail.latestRun) await loadRun(detail.latestRun);
    }).catch((cause) => { if (mounted) setError(message(cause)); });
    return () => { mounted = false; };
  }, [api, graphId]);

  useEffect(() => { if (graph && clearRequest !== lastClearRequest.current) { lastClearRequest.current = clearRequest; setConfirmClear(true); } }, [clearRequest, graph]);
  useEffect(() => { if (graph && configRequest !== lastConfigRequest.current) { lastConfigRequest.current = configRequest; setConfigDraft(serializeGraphConfig(graph)); setConfigError(null); } }, [configRequest, graph]);
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
  const flowNodes = useMemo(() => graph ? toFlowNodes(graph, nodeRuns, measurements.current, selectedNodeIds, zh, run?.status) : [], [graph, nodeRuns, selectedNodeIds, zh, run?.status]);
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
    <aside className="graph-sidebar"><header><strong>{zh ? "节点" : "Nodes"}</strong><button type="button" title={zh ? "收起节点栏" : "Collapse node library"} aria-label={zh ? "收起节点栏" : "Collapse node library"} onClick={() => setLibraryOpen(false)}>‹</button></header><div className="graph-library">{(["input", "agent", "loop_counter", "output"] as const).map((type) => <button type="button" key={type} aria-label={nodeAction(type, zh)} disabled={!graph || ((type === "input" || type === "output") && graph.definition.nodes.some((node) => node.type === type))} onClick={() => { updateGraph((current) => { const next = appendNode(current, type, agents); requestAnimationFrame(() => fitGraph(flow.current, next)); return next; }); }}>{nodeIcon(type)} {nodeName(type, zh)}</button>)}</div></aside>
    {!libraryOpen && <button type="button" className="graph-panel-toggle graph-panel-toggle--left" aria-label={zh ? "展开节点栏" : "Expand node library"} onClick={() => setLibraryOpen(true)}>›</button>}
    <div className="graph-workspace">
      <div className="graph-flow" data-testid="graph-flow"><ReactFlow nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView={false} minZoom={0.25} maxZoom={1.8} deleteKeyCode={null} nodesDraggable={interactionMode === "select"} nodesConnectable={interactionMode === "select"} elementsSelectable={interactionMode === "select"} selectionOnDrag={interactionMode === "select"} selectionMode={SelectionMode.Partial} panOnDrag={interactionMode === "pan"} onInit={(instance) => { flow.current = instance; if (graph) requestAnimationFrame(() => fitGraph(instance, graph)); }} onNodesChange={changeNodes} onNodesDelete={(nodes) => updateGraph((current) => removeSelection(current, new Set(nodes.map((node) => node.id)), new Set()))} onEdgesChange={(changes: EdgeChange[]) => { const selection = changes.filter((change): change is Extract<EdgeChange, { type: "select" }> => change.type === "select"); if (selection.length) { const next = new Set(selectedEdgeIdsRef.current); for (const change of selection) change.selected ? next.add(change.id) : next.delete(change.id); selectedEdgeIdsRef.current = next; setSelectedEdgeIds(next); } const removed = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id)); if (removed.size) updateGraph((current) => removeSelection(current, new Set(), removed)); }} onConnect={(connection) => updateGraph((current) => connect(current, connection))} onReconnect={(_oldEdge, connection) => updateGraph((current) => reconnect(current, _oldEdge.id, connection))} edgesReconnectable onMoveEnd={(_event, viewport) => updateGraph((current) => ({ ...current, viewport }))}><Background gap={18} size={1} color="#c9d8e8" /><Controls showZoom={false} showFitView={false} showInteractive={false}><ControlButton data-tooltip={zh ? "放大" : "Zoom in"} aria-label={zh ? "放大" : "Zoom in"} onClick={() => void flow.current?.zoomIn({ duration: 180 })}><ZoomInIcon /></ControlButton><ControlButton data-tooltip={zh ? "缩小" : "Zoom out"} aria-label={zh ? "缩小" : "Zoom out"} onClick={() => void flow.current?.zoomOut({ duration: 180 })}><ZoomOutIcon /></ControlButton><ControlButton className="graph-control-fit" data-tooltip={zh ? "概览全图" : "Fit View"} aria-label={zh ? "概览全图" : "Fit View"} onClick={() => graph && fitGraph(flow.current, graph)}><FitIcon /></ControlButton><ControlButton className="graph-control-mode" data-tooltip={interactionMode === "select" ? (zh ? "切换到拖动画布" : "Switch to pan mode") : (zh ? "切换到选择模式" : "Switch to select mode")} aria-label={interactionMode === "select" ? (zh ? "切换到拖动画布" : "Switch to pan mode") : (zh ? "切换到选择模式" : "Switch to select mode")} data-active={interactionMode === "pan"} onClick={() => setInteractionMode((current) => current === "select" ? "pan" : "select")}>{interactionMode === "select" ? <HandIcon /> : <PointerIcon />}</ControlButton><ControlButton className="graph-control-optimize" data-tooltip={zh ? "自动优化图" : "Optimize graph"} aria-label={zh ? "自动优化图" : "Optimize graph"} onClick={() => updateGraph((current) => { const next = autoLayoutGraph(current); requestAnimationFrame(() => fitGraph(flow.current, next)); return next; })}><OptimizeIcon /></ControlButton></Controls></ReactFlow></div>
      <div className="graph-runbar"><div className="graph-runbar__fields">{inputNode?.type === "input" ? inputNode.config.fields.map((field) => <label key={field.id}><span>{field.name}{field.required !== false ? " *" : ""}</span>{field.multiline ? <textarea aria-label={field.name} placeholder={field.description || (zh ? "输入本次运行内容…" : "Enter input for this run…")} value={runInput[field.id] ?? ""} onChange={(event) => { const value = event.currentTarget.value; setRunInput((current) => ({ ...current, [field.id]: value })); }} /> : <input aria-label={field.name} value={runInput[field.id] ?? ""} onChange={(event) => { const value = event.currentTarget.value; setRunInput((current) => ({ ...current, [field.id]: value })); }} />}</label>) : <textarea aria-label={zh ? "图输入" : "Graph input"} value={runInput.input ?? ""} onChange={(event) => setRunInput({ input: event.currentTarget.value })} />}</div><div>{run?.status === "running" && <button type="button" className="graph-stop" aria-label={zh ? "停止图" : "Stop graph"} onClick={() => { if (run && api?.cancelGraphRun) void api.cancelGraphRun(run.id).then(() => setRun((current) => current ? { ...current, status: "cancelled" } : current)); }}>■</button>}<button type="button" aria-label={zh ? "运行图" : "Run graph"} disabled={run?.status === "running" || validation.length > 0 || !hasRequiredInput(inputNode, runInput)} onClick={() => void startRun()}>▶ {zh ? "运行" : "Run"}</button></div></div>
    </div>
    {!inspectorOpen && <button type="button" className="graph-panel-toggle graph-panel-toggle--right" aria-label={zh ? "展开检查器" : "Expand inspector"} onClick={() => setInspectorOpen(true)}>‹</button>}
    <aside className="graph-inspector" aria-label={zh ? "图检查器" : "Graph inspector"}><button type="button" className="graph-inspector__resize" aria-label={zh ? "调整检查器宽度" : "Resize inspector"} onPointerDown={(event) => beginResize(event, inspectorWidth, setInspectorWidth)} />{selectedNode ? <NodeInspector node={selectedNode} agents={agents} zh={zh} latest={nodeRuns.filter((item) => item.nodeId === selectedNode.id).at(-1)} onClose={() => replaceSelection(new Set(), new Set())} onChange={(next) => updateGraph((current) => updateNode(current, next))} onDelete={() => { updateGraph((current) => removeSelection(current, new Set([selectedNode.id]), new Set())); replaceSelection(new Set(), new Set()); }} /> : <GraphInspector zh={zh} graph={graph} validation={validation} run={run} nodeRuns={nodeRuns} onCollapse={() => setInspectorOpen(false)} onDescription={(description) => updateGraph((current) => ({ ...current, description }))} />}</aside>
    {error && <div className="graph-toast" role="alert"><span>{error}</span><button onClick={() => setError(null)}>×</button></div>}
    {confirmClear && <div className="client-dialog"><button type="button" className="client-dialog__backdrop" aria-label={zh ? "取消清空" : "Cancel clearing"} onPointerDown={() => setConfirmClear(false)}/><div className="client-dialog__panel" role="dialog" aria-modal="true" aria-label={zh ? "清空图" : "Clear graph"}><h2>{zh ? "清空此图？" : "Clear this graph?"}</h2><p>{zh ? "将移除全部节点和连线，但保留图及其运行记录。" : "All nodes and edges will be removed. The Graph and its run history remain."}</p><div><button onClick={() => setConfirmClear(false)}>{zh ? "取消" : "Cancel"}</button><button className="danger" onClick={() => { setRun(null); setNodeRuns([]); setRunEvents([]); updateGraph((current) => ({ ...current, definition: { nodes: [], edges: [], start: [], end: [] }, positions: {} })); setConfirmClear(false); }}>{zh ? "清空" : "Clear"}</button></div></div></div>}
    {configDraft !== null && graph ? <GraphConfigDialog zh={zh} value={configDraft} error={configError} onChange={(value) => { setConfigDraft(value); setConfigError(null); }} onCancel={() => { setConfigDraft(null); setConfigError(null); }} onFormat={() => { try { setConfigDraft(JSON.stringify(JSON.parse(configDraft), null, 2)); setConfigError(null); } catch (cause) { setConfigError(message(cause)); } }} onAutoLayout={() => { try { setConfigDraft(serializeGraphConfig(autoLayoutGraph(parseGraphConfig(configDraft, graph)))); setConfigError(null); } catch (cause) { setConfigError(message(cause)); } }} onSave={() => { try { const next = parseGraphConfig(configDraft, graph); setGraph(next); replaceSelection(new Set(), new Set()); setConfigDraft(null); setConfigError(null); requestAnimationFrame(() => fitGraph(flow.current, next)); } catch (cause) { setConfigError(message(cause)); } }} /> : null}
  </section>;
}

function GraphConfigDialog({ zh, value, error, onChange, onCancel, onFormat, onAutoLayout, onSave }: { zh: boolean; value: string; error: string | null; onChange(value: string): void; onCancel(): void; onFormat(): void; onAutoLayout(): void; onSave(): void }) {
  return <div className="client-dialog graph-config-dialog"><button type="button" className="client-dialog__backdrop" aria-label={zh ? "取消图配置" : "Cancel Graph configuration"} onPointerDown={onCancel}/><section className="client-dialog__panel graph-config-dialog__panel" role="dialog" aria-modal="true" aria-label={zh ? "图配置" : "Graph configuration"}><header><div><h2>{zh ? "图配置" : "Graph configuration"}</h2><p>{zh ? "编辑可分享的 Graph 配置；节点位置可省略并自动生成。" : "Edit the portable Graph configuration. Node positions may be omitted and generated automatically."}</p></div><button type="button" aria-label={zh ? "关闭图配置" : "Close Graph configuration"} onClick={onCancel}>×</button></header><textarea spellCheck={false} aria-label={zh ? "图配置 JSON" : "Graph configuration JSON"} value={value} onChange={(event) => onChange(event.currentTarget.value)} />{error ? <p className="graph-config-dialog__error" role="alert">{error}</p> : null}<footer><button type="button" onClick={onCancel}>{zh ? "取消" : "Cancel"}</button><button type="button" onClick={onFormat}>{zh ? "格式化" : "Format"}</button><button type="button" onClick={onAutoLayout}>{zh ? "自动布局" : "Auto layout"}</button><button type="button" className="primary" aria-label={zh ? "保存配置" : "Save configuration"} onClick={onSave}>{zh ? "保存" : "Save"}</button></footer></section></div>;
}

function GraphInspector({ zh, graph, validation, run, nodeRuns, onCollapse, onDescription }: { zh: boolean; graph: GraphProject | null; validation: string[]; run: GraphRun | null; nodeRuns: GraphNodeRun[]; onCollapse(): void; onDescription(value: string): void }) {
  const failed = nodeRuns.filter((item) => item.status === "failed").length;
  return <><InspectorHeader title={zh ? "图信息" : "Graph information"} label={zh ? "收起检查器" : "Collapse inspector"} onClose={onCollapse} /><label>{zh ? "描述" : "Description"}<textarea value={graph?.description ?? ""} onChange={(event) => onDescription(event.currentTarget.value)} /></label>{validation.length ? <div className="graph-errors" role="alert">{validation.map((item) => <p key={item}>{item}</p>)}</div> : <p className="graph-valid">{zh ? "图结构完整，可以运行" : "Graph is ready to run"}</p>}{run && <section className="graph-run-state"><h3>{zh ? "最近一次执行" : "Latest execution"}</h3><RunStatus run={run} zh={zh} /><div className="graph-run-summary"><span>{zh ? "节点" : "Nodes"} {new Set(nodeRuns.map((item) => item.nodeId)).size}</span><span>{zh ? "步骤" : "Steps"} {nodeRuns.length}</span>{failed ? <span className="graph-run-summary__failed">{zh ? "失败" : "Failed"} {failed}</span> : null}</div>{run.error ? <p className="graph-run-error">{run.error.message}</p> : null}</section>}</>;
}

function NodeInspector({ node, agents, zh, latest, onClose, onChange, onDelete }: { node: GraphNode; agents: AgentSettingsView[]; zh: boolean; latest?: GraphNodeRun; onClose(): void; onChange(node: GraphNode): void; onDelete(): void }) {
  const prompt = useRef<PromptEditorHandle>(null);
  const availableAgents = sortAgents(agents);
  const selectedAgent = node.type === "agent" ? agents.find((agent) => agent.id === node.config.agentProductId) : undefined;
  const modelId = node.type === "agent" && selectedAgent?.catalog.models.includes(node.config.modelId ?? "") ? node.config.modelId ?? "" : "";
  const inputs = node.type === "agent" ? node.config.inputs ?? [] : [];
  return <><InspectorHeader title={zh ? "节点设置" : "Node settings"} label={zh ? "关闭节点检查器" : "Close node inspector"} onClose={onClose} onDelete={node.type === "input" || node.type === "output" ? undefined : onDelete} deleteLabel={zh ? "删除节点" : "Delete node"} /><label>{zh ? "名称" : "Name"}<input value={node.name} onChange={(event) => { const name = event.currentTarget.value; onChange({ ...node, name }); }} /></label>{node.type === "input" && <PortEditor title={zh ? "用户输入字段" : "User input fields"} direction="input" ports={node.config.fields} inputFields minOne zh={zh} onChange={(fields) => onChange({ ...node, config: { fields: fields as GraphInputField[] } })} />}{node.type === "output" && <PortEditor title={zh ? "输出字段" : "Output fields"} direction="output" ports={node.config.fields} minOne zh={zh} onChange={(fields) => onChange({ ...node, config: { fields } })} />}{node.type === "loop_counter" && <label>{zh ? "最大迭代次数" : "Maximum iterations"}<input type="number" min="1" aria-label={zh ? "最大迭代次数" : "Maximum iterations"} value={node.config.maxIterations} onChange={(event) => onChange({ ...node, config: { maxIterations: Number(event.currentTarget.value) } })} /></label>}{node.type === "agent" && <><label>Agent<select aria-label="Agent" value={node.config.agentProductId} onChange={(event) => { const agent = availableAgents.find((item) => item.id === event.currentTarget.value); if (agent && isRunnableAgent(agent)) onChange({ ...node, config: { ...node.config, agentProductId: agent.id, modelId: agent.catalog.models[0] ?? null, permissionMode: agent.catalog.permissionModes[0] ?? "request_approval" } }); }}>{availableAgents.map((agent) => <option key={agent.id} value={agent.id} disabled={!isRunnableAgent(agent)}>{agentLabel(agent.id)}</option>)}</select></label><label>{zh ? "模型" : "Model"}<select aria-label={zh ? "模型" : "Model"} value={modelId} onChange={(event) => onChange({ ...node, config: { ...node.config, modelId: event.currentTarget.value || null } })}><option value="">{zh ? "默认" : "Default"}</option>{selectedAgent?.catalog.models.map((model) => <option key={model}>{model}</option>)}</select></label><label>{zh ? "权限模式" : "Permission mode"}<select aria-label={zh ? "权限模式" : "Permission mode"} value={node.config.permissionMode} onChange={(event) => onChange({ ...node, config: { ...node.config, permissionMode: event.currentTarget.value as PermissionMode } })}>{(selectedAgent?.catalog.permissionModes ?? [node.config.permissionMode]).map((mode) => <option key={mode} value={mode}>{permissionLabels[mode][zh ? "zh" : "en"]}</option>)}</select></label><PortEditor title={zh ? "输入端口" : "Input ports"} direction="input" ports={inputs} zh={zh} onChange={(nextInputs) => onChange({ ...node, config: { ...node.config, inputs: nextInputs } })} /><PortEditor title={zh ? "输出端口" : "Output ports"} direction="output" ports={node.config.outputs ?? []} zh={zh} onChange={(outputs) => onChange({ ...node, config: { ...node.config, outputs } })} /><label>{zh ? "收到输入后执行" : "Instruction"}<PromptEditor ref={prompt} value={node.config.instruction ?? node.config.prompt ?? ""} ports={inputs} label={zh ? "提示词" : "Instruction"} unknownLabel={zh ? "未知参数" : "Unknown parameter"} onChange={(instruction) => onChange({ ...node, config: { ...node.config, instruction } })} /></label><div className="graph-prompt-parameters"><span>{zh ? "插入参数" : "Insert parameter"}</span><div>{inputs.map((port) => <button type="button" key={port.id} aria-label={`${zh ? "插入" : "Insert"} ${port.name} ${zh ? "参数" : "parameter"}`} onMouseDown={(event) => event.preventDefault()} onClick={() => prompt.current?.insert(port.id)}>＋ {port.name}</button>)}</div></div></>}{latest && <section className="graph-node-run"><h3>{zh ? "最近一次运行" : "Latest node run"}</h3><span data-status={latest.status}>{statusLabel(latest.status, zh)}</span><NodeRunValues node={node} run={latest} zh={zh} /></section>}</>;
}

function PortEditor({ title, direction, ports, zh, inputFields = false, minOne = false, onChange }: { title: string; direction: "input" | "output"; ports: GraphPort[]; zh: boolean; inputFields?: boolean; minOne?: boolean; onChange(ports: GraphPort[]): void }) {
  const add = () => { const index = nextPortNumber(ports, direction); const id = `${direction}_${crypto.randomUUID()}`; const name = `${direction}${index}`; onChange([...ports, inputFields ? { id, name, description: "", multiline: true } as GraphInputField : { id, name }]); };
  return <section className="graph-ports-editor"><header><span>{title}</span><button type="button" aria-label={`${zh ? "添加" : "Add"} ${title}`} onClick={add}>＋</button></header>{ports.map((port, index) => <div key={`${port.id}-${index}`}><input aria-label={`${title} ${index + 1}`} value={port.name} onChange={(event) => { const name = event.currentTarget.value; onChange(ports.map((item, itemIndex) => itemIndex === index ? { ...item, name } : item)); }} /><span className="graph-port-kind">{port.kind === "feedback" ? "Loop" : inputFields ? (zh ? "用户" : "User") : "Text"}</span><button type="button" aria-label={`${zh ? "删除" : "Remove"} ${port.name}`} disabled={minOne && ports.length === 1} onClick={() => onChange(ports.filter((_, itemIndex) => itemIndex !== index))}>×</button></div>)}</section>;
}
function nextPortNumber(ports: GraphPort[], _direction: "input" | "output"): number { return ports.length + 1; }

function RunHistory({ zh, graph, runs, run, nodeRuns, events, onOpen, onRerun, onDelete, canDelete }: { zh: boolean; graph: GraphProject | null; runs: GraphRun[]; run: GraphRun | null; nodeRuns: GraphNodeRun[]; events: GraphRunEvent[]; onOpen(run: GraphRun): void; onRerun(run: GraphRun): void; onDelete(run: GraphRun): void; canDelete: boolean }) {
  const snapshot = run?.graphSnapshot;
  const [snapshotNodeId, setSnapshotNodeId] = useState<string | null>(null);
  const [tab, setTab] = useState<"details" | "trajectory">("details");
  const [pendingDelete, setPendingDelete] = useState<GraphRun | null>(null);
  const snapshotNode = snapshot?.definition.nodes.find((node) => node.id === snapshotNodeId);
  const selectedRuns = snapshotNodeId ? nodeRuns.filter((item) => item.nodeId === snapshotNodeId) : [];
  const busy = runs.some((item) => item.status === "running");
  const snapshotNodes = snapshot?.definition.nodes ?? graph?.definition.nodes ?? [];
  const inputPorts = snapshotNodes.find((node) => node.type === "input")?.config.fields ?? [];
  const outputPorts = snapshotNodes.find((node) => node.type === "output")?.config.fields ?? [];
  return <section className="graph-run-view" data-testid="graph-canvas" aria-label={zh ? "最近运行" : "Recent runs"}><aside><h2>{zh ? "最近运行" : "Recent runs"}</h2>{runs.length ? runs.map((item) => <div className="graph-run-row" key={item.id} data-active={item.id === run?.id}><button type="button" className="graph-run-row__open" aria-label={`Run ${item.id}`} onClick={() => { setSnapshotNodeId(null); setTab("details"); onOpen(item); }}><RunStatus run={item} zh={zh} /><p>{item.input}</p></button><div className="graph-run-row__actions"><button type="button" aria-label={`${zh ? "重新运行" : "Rerun"} ${item.id}`} data-tooltip={zh ? "重新运行" : "Rerun"} disabled={busy} onClick={() => onRerun(item)}>↻</button><button type="button" className="danger" aria-label={`${zh ? "删除" : "Delete"} ${item.id}`} data-tooltip={zh ? "删除" : "Delete"} disabled={!canDelete || item.status === "running"} onClick={() => setPendingDelete(item)}>×</button></div></div>) : <p>{zh ? "暂无运行" : "No runs yet"}</p>}</aside><main><div className="graph-run-view__tabs" role="tablist"><button type="button" role="tab" aria-selected={tab === "details"} onClick={() => setTab("details")}>{zh ? "运行详情" : "Run details"}</button><button type="button" role="tab" aria-selected={tab === "trajectory"} onClick={() => setTab("trajectory")}>{zh ? "轨迹" : "Trajectory"}</button></div>{run ? tab === "trajectory" ? <GraphTrajectory language={zh ? "zh" : "en"} nodes={snapshotNodes} nodeRuns={nodeRuns} events={events} /> : <>{snapshot ? <RunSnapshot snapshot={snapshot} nodeRuns={nodeRuns} selectedNodeId={snapshotNodeId} onSelectNode={setSnapshotNodeId} zh={zh} /> : null}<div className="graph-run-view__details">{snapshotNode ? <section className="graph-run-detail"><h3>{snapshotNode.name}</h3>{selectedRuns.map((item) => <div key={item.id}><span>{zh ? `第 ${item.iteration} 次` : `Iteration ${item.iteration}`}</span><NodeRunValues node={snapshotNode} run={item} zh={zh} /></div>)}</section> : <><Values title={zh ? "用户输入" : "User input"} values={run.inputValues ?? { input: run.input }} labels={inputPorts} /><Values title={zh ? "最终输出" : "Final output"} values={run.outputValues ?? (run.output ? { output: run.output } : {})} labels={outputPorts} /></>}</div></> : <div className="graph-run-view__empty">{zh ? "选择一次运行查看详情" : "Select a run to inspect it"}</div>}</main>{pendingDelete && <div className="client-dialog"><button type="button" className="client-dialog__backdrop" aria-label={zh ? "取消删除" : "Cancel deletion"} onPointerDown={() => setPendingDelete(null)}/><div className="client-dialog__panel" role="dialog" aria-modal="true" aria-label={zh ? "删除运行" : "Delete run"}><h2>{zh ? "删除这次运行？" : "Delete this run?"}</h2><p>{zh ? "将删除本次运行详情与轨迹，此操作无法撤销。" : "This removes the run details and trajectory. This cannot be undone."}</p><div><button type="button" onClick={() => setPendingDelete(null)}>{zh ? "取消" : "Cancel"}</button><button type="button" className="danger" aria-label={zh ? "确认删除运行" : "Confirm run deletion"} onClick={() => { const target = pendingDelete; setPendingDelete(null); onDelete(target); }}>{zh ? "删除" : "Delete"}</button></div></div></div>}</section>;
}

function RunSnapshot({ snapshot, nodeRuns, selectedNodeId, onSelectNode, zh }: { snapshot: NonNullable<GraphRun["graphSnapshot"]>; nodeRuns: GraphNodeRun[]; selectedNodeId: string | null; onSelectNode(id: string): void; zh: boolean }) {
  const selected = selectedNodeId ? new Set([selectedNodeId]) : new Set<string>();
  return <div className="graph-run-snapshot" aria-label={zh ? "运行快照" : "Run snapshot"}><ReactFlow nodes={toFlowNodes(snapshot, nodeRuns, new Map(), selected, zh)} edges={toFlowEdges(snapshot, new Set())} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={{ padding: 0.2 }} minZoom={0.2} maxZoom={1.8} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} elementsSelectable panOnDrag onNodeClick={(_event, node) => onSelectNode(node.id)}><Background gap={18} size={1} color="#c9d8e8" /><Controls showInteractive={false} /></ReactFlow></div>;
}
function NodeRunValues({ node, run, zh }: { node: GraphNode; run: GraphNodeRun; zh: boolean }) {
  if (node.type !== "agent") return <Values title={zh ? "内容" : "Content"} values={run.outputValues ?? run.inputValues ?? (run.output !== null ? { content: run.output } : { content: run.input })} labels={node.type === "input" || node.type === "output" ? node.config.fields : []} compact />;
  return <><Values title={zh ? "输入" : "Input"} values={run.inputValues ?? { input: run.input }} labels={node.config.inputs} /><Values title={zh ? "输出" : "Output"} values={run.outputValues ?? (run.output !== null ? { output: run.output } : {})} labels={node.config.outputs} /></>;
}

interface PromptEditorHandle { insert(portId: string): void; }
const PromptEditor = forwardRef<PromptEditorHandle, { value: string; ports: GraphPort[]; label: string; unknownLabel: string; onChange(value: string): void }>(function PromptEditor({ value, ports, label, unknownLabel, onChange }, forwardedRef) {
  const editorRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<Range | null>(null);
  const rememberSelection = () => { const selection = window.getSelection(); const range = selection?.rangeCount ? selection.getRangeAt(0) : null; if (range && editorRef.current?.contains(range.commonAncestorContainer)) selectionRef.current = range.cloneRange(); };
  useImperativeHandle(forwardedRef, () => ({ insert(portId) {
    const root = editorRef.current; if (!root) return;
    const live = window.getSelection(); const current = live?.rangeCount ? live.getRangeAt(0) : null;
    const range = current && root.contains(current.commonAncestorContainer) ? current.cloneRange() : selectionRef.current?.cloneRange();
    const offset = range && root.contains(range.commonAncestorContainer) ? promptOffset(root, range) : value.length;
    onChange(`${value.slice(0, offset)}{{${portId}}}${value.slice(offset)}`);
  } }), [value, onChange]);
  const parts = splitPrompt(value);
  useLayoutEffect(() => { const root = editorRef.current; if (!root || (serializePrompt(root) === value && promptLabelsMatch(root, ports, unknownLabel))) return; root.replaceChildren(...parts.map((part) => part.type === "text" ? document.createTextNode(part.value) : promptToken(part.id, ports.find((port) => port.id === part.id)?.name ?? unknownLabel))); }, [ports, unknownLabel, value]);
  return <div ref={editorRef} className="graph-prompt-editor" role="textbox" aria-label={label} contentEditable suppressContentEditableWarning onKeyUp={rememberSelection} onMouseUp={rememberSelection} onFocus={rememberSelection} onInput={(event) => { rememberSelection(); onChange(serializePrompt(event.currentTarget)); }} onKeyDown={(event) => { if (event.key !== "Backspace" && event.key !== "Delete") return; const removal = adjacentPromptToken(event.currentTarget, event.key, value); if (!removal) return; event.preventDefault(); onChange(`${value.slice(0, removal.start)}${value.slice(removal.end)}`); }} onPaste={(event) => { event.preventDefault(); insertPlainText(event.clipboardData.getData("text/plain")); const editor = event.currentTarget; queueMicrotask(() => onChange(serializePrompt(editor))); }} />;
});
function promptToken(id: string, label: string): HTMLSpanElement { const token = document.createElement("span"); token.className = "graph-prompt-token"; token.contentEditable = "false"; token.dataset.parameterId = id; token.textContent = label; return token; }
function promptLabelsMatch(root: HTMLElement, ports: GraphPort[], unknownLabel: string): boolean { return [...root.querySelectorAll<HTMLElement>("[data-parameter-id]")].every((token) => token.textContent === (ports.find((port) => port.id === token.dataset.parameterId)?.name ?? unknownLabel)); }
function splitPrompt(value: string): Array<{ type: "text"; value: string } | { type: "parameter"; id: string }> {
  const parts: Array<{ type: "text"; value: string } | { type: "parameter"; id: string }> = [];
  let cursor = 0;
  for (const match of value.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ type: "text", value: value.slice(cursor, index) });
    parts.push({ type: "parameter", id: match[1]! }); cursor = index + match[0].length;
  }
  if (cursor < value.length || !parts.length) parts.push({ type: "text", value: value.slice(cursor) });
  return parts;
}
function serializePrompt(root: ParentNode): string {
  const visit = (node: ChildNode): string => {
    if (node instanceof HTMLElement && node.dataset.parameterId) return `{{${node.dataset.parameterId}}}`;
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node instanceof HTMLBRElement) return "\n";
    return [...node.childNodes].map(visit).join("");
  };
  return [...root.childNodes].map(visit).join("");
}
function insertPlainText(value: string): void {
  const selection = window.getSelection(); const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range) return; range.deleteContents(); const text = document.createTextNode(value); range.insertNode(text); range.setStartAfter(text); range.collapse(true); selection?.removeAllRanges(); selection?.addRange(range);
}
function adjacentPromptToken(root: HTMLElement, key: "Backspace" | "Delete", value: string): { start: number; end: number } | null {
  const selection = window.getSelection(); if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const range = selection.getRangeAt(0); if (!root.contains(range.startContainer)) return null;
  const offset = promptOffset(root, range);
  const match = key === "Backspace" ? value.slice(0, offset).match(/\{\{[^{}]+\}\}$/) : value.slice(offset).match(/^\{\{[^{}]+\}\}/);
  if (!match) return null;
  const start = key === "Backspace" ? offset - match[0].length : offset;
  return { start, end: start + match[0].length };
}
function promptOffset(root: HTMLElement, caret: Range): number { const before = document.createRange(); before.selectNodeContents(root); before.setEnd(caret.startContainer, caret.startOffset); return serializePrompt(before.cloneContents()).length; }
function InspectorHeader({ title, label, onClose, onDelete, deleteLabel }: { title: string; label: string; onClose(): void; onDelete?(): void; deleteLabel?: string }) { return <header className="graph-inspector__header"><h3>{title}</h3><div>{onDelete ? <button type="button" className="graph-inspector__header-delete" aria-label={deleteLabel} title={deleteLabel} onClick={onDelete}>⌫</button> : null}<button type="button" aria-label={label} title={label} onClick={onClose}>×</button></div></header>; }
function Values({ title, values, labels = [], compact = false }: { title: string; values: GraphValues; labels?: GraphPort[]; compact?: boolean }) { const entries = Object.entries(values); return <section className="graph-values"><h4>{title}</h4>{entries.length ? entries.map(([key, value]) => <div key={key}>{!compact || entries.length > 1 ? <strong>{labels.find((port) => port.id === key)?.name ?? key}</strong> : null}<Markdown options={{ disableParsingRawHTML: true }}>{value}</Markdown></div>) : <p>—</p>}</section>; }
function RunStatus({ run, zh }: { run: GraphRun; zh: boolean }) { return <span className="graph-status" data-status={run.status}>{statusLabel(run.status, zh)}</span>; }
function statusLabel(status: string, zh: boolean): string { const labels: Record<string, [string, string]> = { running: ["运行中", "Running"], completed: ["已完成", "Completed"], failed: ["失败", "Failed"], cancelled: ["已取消", "Cancelled"], interrupted: ["已中断", "Interrupted"] }; return labels[status]?.[zh ? 0 : 1] ?? status; }

export function defaultGraph(agents: AgentSettingsView[] = []): Omit<GraphProject, "id" | "projectId" | "createdAt" | "updatedAt"> {
  const agent = sortAgents(agents.filter(isRunnableAgent))[0];
  return { name: "Untitled graph", description: "", definition: { nodes: [{ id: "input-1", type: "input", name: "User Input", config: { fields: [{ id: "task", name: "Task", description: "Describe what the Agent should do", required: true, multiline: true }] } }, { id: "agent-1", type: "agent", name: "Agent 1", config: { agentProductId: agent?.id ?? "codex", modelId: agent?.catalog.models[0] ?? null, permissionMode: agent?.catalog.permissionModes[0] ?? "request_approval", instruction: "Complete the task and return the result.", inputs: [{ id: "task", name: "Task", required: true }], outputs: [{ id: "result", name: "Result" }] } }, { id: "output-1", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } }], edges: [{ id: "input-agent", source: "input-1", sourcePort: "task", target: "agent-1", targetPort: "task" }, { id: "agent-output", source: "agent-1", sourcePort: "result", target: "output-1", targetPort: "result" }], start: ["input-1"], end: ["output-1"] }, viewport: { x: 0, y: 0, zoom: 1 }, positions: { "input-1": { x: 80, y: 180 }, "agent-1": { x: 350, y: 180 }, "output-1": { x: 640, y: 180 } } };
}

function toFlowNodes(graph: Pick<GraphProject, "definition" | "positions">, nodeRuns: GraphNodeRun[], measurements: Map<string, { width: number; height: number }>, selected: Set<string>, zh = false, runStatus?: GraphRun["status"]): Node<GraphNodeData>[] { return graph.definition.nodes.map((node, index) => { const latest = nodeRuns.findLast((item) => item.nodeId === node.id); const loopInProgress = node.type === "loop_counter" && runStatus === "running" && latest && (latest.status === "running" || latest.iteration < node.config.maxIterations); return { id: node.id, type: "workflow", position: graph.positions[node.id] ?? { x: 100 + index * 250, y: 180 }, measured: measurements.get(node.id), selected: selected.has(node.id), data: { kind: node.type, label: node.name, subtitle: node.type === "agent" ? agentLabel(node.config.agentProductId) : node.type === "loop_counter" ? loopInProgress ? (zh ? `第 ${latest.iteration}/${node.config.maxIterations} 次` : `Iteration ${latest.iteration}/${node.config.maxIterations}`) : `× ${node.config.maxIterations}` : undefined, inputs: nodeInputs(node, zh), outputs: nodeOutputs(node, zh), status: loopInProgress ? "running" : latest?.status, acceptsNewInput: node.type === "agent" } }; } ); }
function toFlowEdges(graph: Pick<GraphProject, "definition" | "positions">, selected: Set<string>, onRoute?: RoutableEdgeData["onRoute"], routeLabel?: string): Edge<RoutableEdgeData>[] { return graph.definition.edges.map((edge) => ({ ...edge, sourceHandle: edge.sourcePort, targetHandle: edge.targetPort, label: edge.condition?.branch, type: "routable", reconnectable: Boolean(onRoute), selected: selected.has(edge.id), data: { route: edge.route, automaticRoute: edge.route ? undefined : automaticEdgeRoute(graph, edge.id), routeLabel, onRoute }, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: selected.has(edge.id) ? "#4f83d1" : "#8fa8bf", strokeWidth: selected.has(edge.id) ? 2 : 1.4 } })); }
function displayPorts(ports: GraphPort[], zh: boolean): GraphPort[] { return ports.length === 1 ? [{ ...ports[0]!, name: zh ? "内容" : "Content" }] : ports; }
function nodeInputs(node: GraphNode, zh = false): GraphPort[] { if (node.type === "agent") return node.config.inputs ?? []; if (node.type === "output") return displayPorts(node.config.fields, zh); if (node.type === "loop_counter") return [{ id: "input", name: zh ? "内容" : "Content", required: true }]; if (node.type === "literal" || node.type === "template" || node.type === "passthrough") return [{ id: "input", name: zh ? "内容" : "Content" }]; return []; }
function nodeOutputs(node: GraphNode, zh = false): GraphPort[] { if (node.type === "agent") return node.config.outputs ?? [{ id: "output", name: "Output" }]; if (node.type === "input") return displayPorts(node.config.fields, zh); if (node.type === "loop_counter") return [{ id: "done", name: zh ? "完成" : "Done" }, { id: "loop", name: zh ? "循环" : "Loop" }]; if (node.type === "literal" || node.type === "template" || node.type === "passthrough") return [{ id: "output", name: zh ? "内容" : "Content" }]; return []; }
function graphNodeHeight(node: GraphNode): number { const rows = Math.max(nodeInputs(node).length, nodeOutputs(node).length); return GRAPH_NODE_HEADER_HEIGHT + (rows ? GRAPH_NODE_PORT_PADDING + rows * GRAPH_NODE_PORT_HEIGHT : 0); }
export function automaticEdgeRoute(graph: Pick<GraphProject, "definition" | "positions">, edgeId: string): EdgeRoute | undefined {
  const edge = graph.definition.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) return undefined;
  const source = graph.positions[edge.source]; const target = graph.positions[edge.target];
  if (!source || !target) return undefined;
  if (edge.condition?.branch !== "loop" && target.x > source.x) {
    const sourceNode = graph.definition.nodes.find((node) => node.id === edge.source); const targetNode = graph.definition.nodes.find((node) => node.id === edge.target);
    const sourcePort = Math.max(0, sourceNode ? nodeOutputs(sourceNode).findIndex((port) => port.id === edge.sourcePort) : 0);
    const targetPort = Math.max(0, targetNode ? nodeInputs(targetNode).findIndex((port) => port.id === edge.targetPort) : 0);
    const sourceY = source.y + GRAPH_NODE_HEADER_HEIGHT + GRAPH_NODE_PORT_PADDING / 2 + GRAPH_NODE_PORT_HEIGHT * (sourcePort + .5);
    const targetY = target.y + GRAPH_NODE_HEADER_HEIGHT + GRAPH_NODE_PORT_PADDING / 2 + GRAPH_NODE_PORT_HEIGHT * (targetPort + .5);
    const blockers = graph.definition.nodes.filter((node) => node.id !== edge.source && node.id !== edge.target && (graph.positions[node.id]?.x ?? Infinity) > source.x && (graph.positions[node.id]?.x ?? -Infinity) < target.x);
    if (blockers.length) {
      const bottom = Math.max(...graph.definition.nodes.map((node) => (graph.positions[node.id]?.y ?? 0) + graphNodeHeight(node)));
      return { x: source.x + GRAPH_NODE_WIDTH + 32, y: bottom + 48, targetX: target.x - 32 };
    }
    if (Math.abs(sourceY - targetY) < .5) return undefined;
    const siblings = graph.definition.edges.filter((candidate) => { const from = graph.positions[candidate.source]; const to = graph.positions[candidate.target]; return Boolean(from && to && to.x > from.x && Math.abs((from.x + GRAPH_NODE_WIDTH + to.x) / 2 - (source.x + GRAPH_NODE_WIDTH + target.x) / 2) < 1); });
    const lane = Math.max(0, siblings.findIndex((candidate) => candidate.id === edgeId));
    const gapStart = source.x + GRAPH_NODE_WIDTH + 20; const gapEnd = target.x - 20; const laneX = gapStart < gapEnd ? gapStart + (gapEnd - gapStart) * (lane + 1) / (siblings.length + 1) : (source.x + GRAPH_NODE_WIDTH + target.x) / 2;
    return { x: laneX, y: targetY, targetX: laneX };
  }
  const returns = graph.definition.edges.filter((candidate) => { const from = graph.positions[candidate.source]; const to = graph.positions[candidate.target]; return Boolean(from && to && (candidate.condition?.branch === "loop" || to.x <= from.x)); });
  const lane = Math.max(0, returns.findIndex((candidate) => candidate.id === edgeId));
  const bottom = Math.max(...graph.definition.nodes.map((node) => (graph.positions[node.id]?.y ?? 0) + graphNodeHeight(node)));
  return { x: source.x + GRAPH_NODE_WIDTH + 32 + lane * 14, y: bottom + 48 + lane * 28, targetX: target.x - 32 - lane * 14 };
}
function appendNode(graph: GraphProject, type: "input" | "agent" | "loop_counter" | "output", agents: AgentSettingsView[]): GraphProject { const count = graph.definition.nodes.filter((node) => node.type === type).length + 1; const id = `${type}-${crypto.randomUUID()}`; const agent = sortAgents(agents.filter(isRunnableAgent))[0]; const node: GraphNode = type === "input" ? { id, type, name: `Input ${count}`, config: { fields: [{ id: "input", name: "Input", description: "", required: true, multiline: true }] } } : type === "output" ? { id, type, name: `Output ${count}`, config: { fields: [{ id: "output", name: "Output", required: true }] } } : type === "loop_counter" ? { id, type, name: `Loop ${count}`, config: { maxIterations: 3 } } : { id, type, name: `Agent ${count}`, config: { agentProductId: agent?.id ?? "codex", modelId: agent?.catalog.models[0] ?? null, permissionMode: agent?.catalog.permissionModes[0] ?? "request_approval", instruction: "", outputs: [{ id: "output", name: "Output 1" }] } }; const definition = { ...graph.definition, nodes: [...graph.definition.nodes, node], ...(type === "input" ? { start: [id] } : {}), ...(type === "output" ? { end: [id] } : {}) }; const points = Object.values(graph.positions); const right = points.length ? Math.max(...points.map((position) => position.x)) : 80; const rows = points.filter((position) => position.x >= right - 40).length; return { ...graph, definition, positions: { ...graph.positions, [id]: { x: right + 220, y: 120 + (rows % 3) * 140 } } }; }
function applyPositionChanges(graph: GraphProject, changes: NodeChange[]): GraphProject { const nodes = applyNodeChanges(changes, toFlowNodes(graph, [], new Map(), new Set())); const positions = { ...graph.positions }; for (const node of nodes) positions[node.id] = node.position; return { ...graph, positions }; }
function updateNode(graph: GraphProject, next: GraphNode): GraphProject {
  const previous = graph.definition.nodes.find((node) => node.id === next.id);
  if (!previous) return graph;
  const previousInputs = new Set(nodeInputs(previous).map((port) => port.id));
  const nextInputs = new Set(nodeInputs(next).map((port) => port.id));
  const previousOutputs = new Set(nodeOutputs(previous).map((port) => port.id));
  const nextOutputs = new Set(nodeOutputs(next).map((port) => port.id));
  const removedInputs = [...previousInputs].filter((id) => !nextInputs.has(id));
  const removedOutputs = [...previousOutputs].filter((id) => !nextOutputs.has(id));
  let normalized = next;
  if (next.type === "agent" && removedInputs.length) {
    let instruction = next.config.instruction ?? next.config.prompt ?? "";
    for (const id of removedInputs) instruction = instruction.replaceAll(`{{${id}}}`, "");
    normalized = { ...next, config: { ...next.config, instruction } };
  }
  return { ...graph, definition: { ...graph.definition, nodes: graph.definition.nodes.map((node) => node.id === next.id ? normalized : node), edges: graph.definition.edges.filter((edge) => !(edge.target === next.id && edge.targetPort && removedInputs.includes(edge.targetPort)) && !(edge.source === next.id && edge.sourcePort && removedOutputs.includes(edge.sourcePort))) } };
}
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
export function connect(graph: GraphProject, connection: Connection): GraphProject {
  if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return graph;
  const source = graph.definition.nodes.find((node) => node.id === connection.source);
  const target = graph.definition.nodes.find((node) => node.id === connection.target);
  const branch = connection.sourceHandle === "loop" || connection.sourceHandle === "done" ? connection.sourceHandle : null;
  const condition: GraphDefinition["edges"][number]["condition"] = source?.type === "loop_counter" && branch ? { branch } : undefined;
  const feedback = source?.type === "loop_counter" && branch === "loop";
  let targetPort = connection.targetHandle;
  let nodes = graph.definition.nodes;
  if (target?.type === "agent") {
    const current = target.config.inputs ?? [];
    const occupied = graph.definition.edges.some((edge) => edge.target === target.id && edge.targetPort === targetPort);
    if (targetPort === "__new_input" || occupied) {
      targetPort = `input_${crypto.randomUUID()}`;
      const name = `input${nextPortNumber(current, "input")}`;
      nodes = nodes.map((node) => node.id === target.id ? { ...target, config: { ...target.config, inputs: [...current, { id: targetPort, name, required: !feedback, kind: feedback ? "feedback" as const : "input" as const }] } } : node);
    } else {
      nodes = nodes.map((node) => node.id === target.id ? { ...target, config: { ...target.config, inputs: current.map((port) => port.id === targetPort ? { ...port, required: !feedback, ...(feedback ? { kind: "feedback" as const } : { kind: "input" as const }) } : port) } } : node);
    }
  }
  const edge: GraphDefinition["edges"][number] = { id: crypto.randomUUID(), source: connection.source, sourcePort: connection.sourceHandle, target: connection.target, targetPort, ...(condition ? { condition } : {}) };
  const edges = graph.definition.edges.filter((item) => item.target !== edge.target || item.targetPort !== edge.targetPort);
  return { ...graph, definition: { ...graph.definition, nodes, edges: [...edges, edge] } };
}
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
export function graphBounds(graph: GraphProject): { x: number; y: number; width: number; height: number } {
  const positions = graph.positions;
  const points = [...graph.definition.nodes.flatMap((node) => { const position = positions[node.id] ?? { x: 0, y: 0 }; return [position, { x: position.x + GRAPH_NODE_WIDTH, y: position.y + graphNodeHeight(node) }]; })];
  for (const edge of graph.definition.edges) {
    const route = edge.route ?? automaticEdgeRoute(graph, edge.id);
    if (route) { points.push(route); if (route.targetX !== undefined) points.push({ x: route.targetX, y: route.y }); }
  }
  if (!points.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...points.map((point) => point.x));
  const y = Math.min(...points.map((point) => point.y));
  return { x, y, width: Math.max(1, Math.max(...points.map((point) => point.x)) - x), height: Math.max(1, Math.max(...points.map((point) => point.y)) - y) };
}
function fitGraph(instance: ReactFlowInstance<Node<GraphNodeData>, Edge> | null, graph: GraphProject) { if (instance) void instance.fitBounds(graphBounds(graph), { padding: 0.18, duration: 240 }); }
function ZoomInIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>; }
function ZoomOutIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12" /></svg>; }
function FitIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 8V3.5H8M12 3.5h4.5V8M16.5 12v4.5H12M8 16.5H3.5V12" /></svg>; }
function HandIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 9V5.5a1.2 1.2 0 0 1 2.4 0V8m0-3.5a1.2 1.2 0 0 1 2.4 0V8m0-2.5a1.2 1.2 0 0 1 2.4 0V9m0-1.5a1.2 1.2 0 0 1 2.4 0v4c0 3-2 5-5 5H9c-2 0-3.1-.8-4.1-2.2L2.8 12a1.2 1.2 0 0 1 1.9-1.5L6.5 12Z" /></svg>; }
function PointerIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3l10 8-5 .8-2.4 4.5Z" /></svg>; }
function OptimizeIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h8M15 6h2M3 14h2M9 14h8M13 3v6M7 11v6" /></svg>; }
