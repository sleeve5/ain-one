import { afterAll } from "vitest";

const SQLITE_EXPERIMENTAL_WARNING =
  "SQLite is an experimental feature and might change at any time";
const originalEmitWarning = process.emitWarning.bind(process);

export function createWarningFilter(
  forward: (...args: unknown[]) => void,
): (...args: unknown[]) => void {
  return (warning: unknown, ...args: unknown[]) => {
    if (isNodeSqliteExperimentalWarning(warning, args)) {
      return;
    }
    forward(warning, ...args);
  };
}

process.emitWarning = createWarningFilter(
  originalEmitWarning as (...args: unknown[]) => void,
) as typeof process.emitWarning;

afterAll(() => {
  process.emitWarning = originalEmitWarning;
});

function isNodeSqliteExperimentalWarning(
  warning: unknown,
  args: unknown[],
): boolean {
  if (warning instanceof Error) {
    return (
      warning.name === "ExperimentalWarning" &&
      warning.message === SQLITE_EXPERIMENTAL_WARNING
    );
  }

  return (
    warning === SQLITE_EXPERIMENTAL_WARNING &&
    args[0] === "ExperimentalWarning"
  );
}
