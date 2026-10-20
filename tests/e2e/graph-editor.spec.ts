import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("selects boxed nodes and their connections and supports editor shortcuts", async ({ page }) => {
  test.setTimeout(150_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
  const root = mkdtempSync(join(tmpdir(), "ain-one-graph-e2e-"));
  const dataDir = join(root, "data");
  const projectDir = join(root, "project");
  const homeDir = join(root, "home");
  mkdirSync(dataDir);
  mkdirSync(projectDir);
  mkdirSync(homeDir);
  const token = "graph-e2e-token";
  const apiPort = await freePort();
  const webPort = await freePort(new Set([apiPort, 6767]));
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  let dev: ChildProcess | null = null;

  try {
    dev = await startDev({ dataDir, homeDir, apiPort, webPort, token });
    const project = await api<{ project: { id: string } }>(apiUrl, token, "/api/projects", { path: projectDir });
    const created = await api<{ graph: { id: string } }>(apiUrl, token, `/api/projects/${project.project.id}/graphs`, starterGraph);
    await page.addInitScript(() => globalThis.localStorage.setItem("ain-one:language", "en"));
    await page.goto(webUrl);
    await page.getByRole("button", { name: "Open Graph configuration" }).click();
    const configuration = page.getByLabel("Graph configuration JSON");
    const portable = JSON.parse(await configuration.inputValue()) as Record<string, unknown>;
    expect(portable).not.toHaveProperty("projectId");
    expect(portable).not.toHaveProperty("createdAt");
    delete portable.positions;
    delete portable.viewport;
    portable.name = "Configured E2E";
    await configuration.fill(JSON.stringify(portable));
    await page.getByRole("button", { name: "Auto layout" }).click();
    await page.getByRole("button", { name: "Save configuration" }).click();
    await expect(page.getByRole("heading", { name: "Configured E2E" })).toBeVisible();
    await expect.poll(async () => {
      const detail = await api<{ graph: { name: string; positions: Record<string, unknown> } }>(apiUrl, token, `/api/graphs/${created.graph.id}`, undefined, "GET");
      return { name: detail.graph.name, positions: Object.keys(detail.graph.positions).length };
    }).toEqual({ name: "Configured E2E", positions: 3 });

    const flow = page.getByTestId("graph-flow");
    const nodes = flow.locator(".react-flow__node");
    await expect(nodes).toHaveCount(3);
    await expect(flow.locator(".react-flow__edge")).toHaveCount(2);
    const connectionGeometry = await flow.evaluate((root) => {
      const edge = root.querySelector<SVGGElement>('[data-testid="rf__edge-input-agent"]');
      const path = edge?.querySelector<SVGPathElement>(".react-flow__edge-path");
      const arrow = edge?.querySelector<SVGPathElement>(".graph-edge-arrow");
      const handle = root.querySelector<HTMLElement>('[data-nodeid="agent-1"][data-handleid="task"]');
      const node = root.querySelector<HTMLElement>('[data-testid="rf__node-agent-1"] .graph-node');
      if (!path || !arrow || !handle || !node) throw new Error("Connection geometry was not rendered");
      const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM()!);
      const arrowBox = arrow.getBoundingClientRect();
      const handleBox = handle.getBoundingClientRect();
      return { pathEndX: end.x, arrowLeft: arrowBox.left, arrowRight: arrowBox.right, handleLeft: handleBox.left, marker: path.getAttribute("marker-end"), overflow: getComputedStyle(node).overflow };
    });
    expect(connectionGeometry.marker).toBeNull();
    expect(connectionGeometry.overflow).toBe("visible");
    expect(Math.abs(connectionGeometry.pathEndX - connectionGeometry.arrowLeft)).toBeLessThan(1);
    expect(Math.abs(connectionGeometry.arrowRight - connectionGeometry.handleLeft), JSON.stringify(connectionGeometry)).toBeLessThan(1);
    await nodes.filter({ hasText: "Agent 1" }).click();
    await page.getByRole("button", { name: "Insert Task parameter" }).click();
    await expect(page.getByLabel("Instruction")).toContainText("Complete the task.Task");
    await expect(page.getByLabel("Instruction").locator("[data-parameter-id=task]")).toHaveText("Task");
    const firstEdgePath = flow.locator(".react-flow__edge-path").first();
    await expect(firstEdgePath).not.toHaveAttribute("d", /Q/);
    await expect(firstEdgePath).toHaveAttribute("d", /^M [^Q]+ L [^Q]+$/);
    await expect(page.getByRole("textbox", { name: "Task" })).toHaveCSS("cursor", "text");
    await expect.poll(async () => {
      const response = await fetch(`${apiUrl}/api/graphs/${created.graph.id}`, { headers: { authorization: `Bearer ${token}` } });
      const detail = await response.json() as { graph: { definition: { nodes: Array<{ id: string; config?: { instruction?: string } }> } } };
      return detail.graph.definition.nodes.find((node) => node.id === "agent-1")?.config?.instruction;
    }).toBe("Complete the task.{{task}}");
    await flow.locator(".react-flow__edge").first().click({ force: true });
    await expect(firstEdgePath).toHaveCSS("stroke-width", "2px");
    await expect(firstEdgePath).toHaveCSS("stroke", "rgb(79, 131, 209)");
    await expect(flow.locator(".graph-edge-segment").first()).toHaveCSS("stroke", "rgba(0, 0, 0, 0)");
    const route = flow.locator(".graph-edge-segment--middle").first();
    await expect(route).toHaveCount(1);
    await expect(route).not.toHaveAttribute("role");
    await expect(route).not.toHaveAttribute("tabindex");
    const routeBox = await route.boundingBox();
    if (!routeBox) throw new Error("Connection route handle was not measurable");
    await page.mouse.move(routeBox.x + routeBox.width / 2, routeBox.y + routeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(routeBox.x + 48, routeBox.y + 32, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => {
      const response = await fetch(`${apiUrl}/api/graphs/${created.graph.id}`, { headers: { authorization: `Bearer ${token}` } });
      const detail = await response.json() as { graph: { definition: { edges: Array<{ route?: { x: number; y: number } }> } } };
      return Boolean(detail.graph.definition.edges[0]?.route);
    }).toBe(true);
    await expect(firstEdgePath).toHaveAttribute("d", /Q/);
    expect(await firstEdgePath.getAttribute("d")).toContain(" L ");

    const paneBox = await flow.locator(".react-flow__pane").boundingBox();
    const boxes = await nodes.evaluateAll((items) => items.map((item) => {
      const box = item.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    }));
    if (!paneBox || boxes.length !== 3) throw new Error("Graph canvas was not measurable");
    await page.mouse.move(Math.max(paneBox.x + 2, Math.min(...boxes.map((box) => box.left)) - 12), Math.max(paneBox.y + 2, Math.min(...boxes.map((box) => box.top)) - 12));
    await page.mouse.down();
    await page.mouse.move(Math.min(paneBox.x + paneBox.width - 2, Math.max(...boxes.map((box) => box.right)) + 12), Math.min(paneBox.y + paneBox.height - 2, Math.max(...boxes.map((box) => box.bottom)) + 12), { steps: 8 });
    await page.mouse.up();

    await expect(flow.locator(".graph-node[data-selected=true]")).toHaveCount(3);
    await expect(flow.locator(".react-flow__edge.selected")).toHaveCount(2);
    await expect(flow.locator(".react-flow__nodesselection")).toBeHidden();

    await page.keyboard.press("Meta+c");
    await page.keyboard.press("Meta+v");
    await expect(nodes).toHaveCount(4);
    await page.keyboard.press("Meta+x");
    await expect(nodes).toHaveCount(3);

    const task = page.getByLabel("Task");
    await task.fill("keep this text");
    await page.keyboard.press("Meta+a");
    const stateAfterInputShortcut = await page.evaluate(() => ({
      active: document.activeElement?.outerHTML,
      canvas: Boolean(document.querySelector("[data-testid=graph-canvas]")),
      inputs: [...document.querySelectorAll("input, textarea")].map((item) => ({ label: item.getAttribute("aria-label"), value: (item as HTMLInputElement).value })),
      body: document.body.innerText.slice(0, 2_000),
    }));
    if (!stateAfterInputShortcut.canvas || !stateAfterInputShortcut.inputs.some((input) => input.label === "Task" && input.value === "keep this text")) {
      throw new Error(`${JSON.stringify(stateAfterInputShortcut, null, 2)}\n${browserErrors.join("\n")}`);
    }

    await flow.click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Meta+a");
    await expect(flow.locator(".graph-node[data-selected=true]")).toHaveCount(3);
    await page.keyboard.press("Backspace");
    await expect(nodes).toHaveCount(0);
    await expect(flow.locator(".react-flow__edge")).toHaveCount(0);
  } finally {
    if (dev) await stopDev(dev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("reruns and deletes Graph history through the Edge client", async ({ page }) => {
  test.setTimeout(150_000);
  const root = mkdtempSync(join(tmpdir(), "ain-one-graph-history-e2e-"));
  const dataDir = join(root, "data");
  const projectDir = join(root, "project");
  const homeDir = join(root, "home");
  mkdirSync(dataDir); mkdirSync(projectDir); mkdirSync(homeDir);
  const token = "graph-history-e2e-token";
  const apiPort = await freePort();
  const webPort = await freePort(new Set([apiPort, 6767]));
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  let dev: ChildProcess | null = null;
  try {
    dev = await startDev({ dataDir, homeDir, apiPort, webPort, token });
    const project = await api<{ project: { id: string } }>(apiUrl, token, "/api/projects", { path: projectDir });
    const created = await api<{ graph: { id: string } }>(apiUrl, token, `/api/projects/${project.project.id}/graphs`, directGraph);
    const first = await api<{ run: { id: string } }>(apiUrl, token, `/api/graphs/${created.graph.id}/runs`, { input: { task: "first run" } });
    await expect.poll(async () => (await api<{ run: { status: string } }>(apiUrl, token, `/api/graph-runs/${first.run.id}`, undefined, "GET")).run.status).toBe("completed");

    await page.addInitScript(() => globalThis.localStorage.setItem("ain-one:language", "en"));
    await page.goto(webUrl);
    await page.getByRole("button", { name: "Latest run" }).click();
    await expect(page.getByRole("button", { name: `Rerun ${first.run.id}` })).toBeVisible();
    const statusWidth = await page.getByRole("button", { name: `Run ${first.run.id}` }).locator(".graph-status").evaluate((status) => status.getBoundingClientRect().width);
    expect(statusWidth).toBeLessThan(90);
    const disabledRerun = page.getByRole("button", { name: `Rerun ${first.run.id}` });
    await disabledRerun.evaluate((button: HTMLButtonElement) => { button.disabled = true; });
    await expect(disabledRerun).toBeDisabled();
    await expect(disabledRerun).toHaveCSS("opacity", "1");
    await disabledRerun.evaluate((button: HTMLButtonElement) => { button.disabled = false; });
    await page.getByRole("button", { name: `Rerun ${first.run.id}` }).click();
    await expect.poll(async () => (await api<{ runs: unknown[] }>(apiUrl, token, `/api/graphs/${created.graph.id}/runs`, undefined, "GET")).runs.length).toBe(2);
    await page.getByRole("button", { name: `Delete ${first.run.id}` }).click();
    await expect(page.getByRole("dialog", { name: "Delete run" })).toBeVisible();
    await page.getByRole("button", { name: "Confirm run deletion" }).click();
    await expect(page.getByRole("button", { name: `Run ${first.run.id}` })).toHaveCount(0);
    await expect.poll(async () => (await fetch(`${apiUrl}/api/graph-runs/${first.run.id}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  } finally {
    if (dev) await stopDev(dev);
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps Loop return edges connected outside node cards", async ({ page }) => {
  test.setTimeout(150_000);
  const root = mkdtempSync(join(tmpdir(), "ain-one-graph-loop-edge-e2e-"));
  const dataDir = join(root, "data");
  const projectDir = join(root, "project");
  const homeDir = join(root, "home");
  mkdirSync(dataDir); mkdirSync(projectDir); mkdirSync(homeDir);
  const token = "graph-loop-edge-e2e-token";
  const apiPort = await freePort();
  const webPort = await freePort(new Set([apiPort, 6767]));
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  let dev: ChildProcess | null = null;
  try {
    dev = await startDev({ dataDir, homeDir, apiPort, webPort, token });
    const project = await api<{ project: { id: string } }>(apiUrl, token, "/api/projects", { path: projectDir });
    await api(apiUrl, token, `/api/projects/${project.project.id}/graphs`, loopGraph);
    await page.addInitScript(() => globalThis.localStorage.setItem("ain-one:language", "en"));
    await page.goto(webUrl);

    const flow = page.getByTestId("graph-flow");
    await expect(flow.locator('[data-testid="rf__edge-loop-feedback"]')).toBeVisible();
    const geometry = await flow.evaluate((root) => {
      const edge = root.querySelector<SVGGElement>('[data-testid="rf__edge-loop-feedback"]');
      const path = edge?.querySelector<SVGPathElement>(".react-flow__edge-path");
      const arrow = edge?.querySelector<SVGPathElement>(".graph-edge-arrow");
      const source = root.querySelector<HTMLElement>('[data-nodeid="loop-1"][data-handleid="loop"]');
      const target = root.querySelector<HTMLElement>('[data-nodeid="agent-1"][data-handleid="feedback"]');
      const cards = [...root.querySelectorAll<HTMLElement>(".graph-node")].map((node) => node.getBoundingClientRect());
      if (!path || !arrow || !source || !target) throw new Error("Loop edge geometry was not rendered");
      const transform = path.getScreenCTM()!;
      const start = path.getPointAtLength(0).matrixTransform(transform);
      const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(transform);
      const sourceBox = source.getBoundingClientRect();
      const targetBox = target.getBoundingClientRect();
      const arrowBox = arrow.getBoundingClientRect();
      const samples = Array.from({ length: 199 }, (_, index) => {
        const point = path.getPointAtLength(path.getTotalLength() * (index + 1) / 200).matrixTransform(transform);
        return cards.some((card) => point.x > card.left + 1 && point.x < card.right - 1 && point.y > card.top + 1 && point.y < card.bottom - 1);
      });
      return {
        d: path.getAttribute("d"),
        sourceGap: Math.abs(start.x - sourceBox.right),
        targetGap: Math.abs(arrowBox.right - targetBox.left),
        pathArrowGap: Math.abs(end.x - arrowBox.left),
        arrowOutsideTarget: arrowBox.right <= targetBox.left + 0.5,
        arrowPointsTowardTarget: arrowBox.right > arrowBox.left && end.x < arrowBox.right,
        crossesCard: samples.some(Boolean),
      };
    });
    expect(geometry.d?.match(/ Q /g)).toHaveLength(4);
    expect(geometry.sourceGap, JSON.stringify(geometry)).toBeLessThan(1);
    expect(geometry.targetGap, JSON.stringify(geometry)).toBeLessThan(1);
    expect(geometry.pathArrowGap, JSON.stringify(geometry)).toBeLessThan(1);
    expect(geometry.arrowOutsideTarget, JSON.stringify(geometry)).toBe(true);
    expect(geometry.arrowPointsTowardTarget, JSON.stringify(geometry)).toBe(true);
    expect(geometry.crossesCard, JSON.stringify(geometry)).toBe(false);
  } finally {
    if (dev) await stopDev(dev);
    rmSync(root, { recursive: true, force: true });
  }
});

const starterGraph = {
  name: "Graph E2E",
  description: "",
  definition: {
    nodes: [
      { id: "input-1", type: "input", name: "User Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } },
      { id: "agent-1", type: "agent", name: "Agent 1", config: { agentProductId: "codex", modelId: null, permissionMode: "request_approval", instruction: "Complete the task.", inputs: [{ id: "task", name: "Task", required: true }], outputs: [{ id: "result", name: "Result" }] } },
      { id: "output-1", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
    ],
    edges: [
      { id: "input-agent", source: "input-1", sourcePort: "task", target: "agent-1", targetPort: "task" },
      { id: "agent-output", source: "agent-1", sourcePort: "result", target: "output-1", targetPort: "result" },
    ],
    start: ["input-1"],
    end: ["output-1"],
  },
  viewport: { x: 0, y: 0, zoom: 1 },
  positions: { "input-1": { x: 80, y: 180 }, "agent-1": { x: 350, y: 180 }, "output-1": { x: 640, y: 180 } },
};

const loopGraph = {
  name: "Loop edge E2E",
  description: "",
  definition: {
    nodes: [
      { id: "input-1", type: "input", name: "User Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } },
      { id: "agent-1", type: "agent", name: "Agent 1", config: { agentProductId: "codex", modelId: null, permissionMode: "request_approval", instruction: "", inputs: [{ id: "task", name: "Task", required: true }, { id: "feedback", name: "Feedback", required: false, kind: "feedback" }], outputs: [{ id: "result", name: "Result" }] } },
      { id: "loop-1", type: "loop_counter", name: "Loop 1", config: { maxIterations: 3 } },
      { id: "output-1", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
    ],
    edges: [
      { id: "input-agent", source: "input-1", sourcePort: "task", target: "agent-1", targetPort: "task" },
      { id: "agent-loop", source: "agent-1", sourcePort: "result", target: "loop-1", targetPort: "input" },
      { id: "loop-feedback", source: "loop-1", sourcePort: "loop", target: "agent-1", targetPort: "feedback", condition: { branch: "loop" }, route: { x: 848, y: 380, targetX: 328 } },
      { id: "loop-output", source: "loop-1", sourcePort: "done", target: "output-1", targetPort: "result", condition: { branch: "done" } },
    ],
    start: ["input-1"],
    end: ["output-1"],
  },
  viewport: { x: 0, y: 0, zoom: 1 },
  positions: { "input-1": { x: 80, y: 80 }, "agent-1": { x: 360, y: 80 }, "loop-1": { x: 640, y: 220 }, "output-1": { x: 920, y: 220 } },
};

const directGraph = {
  name: "Run history E2E", description: "",
  definition: {
    nodes: [
      { id: "input-1", type: "input", name: "User Input", config: { fields: [{ id: "task", name: "Task", description: "", required: true, multiline: true }] } },
      { id: "output-1", type: "output", name: "Output", config: { fields: [{ id: "result", name: "Result", required: true }] } },
    ],
    edges: [{ id: "input-output", source: "input-1", sourcePort: "task", target: "output-1", targetPort: "result" }],
    start: ["input-1"], end: ["output-1"],
  },
  viewport: { x: 0, y: 0, zoom: 1 },
  positions: { "input-1": { x: 120, y: 180 }, "output-1": { x: 460, y: 180 } },
};

async function api<T = unknown>(baseUrl: string, token: string, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined || method === "GET" ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function startDev(input: { dataDir: string; homeDir: string; apiPort: number; webPort: number; token: string }): Promise<ChildProcess> {
  const child = spawn(process.execPath, [join(repositoryRoot, "node_modules/vite/bin/vite.js")], {
    cwd: repositoryRoot,
    detached: true,
    env: { ...process.env, HOME: input.homeDir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, AIN_ONE_DATA_DIR: input.dataDir, AIN_ONE_PORT: String(input.apiPort), AIN_ONE_WEB_PORT: String(input.webPort), AIN_ONE_TOKEN: input.token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
  child.stderr?.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dev server exited early\n${output}`);
    try { const response = await fetch(`http://127.0.0.1:${input.webPort}`); if (response.ok) return child; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for dev server\n${output}`);
}

async function stopDev(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  process.kill(-child.pid, "SIGTERM");
  await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
}

async function freePort(excluded = new Set<number>([6767])): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close((error) => error ? reject(error) : resolve(address && typeof address === "object" ? address.port : 0));
      });
    });
    if (!excluded.has(port)) return port;
  }
}
