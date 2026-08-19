import { useState } from "react";

export function GraphCanvas() {
  const [viewportMarker, setViewportMarker] = useState("center:0,0 zoom:1");

  return (
    <section className="graph-canvas" data-testid="graph-canvas" aria-label="Graph Canvas">
      <h2 className="graph-canvas__heading">Graph Canvas</h2>
      <p className="graph-canvas__text">
        Phase 1 placeholder. Graph editing and runtime arrive in Phase 2.
      </p>
      <label className="graph-canvas__label" htmlFor="graph-viewport-marker">
        Viewport marker
      </label>
      <input
        id="graph-viewport-marker"
        value={viewportMarker}
        onChange={(event) => setViewportMarker(event.currentTarget.value)}
      />
    </section>
  );
}
