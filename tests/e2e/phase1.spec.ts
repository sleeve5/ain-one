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

test("runs the Phase 1 Project, guarded send, canvases, and interrupted restart flow", async ({ page }) => {
  test.setTimeout(90_000);
  const root = mkdtempSync(join(tmpdir(), "ain-one-e2e-"));
  const dataDir = join(root, "data");
  const projectDir = join(root, "sample-project");
  const homeDir = join(root, "home");
  const gatePath = join(root, "complete-turns");
  const recordPath = join(root, "agent-invocations.jsonl");
  const token = "e2e-install-token";
  mkdirSync(dataDir);
  mkdirSync(homeDir);
  createGitProject(projectDir);

  const apiPort = await freePort();
  const webPort = await freePort(new Set([apiPort, 6767]));
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  let dev: ChildProcess | null = null;

  try {
    dev = await startDev({ dataDir, homeDir, apiPort, webPort, token, gatePath, recordPath });
    await page.addInitScript(() => globalThis.localStorage.setItem("ain-one:language", "en"));
    await page.route("**/api/host/pick-path?kind=file&purpose=agent&agentProductId=codex", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ path: fakeCodex }) });
    });
    await page.goto(webUrl);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Agent" }).click();
    const savedAgent = page.waitForResponse((response) =>
      response.url().endsWith("/api/agents/codex/settings") &&
      response.request().method() === "PUT" &&
      response.status() === 200,
    );
    const reloadedAgents = page.waitForResponse((response) =>
      response.url().endsWith("/api/agents") &&
      response.request().method() === "GET" &&
      response.status() === 200,
    );
    await page.getByRole("button", { name: "Import another Codex path" }).click();
    await savedAgent;
    await reloadedAgents;
    await expect(page.getByText("Version: 0.147.0")).toBeVisible();
    await page.getByRole("button", { name: "Close Settings" }).click();

    await page.route("**/api/projects/pick", async (route) => {
      const opened = await fetch(`${apiUrl}/api/projects`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path: projectDir }),
      });
      await route.fulfill({
        status: opened.status,
        contentType: "application/json",
        body: await opened.text(),
      });
    });
    await expect(page.getByRole("button", { name: "Open Project Folder" })).toBeVisible();
    await expect(page.getByLabel("Project path")).toHaveCount(0);
    await page.getByRole("button", { name: "Open Project Folder" }).click();
    await expect(page.locator(".project-sidebar__project-button").filter({ hasText: basename(projectDir) })).toBeVisible();
    await expect(page.getByRole("option", { name: "OpenCode" })).toHaveCount(0);

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Agent" }).click();
    await expect(page.getByText("OpenCode", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Close Settings" }).click();

    await expect(page.getByRole("heading", { name: "New conversation" })).toBeVisible();
    await expect(page.getByText("Codex", { exact: true }).first()).toBeVisible();

    await page.getByRole("textbox", { name: "Message" }).fill("first turn");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();

    await page.getByRole("textbox", { name: "Message" }).fill("second turn");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await expect.poll(() => execPrompts(recordPath)).toEqual(["first turn"]);

    await page.getByRole("textbox", { name: "Message" }).fill("draft survives");
    await page.getByRole("button", { name: "New graph" }).click();
    const autoSavedGraph = page.waitForResponse((response) => response.url().includes("/api/graphs/") && response.request().method() === "PUT" && response.status() === 200);
    await page.getByRole("button", { name: "Add Agent" }).click();
    await expect(page.getByTestId("graph-flow").getByText("Agent 2")).toBeVisible();
    await autoSavedGraph;
    await page.locator(".project-sidebar__resource-button").filter({ has: page.getByText("Chat", { exact: true }) }).first().click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("draft survives");
    await page.locator(".project-sidebar__resource-button").filter({ has: page.getByText("Graph", { exact: true }) }).first().click();
    await expect(page.getByTestId("graph-flow").getByText("Agent 2")).toBeVisible();
    await page.locator(".project-sidebar__resource-button").filter({ has: page.getByText("Chat", { exact: true }) }).first().click();

    writeFileSync(gatePath, "complete\n");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    await page.getByRole("textbox", { name: "Message" }).fill("second turn");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => execPrompts(recordPath), { timeout: 20_000 }).toEqual(["first turn", "second turn"]);
    await expect(page.locator(".conversation-message__body").getByText("second turn", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Unsent messages" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
    expect(persistedTurnState(dataDir)).toEqual({
      statuses: ["completed", "completed"],
      pending: [],
      queuePaused: false,
    });

    rmSync(gatePath, { force: true });
    await page.getByRole("textbox", { name: "Message" }).fill("restart turn");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await page.getByRole("textbox", { name: "Message" }).fill("after restart");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    await expect.poll(() => execPrompts(recordPath)).toEqual([
      "first turn",
      "second turn",
      "restart turn",
    ]);

    await page.goto("about:blank");
    await stopDev(dev, [apiPort, webPort]);
    dev = await startDev({ dataDir, homeDir, apiPort, webPort, token, gatePath, recordPath });
    await page.goto(webUrl);
    await expect(page.locator(".project-sidebar__project-button").filter({ hasText: basename(projectDir) })).toBeVisible();
    await expect(page.getByText("Codex", { exact: true }).first()).toBeVisible();
    expect(persistedTurnState(dataDir)).toEqual({
      statuses: ["completed", "completed", "cancelled"],
      pending: [],
      queuePaused: false,
    });
    await page.waitForTimeout(500);
    expect(execPrompts(recordPath)).toEqual(["first turn", "second turn", "restart turn"]);

    await page.getByRole("button", { name: "Restart project" }).click();
    await page.getByRole("textbox", { name: "Message" }).fill("after workspace restart");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect.poll(() => execPrompts(recordPath)).toEqual([
      "first turn",
      "second turn",
      "restart turn",
      "after workspace restart",
    ]);
    writeFileSync(gatePath, "complete\n");
    await expect.poll(() => persistedEvents(dataDir), { timeout: 20_000 }).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "assistant_message", text: "hello world" }),
        expect.objectContaining({ type: "turn_status", status: "completed" }),
      ]),
    );
    await expect(page.locator(".conversation-message__body").getByText("after workspace restart", { exact: true })).toBeVisible();
    await expect(page.getByText("hello world").first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => persistedTurnState(dataDir), { timeout: 20_000 }).toEqual({
      statuses: ["completed", "completed", "cancelled", "completed"],
      pending: [],
      queuePaused: false,
    });

    await page.locator(".project-sidebar__resource-button").filter({ has: page.getByText("Graph", { exact: true }) }).first().click();
    await page.getByTestId("graph-flow").getByText("Agent 2").click();
    await page.getByRole("button", { name: "Delete node" }).click();
    await page.getByLabel("Task").fill("improve this draft");
    await expect(page.getByRole("button", { name: "Run graph" })).toBeEnabled();
    const savedGraph = page.waitForResponse((response) => response.url().includes("/api/graphs/") && response.request().method() === "PUT" && response.status() === 200);
    await page.getByRole("button", { name: "Run graph" }).click();
    await savedGraph;
    await expect(page.locator(".graph-run-state [data-status=completed]")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".graph-node[data-kind=agent]")).toHaveAttribute("data-status", "completed");

    await page.reload();
    await page.locator(".project-sidebar__resource-button").filter({ has: page.getByText("Graph", { exact: true }) }).first().click();
    await expect(page.locator(".graph-run-state [data-status=completed]")).toBeVisible({ timeout: 20_000 });
    const nodes = page.locator(".react-flow__node");
    const pane = page.locator(".react-flow__pane");
    await expect(nodes).toHaveCount(3);
    const paneBox = await pane.boundingBox();
    const nodeBoxes = await nodes.evaluateAll((items) => items.map((item) => { const box = item.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; }));
    if (!paneBox || nodeBoxes.length === 0) throw new Error("Graph canvas was not measurable");
    await page.mouse.move(Math.max(paneBox.x + 2, Math.min(...nodeBoxes.map((box) => box.left)) - 12), Math.max(paneBox.y + 2, Math.min(...nodeBoxes.map((box) => box.top)) - 12));
    await page.mouse.down();
    await page.mouse.move(Math.min(paneBox.x + paneBox.width - 2, Math.max(...nodeBoxes.map((box) => box.right)) + 12), Math.min(paneBox.y + paneBox.height - 2, Math.max(...nodeBoxes.map((box) => box.bottom)) + 12), { steps: 8 });
    await page.mouse.up();
    await expect(page.locator(".graph-node[data-selected=true]")).toHaveCount(3);
    await expect(page.locator(".react-flow__nodesselection")).toBeHidden();
    await page.keyboard.press("Delete");
    await expect(nodes).toHaveCount(0);
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  } finally {
    if (dev) {
      await stopDev(dev, [apiPort, webPort]);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  homeDir: string;
  apiPort: number;
  webPort: number;
  token: string;
  gatePath: string;
  recordPath: string;
}): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(repositoryRoot, "node_modules/vite/bin/vite.js")], {
    cwd: repositoryRoot,
    detached: true,
    env: {
      ...process.env,
      HOME: input.homeDir,
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
