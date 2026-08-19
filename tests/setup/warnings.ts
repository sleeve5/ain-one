const originalEmitWarning = process.emitWarning.bind(process);

(process as { emitWarning: (...args: unknown[]) => void }).emitWarning = (
  warning: unknown,
  ...args: unknown[]
) => {
  if (isSqliteExperimentalWarning(warning, args)) {
    return;
  }
  originalEmitWarning(warning as Parameters<typeof originalEmitWarning>[0], ...(args as []));
};

function isSqliteExperimentalWarning(
  warning: unknown,
  args: unknown[],
): boolean {
  if (warning instanceof Error) {
    return (
      warning.name === "ExperimentalWarning" &&
      warning.message.includes("SQLite")
    );
  }

  if (typeof warning === "string") {
    const warningType = typeof args[0] === "string" ? args[0] : undefined;
    return warningType === "ExperimentalWarning" && warning.includes("SQLite");
  }

  return false;
}
