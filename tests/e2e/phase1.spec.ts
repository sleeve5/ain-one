import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fakeCodex = realpathSync(join(repositoryRoot, "tests/fixtures/agents/fake-codex.mjs"));

test("runs the Phase 1 Project, FIFO, canvases, inspector, and interrupted restart flow", async ({ page }) => {
  test.setTimeout(90_000);
  const root = mkdtempSync(join(tmpdir(), "ain-one-e2e-"));
  const dataDir = join(root, "data");
  const projectDir = join(root, "sample-project");
  const gatePath = join(root, "complete-turns");
  const recordPath = join(root, "agent-invocations.jsonl");
  const token = "e2e-install-token";
  mkdirSync(dataDir);
  createGitProject(projectDir);

  const apiPort = await freePort();
  const webPort = await freePort(new Set([apiPort, 6767]));
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  let dev: ChildProcess | null = null;

  try {
    dev = await startDev({ dataDir, apiPort, webPort, token, gatePath, recordPath });
    await updateCodexExecutable(apiUrl, token);
    await openProject(apiUrl, token, projectDir);

    await page.goto(webUrl);
    await expect(page.getByRole("button", { name: "Open Project Folder" })).toBeVisible();
    await expect(page.getByLabel("Project path")).toHaveCount(0);
    await expect(page.getByRole("button", { name: basename(projectDir) })).toBeVisible();
    await expect(page.getByRole("option", { name: "OpenCode" })).toHaveCount(0);

    await page.getByRole("button", { name: "Agent Settings" }).click();
    await expect(page.getByText("OpenCode", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Workspace" }).click();

    await page.getByRole("button", { name: "Create Conversation" }).click();
    await expect(page.getByText("Agent product: Codex")).toBeVisible();

    await page.getByRole("textbox", { name: "Message" }).fill("first turn");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("button", { name: "Queue message" })).toBeVisible();

    await page.getByRole("textbox", { name: "Message" }).fill("second turn");
    await page.getByRole("button", { name: "Queue message" }).click();
    await expect(page.getByText("second turn")).toBeVisible();
    await expect.poll(() => execPrompts(recordPath)).toEqual(["first turn"]);

    await page.getByRole("textbox", { name: "Message" }).fill("draft survives");
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await page.getByLabel("Viewport marker").fill("center:12,8 zoom:2");
    await page.getByRole("button", { name: "Conversation", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("draft survives");
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await expect(page.getByLabel("Viewport marker")).toHaveValue("center:12,8 zoom:2");
    await page.getByRole("button", { name: "Conversation", exact: true }).click();

    await page.getByRole("button", { name: "README.md" }).click();
    await expect(page.getByLabel("Read-only file preview")).toContainText("after change");
    await expect(page.getByLabel("Git diff")).toContainText("+after change");

    writeFileSync(gatePath, "complete\n");
    await expect.poll(() => execPrompts(recordPath), { timeout: 20_000 }).toEqual([
      "first turn",
      "second turn",
    ]);
    await expect(page.getByText("second turn")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    expect(persistedTurnState(dataDir)).toEqual({
      statuses: ["completed", "completed"],
      pending: [],
      queuePaused: false,
    });

    rmSync(gatePath, { force: true });
    await page.getByRole("textbox", { name: "Message" }).fill("restart turn");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("button", { name: "Queue message" })).toBeVisible();
    await page.getByRole("textbox", { name: "Message" }).fill("after restart");
    await page.getByRole("button", { name: "Queue message" }).click();
    await expect(page.getByText("after restart")).toBeVisible();
    await expect.poll(() => execPrompts(recordPath)).toEqual([
      "first turn",
      "second turn",
      "restart turn",
    ]);

    await page.goto("about:blank");
    await stopDev(dev, [apiPort, webPort]);
    dev = await startDev({ dataDir, apiPort, webPort, token, gatePath, recordPath });
    await page.goto(webUrl);
    await expect(page.getByRole("button", { name: basename(projectDir) })).toBeVisible();
    await expect(page.getByText("Agent product: Codex")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry interrupted Turn" })).toBeVisible();
    await expect(page.getByText("after restart")).toBeVisible();
    expect(persistedTurnState(dataDir)).toEqual({
      statuses: ["completed", "completed", "interrupted"],
      pending: ["after restart"],
      queuePaused: true,
    });
    await page.waitForTimeout(500);
    expect(execPrompts(recordPath)).toEqual(["first turn", "second turn", "restart turn"]);

    await page.getByRole("button", { name: "Continue pending queue" }).click();
    await expect.poll(() => execPrompts(recordPath)).toEqual([
      "first turn",
      "second turn",
      "restart turn",
      "after restart",
    ]);
    writeFileSync(gatePath, "complete\n");
    await expect.poll(() => persistedEvents(dataDir), { timeout: 20_000 }).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "assistant_message", text: "hello from codex" }),
        expect.objectContaining({ type: "turn_status", status: "completed" }),
      ]),
    );
    await expect(page.getByText("after restart")).not.toBeVisible();
    await expect(page.getByText("hello from codex").first()).toBeVisible({ timeout: 20_000 });
    expect(persistedTurnState(dataDir)).toEqual({
      statuses: ["completed", "completed", "interrupted", "completed"],
      pending: [],
      queuePaused: false,
    });
  } finally {
    if (dev) {
      await stopDev(dev, [apiPort, webPort]);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function createGitProject(projectDir: string): void {
  mkdirSync(projectDir);
  const readme = join(projectDir, "README.md");
  writeFileSync(readme, "before change\n");
  execFileSync("git", ["init", "-q", projectDir]);
  execFileSync("git", ["-C", projectDir, "add", "README.md"]);
  execFileSync(
    "git",
    [
      "-C",
      projectDir,
      "-c",
      "user.name=Ain One E2E",
      "-c",
      "user.email=ain-one@example.invalid",
      "commit",
      "-qm",
      "baseline",
    ],
  );
  writeFileSync(readme, "after change\n");
}

async function startDev(input: {
  dataDir: string;
  apiPort: number;
  webPort: number;
  token: string;
  gatePath: string;
  recordPath: string;
}): Promise<ChildProcess> {
  const child = spawn("pnpm", ["dev"], {
    cwd: repositoryRoot,
    detached: true,
    env: {
      ...process.env,
      AIN_ONE_DATA_DIR: input.dataDir,
      AIN_ONE_PORT: String(input.apiPort),
      AIN_ONE_WEB_PORT: String(input.webPort),
      AIN_ONE_TOKEN: input.token,
      AIN_FIXTURE_SCENARIO: "wait-for-file",
      AIN_FIXTURE_GATE_PATH: input.gatePath,
      AIN_FIXTURE_RECORD_PATH: input.recordPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-8_000);
  });
  child.stderr?.on("data", (chunk) => {
    output = `${output}${String(chunk)}`.slice(-8_000);
  });
  await waitForHttp(`http://127.0.0.1:${input.webPort}`, child, () => output);
  return child;
}

async function stopDev(child: ChildProcess, ports: number[]): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (child.pid) {
    process.kill(-child.pid, "SIGTERM");
  }
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    process.kill(-child.pid, "SIGKILL");
  }
  await waitForPortsClosed(ports);
}

async function waitForPortsClosed(ports: number[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const occupied = await Promise.all(ports.map(isPortOpen));
    if (occupied.every((open) => !open)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`dev server ports did not close: ${ports.join(", ")}`);
}

async function isPortOpen(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}`);
    return true;
  } catch {
    return false;
  }
}

async function updateCodexExecutable(apiUrl: string, token: string): Promise<void> {
  const response = await fetch(`${apiUrl}/api/agents/codex/settings`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ executablePath: fakeCodex }),
  });
  expect(response.status).toBe(200);
}

async function openProject(apiUrl: string, token: string, path: string): Promise<void> {
  const response = await fetch(`${apiUrl}/api/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path }),
  });
  expect(response.status).toBe(201);
}

function execPrompts(recordPath: string): string[] {
  try {
    return readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { commandType?: string; stdin?: string })
      .filter((item) => item.commandType === "exec")
      .map((item) => item.stdin?.trim() ?? "");
  } catch {
    return [];
  }
}

function persistedEvents(dataDir: string): Array<{
  type: string;
  text?: string;
  status?: string;
}> {
  const database = new DatabaseSync(join(dataDir, "ain-one.sqlite"), { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 1000");
    return (database.prepare("SELECT type, payload_json FROM events ORDER BY sequence").all() as Array<{
      type: string;
      payload_json: string;
    }>).map((row) => {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      return {
        type: row.type,
        ...(typeof payload.text === "string" ? { text: payload.text } : {}),
        ...(typeof payload.status === "string" ? { status: payload.status } : {}),
      };
    });
  } finally {
    database.close();
  }
}

function persistedTurnState(dataDir: string): {
  statuses: string[];
  pending: string[];
  queuePaused: boolean;
} {
  const database = new DatabaseSync(join(dataDir, "ain-one.sqlite"), { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 1000");
    const statuses = database
      .prepare("SELECT status FROM turns ORDER BY rowid")
      .all() as Array<{ status: string }>;
    const pending = database
      .prepare("SELECT content FROM queued_messages WHERE status = 'pending' ORDER BY enqueue_seq")
      .all() as Array<{ content: string }>;
    const conversation = database
      .prepare("SELECT queue_paused FROM conversations LIMIT 1")
      .get() as { queue_paused: number };
    return {
      statuses: statuses.map((turn) => turn.status),
      pending: pending.map((message) => message.content),
      queuePaused: conversation.queue_paused === 1,
    };
  } finally {
    database.close();
  }
}

async function freePort(excluded = new Set<number>([6767])): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolvePromise, rejectPromise) => {
      const server = createServer();
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const selected = address && typeof address === "object" ? address.port : 0;
        server.close((error) => error ? rejectPromise(error) : resolvePromise(selected));
      });
    });
    if (!excluded.has(port)) {
      return port;
    }
  }
}

async function waitForHttp(
  url: string,
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`dev server exited before startup\n${output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`timed out waiting for ${url}\n${output()}`);
}
