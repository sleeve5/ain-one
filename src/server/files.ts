import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn as defaultSpawn,
} from "node:child_process";

export type NativePickerRunner = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export async function pickLocalPath(
  kind: "directory" | "file",
  purpose: "project" | "plugin" | "agent",
  spawn: NativePickerRunner = defaultSpawn,
): Promise<string | null> {
  const noun = kind === "directory" ? "folder" : "file";
  const prompt = purpose === "project"
    ? "Choose an Ain One project folder"
    : purpose === "plugin"
      ? `Choose an Ain One plugin ${noun}`
      : "Choose an Agent executable";
  const child = spawn(
    "osascript",
    [
      "-e",
      "activate",
      "-e",
      "try",
      "-e",
      `POSIX path of (choose ${kind === "directory" ? "folder" : "file"} with prompt ${JSON.stringify(prompt)})`,
      "-e",
      "on error number -128",
      "-e",
      'return ""',
      "-e",
      "end try",
    ],
    { shell: false },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise(code ?? 0));
  });
  if (exitCode !== 0) {
    throw new Error(Buffer.concat(stderr).toString("utf8").trim() || "Could not open folder picker");
  }

  return Buffer.concat(stdout).toString("utf8").trim() || null;
}

export async function pickProjectDirectory(spawn: NativePickerRunner = defaultSpawn): Promise<string | null> {
  return pickLocalPath("directory", "project", spawn);
}
