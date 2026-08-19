import type { CanvasKind } from "../store.js";

interface CanvasSwitchProps {
  value: CanvasKind;
  onChange(value: CanvasKind): void;
}

export function CanvasSwitch(props: CanvasSwitchProps) {
  return (
    <div className="canvas-switch" role="group" aria-label="Canvas view">
      <button
        type="button"
        className="canvas-switch__button"
        data-active={props.value === "conversation"}
        onClick={() => props.onChange("conversation")}
      >
        Conversation
      </button>
      <button
        type="button"
        className="canvas-switch__button"
        data-active={props.value === "graph"}
        onClick={() => props.onChange("graph")}
      >
        Graph
      </button>
    </div>
  );
}
