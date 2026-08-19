const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
  if (isSqliteExperimentalWarning(warning, args)) {
    return;
  }
  originalEmitWarning(
    warning as Parameters<typeof originalEmitWarning>[0],
    ...(args as []),
  );
}) as typeof process.emitWarning;

process.once("exit", () => {
  process.emitWarning = originalEmitWarning;
});

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
