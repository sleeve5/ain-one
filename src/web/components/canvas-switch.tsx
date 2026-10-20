import type { CanvasKind } from "../store.js";

interface CanvasSwitchProps {
  value: CanvasKind;
  language?: "zh" | "en";
  onChange(value: CanvasKind): void;
}

export function CanvasSwitch(props: CanvasSwitchProps) {
  const zh = props.language === "zh";
  return (
    <div className="canvas-switch" role="group" aria-label="Canvas view">
      <button
        type="button"
        className="canvas-switch__button"
        data-active={props.value === "conversation"}
        aria-pressed={props.value === "conversation"}
        onClick={() => props.onChange("conversation")}
      >
        {zh ? "对话" : "Conversation"}
      </button>
      <button
        type="button"
        className="canvas-switch__button"
        data-active={props.value === "trajectory"}
        aria-pressed={props.value === "trajectory"}
        onClick={() => props.onChange("trajectory")}
      >
        {zh ? "轨迹" : "Trajectory"}
      </button>
    </div>
  );
}
