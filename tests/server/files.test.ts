import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
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

  it("rejects a file replaced by an outside symlink between validation and open", async () => {
    const projectDir = makeTempProject();
    const outsideDir = mkdtempSync(join(tmpdir(), "ain-one-task3-race-outside-"));
    tempDirs.push(outsideDir);
    const target = join(projectDir, "target.txt");
    const outside = join(outsideDir, "secret.txt");
    writeFileSync(target, "inside");
    writeFileSync(outside, "outside-secret");

    let swapped = false;
    const files = createProjectFilesService({
      openFile: async (path, flags, mode) => {
        if (!swapped) {
          swapped = true;
          renameSync(target, `${target}.original`);
          symlinkSync(outside, target);
        }
        return openFile(path, flags, mode);
      },
    });

    await expect(files.preview(projectDir, "target.txt")).rejects.toMatchObject({
      code: "path_changed",
    });
  });

  it("limits git status and diff to a Project that is a repository subdirectory", async () => {
    const repositoryDir = makeTempProject();
    const projectDir = join(repositoryDir, "project");
    const siblingDir = join(repositoryDir, "sibling");
    mkdirSync(projectDir);
    mkdirSync(siblingDir);
    writeFileSync(join(projectDir, "inside.txt"), "before\n");
    writeFileSync(join(siblingDir, "outside.txt"), "before\n");
    execFileSync("git", ["init", "-q", repositoryDir]);
    execFileSync("git", ["-C", repositoryDir, "config", "user.email", "ain-one@example.invalid"]);
    execFileSync("git", ["-C", repositoryDir, "config", "user.name", "Ain One Test"]);
    execFileSync("git", ["-C", repositoryDir, "add", "."]);
    execFileSync("git", ["-C", repositoryDir, "commit", "-qm", "initial"]);
    writeFileSync(join(projectDir, "inside.txt"), "after\n");
    writeFileSync(join(siblingDir, "outside.txt"), "after\n");

    const files = createProjectFilesService();
    const status = await files.gitStatus(projectDir);
    const diff = await files.gitDiff(projectDir, null);

    expect(status.output).toContain("inside.txt");
    expect(status.output).not.toContain("outside.txt");
    expect(diff.output).toContain("inside.txt");
    expect(diff.output).not.toContain("outside.txt");
  });

  it("disables repository-controlled fsmonitor helpers", async () => {
    const repositoryDir = makeTempProject();
    const marker = join(repositoryDir, "fsmonitor-ran");
    const helper = join(repositoryDir, "fsmonitor.sh");
    writeFileSync(join(repositoryDir, "file.txt"), "content\n");
    execFileSync("git", ["init", "-q", repositoryDir]);
    writeFileSync(helper, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nprintf '\\n'\n`);
    chmodSync(helper, 0o755);
    execFileSync("git", ["-C", repositoryDir, "config", "core.fsmonitor", helper]);

    await createProjectFilesService().gitStatus(repositoryDir);

    expect(() => realpathSync(marker)).toThrow();
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
    expect(calls[0]?.args).toContain("--literal-pathspecs");
    expect(calls[0]?.args).toContain("--no-ext-diff");
    expect(calls[0]?.args).toContain("--no-textconv");
    expect(calls[0]?.args).toContain(canonicalProjectDir);
    expect(calls[0]?.args.at(-1)).toBe("nested/file.txt");
    expect(calls[0]?.options.env).toMatchObject({
      GIT_EXTERNAL_DIFF: "",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("times out a silent git process and escalates termination", async () => {
    const projectDir = makeTempProject();
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    const spawn: GitRunner = () => {
      const child = new PassThrough() as unknown as ChildProcessWithoutNullStreams;
      (child as unknown as { stdout: PassThrough }).stdout = new PassThrough();
      (child as unknown as { stderr: PassThrough }).stderr = new PassThrough();
      (child as unknown as { kill: (signal?: NodeJS.Signals | number) => boolean }).kill = (signal) => {
        signals.push(signal);
        return true;
      };
      return child;
    };
    const files = createProjectFilesService({
      spawn,
      gitTimeoutMs: 5,
      gitKillGraceMs: 5,
    });

    const deadline = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("git timeout did not settle")), 100);
    });
    await expect(Promise.race([files.gitStatus(projectDir), deadline])).rejects.toMatchObject({
      code: "git_timeout",
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
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
