import { Handle, Position, type NodeProps } from "@xyflow/react";

export interface GraphNodeData extends Record<string, unknown> {
  label: string;
  kind: "start" | "end" | "agent" | "literal" | "template" | "loop_counter" | "passthrough";
  subtitle?: string;
  status?: string;
}

export function GraphNodeView({ data, selected }: NodeProps) {
  const value = data as GraphNodeData;
  return <div className="graph-node" data-kind={value.kind} data-selected={selected || undefined} data-status={value.status}>
    {value.kind !== "start" && <Handle type="target" position={Position.Left} />}
    <span className="graph-node__icon" aria-hidden="true">{icon(value.kind)}</span>
    <span className="graph-node__copy"><strong>{value.label}</strong>{value.subtitle && <small>{value.subtitle}</small>}</span>
    {value.kind === "loop_counter" ? <>
      <Handle id="loop" type="source" position={Position.Right} style={{ top: "38%" }} />
      <Handle id="done" type="source" position={Position.Right} style={{ top: "72%" }} />
    </> : value.kind !== "end" && <Handle type="source" position={Position.Right} />}
  </div>;
}

function icon(kind: GraphNodeData["kind"]): string {
  if (kind === "start") return "▶";
  if (kind === "end") return "■";
  if (kind === "agent") return "✦";
  if (kind === "literal") return "T";
  if (kind === "template") return "{ }";
  if (kind === "loop_counter") return "↻";
  return "→";
}
