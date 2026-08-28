import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { GraphNodeRunStatus, GraphPort } from "../../shared/contracts.js";

export interface GraphNodeData extends Record<string, unknown> {
  label: string;
  kind: "input" | "agent" | "output" | "loop_counter" | "literal" | "template" | "passthrough";
  subtitle?: string;
  inputs: GraphPort[];
  outputs: GraphPort[];
  status?: GraphNodeRunStatus;
  acceptsNewInput?: boolean;
}

export function GraphNodeView({ data, selected }: NodeProps) {
  const value = data as GraphNodeData;
  return <div className="graph-node" data-kind={value.kind} data-selected={selected || undefined} data-status={value.status}>
    <header><span className="graph-node__icon" aria-hidden="true">{icon(value.kind)}</span><span className="graph-node__copy"><strong>{value.label}</strong>{value.subtitle && <small>{value.subtitle}</small>}</span></header>
    {(value.inputs.length > 0 || value.outputs.length > 0) && <div className="graph-node__ports">
      <div>{value.inputs.map((port) => <div className="graph-node__port graph-node__port--input" key={port.id}><Handle id={port.id} type="target" position={Position.Left} />{value.kind !== "output" ? <span>{port.name}</span> : null}{port.kind === "feedback" ? <em>loop</em> : null}</div>)}{value.acceptsNewInput ? <Handle className="graph-node__auto-input" id="__new_input" type="target" position={Position.Left} /> : null}</div><div>{value.outputs.map((port) => <div className="graph-node__port graph-node__port--output" key={port.id}><span>{port.name}</span><Handle id={port.id} type="source" position={Position.Right} /></div>)}</div>
    </div>}
  </div>;
}

function icon(kind: GraphNodeData["kind"]): string {
  if (kind === "input") return "↳";
  if (kind === "output") return "↗";
  if (kind === "agent") return "✦";
  if (kind === "loop_counter") return "↻";
  return "·";
}
