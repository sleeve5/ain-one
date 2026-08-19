import type { InspectorState } from "../api.js";

interface InspectorProps {
  state: InspectorState;
  onSelectPath(path: string): void;
}

export function Inspector(props: InspectorProps) {
  return (
    <aside className="inspector" aria-label="Project inspector">
      <section className="inspector__section">
        <h2>Files</h2>
        <ul className="inspector__list" aria-label="File tree">
          {props.state.files.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className="inspector__file"
                data-selected={props.state.selectedPath === entry.path}
                onClick={() => props.onSelectPath(entry.path)}
                disabled={entry.type !== "file"}
              >
                {entry.path}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="inspector__section" aria-label="Read-only file preview">
        <h2>Preview</h2>
        <p className="inspector__path">{props.state.preview.path ?? "No file selected"}</p>
        <pre className="inspector__code">{props.state.preview.content}</pre>
      </section>

      <section className="inspector__section" aria-label="Git status">
        <h2>Git status</h2>
        <p className="inspector__meta">Branch: {props.state.gitStatus.branch}</p>
        <ul className="inspector__list">
          {props.state.gitStatus.entries.map((entry) => (
            <li key={entry.path}>
              <code>
                {entry.status} {entry.path}
              </code>
            </li>
          ))}
        </ul>
      </section>

      <section className="inspector__section" aria-label="Git diff">
        <h2>Diff</h2>
        <pre className="inspector__code">{props.state.gitDiff.content || "No diff"}</pre>
      </section>
    </aside>
  );
}
