import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectFilesService,
  pickProjectDirectory,
  type GitRunner,
} from "../../src/server/files.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "ain-one-task3-files-"));
  tempDirs.push(dir);
  return dir;
}

describe("project files service", () => {
  it("rejects symlink escapes outside the project root", async () => {
    const projectDir = makeTempProject();
    const outsideDir = mkdtempSync(join(tmpdir(), "ain-one-task3-files-outside-"));
    tempDirs.push(outsideDir);
    const outsideFile = join(outsideDir, "outside-secret.txt");
    writeFileSync(outsideFile, "secret");

    const linkPath = join(projectDir, "linked-secret.txt");
    symlinkSync(outsideFile, linkPath);

    const files = createProjectFilesService();
    await expect(files.preview(projectDir, "linked-secret.txt")).rejects.toMatchObject({
      code: "path_outside_project",
    });
  });

  it("caps preview reads and marks truncation", async () => {
    const projectDir = makeTempProject();
    const filePath = join(projectDir, "large.txt");
    writeFileSync(filePath, "a".repeat(50));

    const files = createProjectFilesService({ previewBytes: 16 });
    const preview = await files.preview(projectDir, "large.txt");

    expect(preview.isBinary).toBe(false);
    expect(preview.truncated).toBe(true);
    expect(preview.content).toHaveLength(16);
    expect(preview.size).toBe(50);
  });

  it("spawns git with argument arrays and shell disabled", async () => {
    const projectDir = makeTempProject();
    mkdirSync(join(projectDir, "nested"));
    writeFileSync(join(projectDir, "nested", "file.txt"), "content\n");

    const calls: Array<{ command: string; args: string[]; options: SpawnOptionsWithoutStdio }> =
      [];

    const spawn: GitRunner = (command, args, options) => {
      calls.push({
        command,
        args: [...args],
        options,
      });

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = new PassThrough() as unknown as ChildProcessWithoutNullStreams;

      (child as unknown as { stdout: PassThrough }).stdout = stdout;
      (child as unknown as { stderr: PassThrough }).stderr = stderr;
      (child as unknown as { kill: () => boolean }).kill = () => true;
      queueMicrotask(() => {
        stdout.end("ok\n");
        stderr.end();
        (child as unknown as { emit: (name: string, ...args: unknown[]) => void }).emit(
          "close",
          0,
          null,
        );
      });

      return child;
    };

    const files = createProjectFilesService({ spawn });
    const result = await files.gitDiff(projectDir, "nested/file.txt");
    const canonicalProjectDir = realpathSync(projectDir);

    expect(result.output).toContain("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("git");
    expect(calls[0]?.options.shell).toBe(false);
    expect(calls[0]?.args).toEqual([
      "-C",
      canonicalProjectDir,
      "diff",
      "--",
      "nested/file.txt",
    ]);
  });

  it("opens the macOS folder chooser without a shell and treats cancellation as no selection", async () => {
    const calls: Array<{ command: string; args: string[]; options: SpawnOptionsWithoutStdio }> = [];
    const outputs = ["/tmp/chosen-project/\n", "\n"];
    const spawn: GitRunner = (command, args, options) => {
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
    expect(calls[0]?.options.shell).toBe(false);
    expect(calls[0]?.args.join(" ")).toContain("choose folder");
  });
});
