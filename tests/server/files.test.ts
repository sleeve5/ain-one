import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  pickLocalPath,
  pickProjectDirectory,
  type NativePickerRunner,
} from "../../src/server/files.js";

describe("native path picker", () => {
  it("opens native folder and file pickers without accepting handwritten browser paths", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawn: NativePickerRunner = (command, args) => {
      calls.push({ command, args });
      const stdout = new PassThrough(); const stderr = new PassThrough();
      const child = new PassThrough() as unknown as ChildProcessWithoutNullStreams;
      (child as unknown as { stdout: PassThrough }).stdout = stdout;
      (child as unknown as { stderr: PassThrough }).stderr = stderr;
      queueMicrotask(() => { stdout.end("/tmp/chosen\n"); stderr.end(); (child as unknown as { emit(name:string,...args:unknown[]):void }).emit("close", 0); });
      return child;
    };

    await expect(pickLocalPath("directory", "plugin", spawn)).resolves.toBe("/tmp/chosen");
    await expect(pickLocalPath("file", "agent", spawn)).resolves.toBe("/tmp/chosen");
    expect(calls[0]?.args.join(" ")).toContain("choose folder");
    expect(calls[1]?.args.join(" ")).toContain("choose file");
  });
  it("opens the macOS folder chooser without a shell and treats cancellation as no selection", async () => {
    const calls: Array<{ command: string; args: string[]; options: SpawnOptionsWithoutStdio }> = [];
    const outputs = ["/tmp/chosen-project/\n", "\n"];
    const spawn: NativePickerRunner = (command, args, options) => {
      calls.push({ command, args: [...args], options });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = new PassThrough() as unknown as ChildProcessWithoutNullStreams;
      (child as unknown as { stdout: PassThrough }).stdout = stdout;
      (child as unknown as { stderr: PassThrough }).stderr = stderr;
      queueMicrotask(() => {
        stdout.end(outputs.shift());
        stderr.end();
        (child as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit(
          "close",
          0,
          null,
        );
      });
      return child;
    };

    await expect(pickProjectDirectory(spawn)).resolves.toBe("/tmp/chosen-project/");
    await expect(pickProjectDirectory(spawn)).resolves.toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.command).toBe("osascript");
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["-e", "activate"]));
    expect(calls[0]?.options.shell).toBe(false);
    expect(calls[0]?.args.join(" ")).toContain("choose folder");
  });
});
