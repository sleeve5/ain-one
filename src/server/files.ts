import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn as defaultSpawn,
} from "node:child_process";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number | null;
}

export interface FileTreeResult {
  path: string;
  entries: FileEntry[];
}

export interface FilePreviewResult {
  path: string;
  size: number;
  isBinary: boolean;
  truncated: boolean;
  content: string | null;
}

export interface GitCommandResult {
  output: string;
  truncated: boolean;
}

export interface ProjectFilesService {
  list(projectRoot: string, requestedPath: string | null): Promise<FileTreeResult>;
  preview(projectRoot: string, requestedPath: string | null): Promise<FilePreviewResult>;
  gitStatus(projectRoot: string): Promise<GitCommandResult>;
  gitDiff(projectRoot: string, requestedPath: string | null): Promise<GitCommandResult>;
}

export type GitRunner = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

interface FilesServiceOptions {
  previewBytes?: number;
  gitOutputBytes?: number;
  spawn?: GitRunner;
}

export class FilesServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_PREVIEW_BYTES = 32 * 1024;
const DEFAULT_GIT_OUTPUT_BYTES = 128 * 1024;

export function createProjectFilesService(options: FilesServiceOptions = {}): ProjectFilesService {
  const previewBytes = options.previewBytes ?? DEFAULT_PREVIEW_BYTES;
  const gitOutputBytes = options.gitOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES;
  const spawn = options.spawn ?? defaultSpawn;

  return {
    async list(projectRoot, requestedPath) {
      const projectRootReal = await resolveProjectRoot(projectRoot);
      const target = await resolveInsideProject(projectRootReal, requestedPath);
      const targetStat = await stat(target.realPath);
      if (!targetStat.isDirectory()) {
        throw new FilesServiceError(400, "not_directory", "Requested path is not a directory");
      }

      const dirents = await readdir(target.realPath, { withFileTypes: true });
      const entries: FileEntry[] = [];

      for (const dirent of dirents) {
        const entryPath = resolve(target.realPath, dirent.name);
        const entryStat = await lstat(entryPath);
        const entryType = dirent.isDirectory()
          ? "directory"
          : dirent.isFile()
            ? "file"
            : dirent.isSymbolicLink()
              ? "symlink"
              : "other";

        entries.push({
          name: dirent.name,
          path: joinRelativePath(target.relativePath, dirent.name),
          type: entryType,
          size: entryStat.isFile() ? entryStat.size : null,
        });
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));

      return {
        path: target.relativePath,
        entries,
      };
    },

    async preview(projectRoot, requestedPath) {
      const projectRootReal = await resolveProjectRoot(projectRoot);
      const target = await resolveInsideProject(projectRootReal, requestedPath);
      const targetStat = await stat(target.realPath);
      if (!targetStat.isFile()) {
        throw new FilesServiceError(400, "not_file", "Requested path is not a file");
      }

      const handle = await open(target.realPath, "r");
      try {
        const buffer = Buffer.alloc(previewBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, previewBytes + 1, 0);
        const slice = buffer.subarray(0, Math.min(previewBytes, bytesRead));
        const truncated = bytesRead > previewBytes;
        const isBinary = slice.includes(0);

        return {
          path: target.relativePath,
          size: targetStat.size,
          isBinary,
          truncated,
          content: isBinary ? null : slice.toString("utf8"),
        };
      } finally {
        await handle.close();
      }
    },

    async gitStatus(projectRoot) {
      const projectRootReal = await resolveProjectRoot(projectRoot);
      return runGit({
        projectRoot: projectRootReal,
        args: ["status", "--short", "--branch"],
        maxBytes: gitOutputBytes,
        spawn,
      });
    },

    async gitDiff(projectRoot, requestedPath) {
      const projectRootReal = await resolveProjectRoot(projectRoot);
      let pathSpec: string | null = null;
      if (requestedPath !== null && requestedPath.trim().length > 0) {
        pathSpec = (await resolveInsideProject(projectRootReal, requestedPath)).relativePath;
      }

      return runGit({
        projectRoot: projectRootReal,
        args: pathSpec && pathSpec !== "." ? ["diff", "--", pathSpec] : ["diff"],
        maxBytes: gitOutputBytes,
        spawn,
      });
    },
  };
}

export async function pickProjectDirectory(spawn: GitRunner = defaultSpawn): Promise<string | null> {
  const child = spawn(
    "osascript",
    [
      "-e",
      "try",
      "-e",
      'POSIX path of (choose folder with prompt "Choose an Ain One project folder")',
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
    throw new FilesServiceError(
      500,
      "folder_picker_failed",
      Buffer.concat(stderr).toString("utf8").trim() || "Could not open folder picker",
    );
  }

  return Buffer.concat(stdout).toString("utf8").trim() || null;
}

interface ResolvedPath {
  realPath: string;
  relativePath: string;
}

async function resolveProjectRoot(projectRoot: string): Promise<string> {
  let projectRootReal: string;
  try {
    projectRootReal = await realpath(projectRoot);
  } catch {
    throw new FilesServiceError(404, "project_not_found", "Project root does not exist");
  }

  const projectStat = await stat(projectRootReal);
  if (!projectStat.isDirectory()) {
    throw new FilesServiceError(400, "project_not_directory", "Project root must be a directory");
  }

  return projectRootReal;
}

async function resolveInsideProject(
  projectRootReal: string,
  requestedPath: string | null,
): Promise<ResolvedPath> {
  const rawPath = requestedPath && requestedPath.trim().length > 0 ? requestedPath : ".";
  if (rawPath.includes("\0")) {
    throw new FilesServiceError(400, "invalid_path", "Path contains a null byte");
  }

  const candidate = resolve(projectRootReal, rawPath);
  let targetReal: string;
  try {
    targetReal = await realpath(candidate);
  } catch {
    throw new FilesServiceError(404, "path_not_found", "Requested path does not exist");
  }

  const rel = relative(projectRootReal, targetReal);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new FilesServiceError(
      400,
      "path_outside_project",
      "Requested path resolves outside the project root",
    );
  }

  return {
    realPath: targetReal,
    relativePath: normalizeRelative(rel),
  };
}

function normalizeRelative(relativePath: string): string {
  if (relativePath.length === 0) {
    return ".";
  }
  return relativePath.split(sep).join("/");
}

function joinRelativePath(base: string, name: string): string {
  if (base === ".") {
    return name;
  }
  return `${base}/${name}`;
}

interface RunGitInput {
  projectRoot: string;
  args: string[];
  maxBytes: number;
  spawn: GitRunner;
}

async function runGit(input: RunGitInput): Promise<GitCommandResult> {
  const child = input.spawn(
    "git",
    ["-C", input.projectRoot, ...input.args],
    {
      shell: false,
    },
  );

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let totalBytes = 0;
  let truncated = false;
  let killed = false;

  const append = (target: Buffer[], chunk: Buffer): void => {
    if (totalBytes >= input.maxBytes) {
      if (!killed) {
        killed = true;
        truncated = true;
        child.kill();
      }
      return;
    }

    const remaining = input.maxBytes - totalBytes;
    const portion = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    target.push(portion);
    totalBytes += portion.length;

    if (portion.length < chunk.length && !killed) {
      killed = true;
      truncated = true;
      child.kill();
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    append(stdoutChunks, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    append(stderrChunks, chunk);
  });

  const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      resolvePromise(code ?? 0);
    });
  });

  const output = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (exitCode !== 0 && !truncated) {
    throw new FilesServiceError(400, "git_failed", stderr.trim() || "Git command failed");
  }

  return {
    output,
    truncated,
  };
}
