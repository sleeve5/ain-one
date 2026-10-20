import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { beginTraeQueueTurn, deliverToWaitingTraeQueue, readTraeQueueStatus } from "../../src/server/connectors/trae-queue-bridge.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Trae Queue bridge", () => {
  it("stages input while a native Turn is processing", async () => {
    const root = join(tmpdir(), `ain-one-trae-queue-${randomUUID()}`);
    roots.push(root);
    await beginTraeQueueTurn({ home: root, sessionId: "session-a" });

    await expect(deliverToWaitingTraeQueue({
      home: root, sessionId: "session-a", messageId: "message-a", deliveryId: "delivery-a", content: "adjust after this tool",
    })).resolves.toBe(true);
    await expect(readTraeQueueStatus({ home: root, sessionId: "session-a" })).resolves.toEqual({
      status: "processing", hasPendingInput: true, acceptingInput: true,
    });
  });

  it("rejects delivery from a stale runtime lease", async () => {
    const root = join(tmpdir(), `ain-one-trae-queue-${randomUUID()}`);
    roots.push(root);
    await beginTraeQueueTurn({ home: root, sessionId: "session-a", leaseId: "current-lease" });

    await expect(deliverToWaitingTraeQueue({
      home: root, sessionId: "session-a", leaseId: "stale-lease",
      messageId: "message-a", deliveryId: "delivery-a", content: "must not leak",
    })).resolves.toBe(false);
    await expect(readTraeQueueStatus({
      home: root, sessionId: "session-a", leaseId: "stale-lease",
    })).resolves.toEqual({ status: "inactive", hasPendingInput: false, acceptingInput: false });
  });

  it("does not let a stale SessionEnd hook delete the current runtime lease", async () => {
    const root = join(tmpdir(), `ain-one-trae-queue-${randomUUID()}`);
    roots.push(root);
    const hook = join(process.cwd(), "src/server/connectors/trae-queue-hook.mjs");
    await beginTraeQueueTurn({ home: root, sessionId: "session-a", leaseId: "current-lease" });
    const child = spawn(process.execPath, [hook, "old-lease"], {
      env: { ...process.env, TRAE_QUEUE_HOME: root },
    });
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", session_id: "session-a" }));
    await waitForExit(child);

    await expect(readTraeQueueStatus({
      home: root, sessionId: "session-a", leaseId: "current-lease",
    })).resolves.toMatchObject({ status: "processing", acceptingInput: true });
  });

  it("preserves the last acknowledgement when Stop immediately enters waiting again", async () => {
    const root = join(tmpdir(), `ain-one-trae-queue-${randomUUID()}`);
    roots.push(root);
    const hook = join(process.cwd(), "src/server/connectors/trae-queue-hook.mjs");
    const sessionRoot = join(root, "hook-sessions", "session-a");
    const statePath = join(sessionRoot, "state.json");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(statePath, JSON.stringify({
      stateId: "state-a", leaseId: "lease-a", sessionId: "session-a",
      status: "processing", acceptingInput: true,
      lastAcknowledged: { messageId: "message-a", deliveryId: "delivery-a" },
    }));
    const child = spawn(process.execPath, [hook, "lease-a"], { env: { ...process.env, TRAE_QUEUE_HOME: root } });
    child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "session-a" }));

    await waitForState(statePath, (state) => state.status === "waiting");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      lastAcknowledged: { messageId: "message-a", deliveryId: "delivery-a" },
    });
    await rm(sessionRoot, { recursive: true, force: true });
    await waitForExit(child);
  });

  it("starts a native Turn with fresh state instead of replaying stale input", async () => {
    const root = join(tmpdir(), `ain-one-trae-queue-${randomUUID()}`);
    roots.push(root);
    const sessionRoot = join(root, "hook-sessions", "session-a");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(join(sessionRoot, "state.json"), JSON.stringify({
      status: "processing", acceptingInput: true, pendingInput: { text: "stale task" },
    }));

    await beginTraeQueueTurn({ home: root, sessionId: "session-a" });

    expect(JSON.parse(await readFile(join(sessionRoot, "state.json"), "utf8")))
      .not.toHaveProperty("pendingInput");
  });

  it("injects one staged FIFO message after a tool completes", async () => {
    const root = join(tmpdir(), `ain-one-trae-queue-${randomUUID()}`);
    roots.push(root);
    const hook = join(process.cwd(), "src/server/connectors/trae-queue-hook.mjs");
    const sessionRoot = join(root, "hook-sessions", "session-a");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(join(sessionRoot, "state.json"), JSON.stringify({
      stateId: "state-a", sessionId: "session-a", status: "processing", acceptingInput: false,
      safePointId: "before-tool",
      pendingInput: { messageId: "message-a", deliveryId: "delivery-a", text: "adjust the target" },
    }));

    const child = spawn(process.execPath, [hook], { env: { ...process.env, TRAE_QUEUE_HOME: root } });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stdin.end(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "session-a" }));
    await waitForExit(child);

    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "adjust the target",
      },
    });
    const state = JSON.parse(await readFile(join(sessionRoot, "state.json"), "utf8"));
    expect(state).not.toHaveProperty("pendingInput");
    expect(state.safePointId).not.toBe("before-tool");
    expect(state.lastAcknowledged).toEqual({ messageId: "message-a", deliveryId: "delivery-a" });
  });

  it("keeps the waiting Hook alive while the bridge temporarily claims its state file", async () => {
    const root = join(tmpdir(), `ain-one-trae-queue-${randomUUID()}`);
    roots.push(root);
    const hook = join(process.cwd(), "src/server/connectors/trae-queue-hook.mjs");
    const statePath = join(root, "hook-sessions", "session-a", "state.json");
    const claimedPath = `${statePath}.claimed`;
    const child = spawn(process.execPath, [hook], { env: { ...process.env, TRAE_QUEUE_HOME: root } });
    const exited = waitForExit(child);
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "session-a" }));

    await waitForFile(statePath);
    await rename(statePath, claimedPath);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const state = JSON.parse(await readFile(claimedPath, "utf8"));
    await writeFile(claimedPath, JSON.stringify({ ...state, pendingInput: { text: "next task" } }));
    await rename(claimedPath, statePath);

    await exited;
    expect(JSON.parse(stdout)).toMatchObject({ decision: "block" });
  });

  it("atomically delivers input only to a live waiting Hook session", async () => {
    const root = join(tmpdir(), `ain-one-trae-queue-${randomUUID()}`);
    roots.push(root);
    const sessionId = "session-a";
    const sessionRoot = join(root, "hook-sessions", sessionId);
    const statePath = join(sessionRoot, "state.json");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(statePath, JSON.stringify({
      stateId: "state-a",
      sessionId,
      status: "waiting",
      waitId: "wait-a",
      waiterPid: process.pid,
    }));

    await expect(deliverToWaitingTraeQueue({
      home: root,
      sessionId,
      messageId: "message-a",
      deliveryId: "delivery-a",
      content: "next task",
    })).resolves.toBe(true);

    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    expect(state).toMatchObject({
      status: "waiting",
      waitId: "wait-a",
      pendingInput: { messageId: "message-a", deliveryId: "delivery-a", text: "next task" },
    });
  });

  it("leaves input in the Ain One queue while the Hook is still processing", async () => {
    const root = join(tmpdir(), `ain-one-trae-queue-${randomUUID()}`);
    roots.push(root);
    const sessionRoot = join(root, "hook-sessions", "session-a");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(join(sessionRoot, "state.json"), JSON.stringify({
      stateId: "state-a", sessionId: "session-a", status: "processing",
    }));

    await expect(deliverToWaitingTraeQueue({
      home: root, sessionId: "session-a", messageId: "message-a", deliveryId: "delivery-a", content: "next task",
    })).resolves.toBe(false);
    expect(JSON.parse(await readFile(join(sessionRoot, "state.json"), "utf8")))
      .toEqual({ stateId: "state-a", sessionId: "session-a", status: "processing" });
  });

  it.each(["inactive", "waiting-with-input", "dead-waiter"])(
    "does not deliver when the Hook state is %s",
    async (scenario) => {
      const root = join(tmpdir(), `ain-one-trae-queue-${randomUUID()}`);
      roots.push(root);
      const sessionRoot = join(root, "hook-sessions", "session-a");
      await mkdir(sessionRoot, { recursive: true });
      await writeFile(join(sessionRoot, "state.json"), JSON.stringify({
        stateId: "state-a",
        sessionId: "session-a",
        status: scenario === "inactive" ? "inactive" : "waiting",
        waitId: scenario === "inactive" ? undefined : "wait-a",
        waiterPid: scenario === "dead-waiter" ? 999_999_999 : process.pid,
        pendingInput: scenario === "waiting-with-input" ? { text: "first" } : undefined,
      }));

      await expect(deliverToWaitingTraeQueue({
        home: root,
        sessionId: "session-a",
        messageId: "message-a",
        deliveryId: "delivery-a",
        content: "next task",
      })).resolves.toBe(false);
    },
  );

  it("accepts only one of two concurrent deliveries", async () => {
    const root = join(tmpdir(), `ain-one-trae-queue-${randomUUID()}`);
    roots.push(root);
    const sessionRoot = join(root, "hook-sessions", "session-a");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(join(sessionRoot, "state.json"), JSON.stringify({
      stateId: "state-a", sessionId: "session-a", status: "waiting",
      waitId: "wait-a", waiterPid: process.pid,
    }));

    const delivered = await Promise.all(["first", "second"].map((content, index) =>
      deliverToWaitingTraeQueue({ home: root, sessionId: "session-a", messageId: `message-${index}`, deliveryId: `delivery-${index}`, content })
    ));

    expect(delivered.filter(Boolean)).toHaveLength(1);
    const state = JSON.parse(await readFile(join(sessionRoot, "state.json"), "utf8"));
    expect(["first", "second"]).toContain(state.pendingInput.text);
  });

  it("reports only live hook states and never invents a queue position", async () => {
    const root = join(tmpdir(), `ain-one-trae-queue-${randomUUID()}`);
    roots.push(root);
    const sessionRoot = join(root, "hook-sessions", "session-a");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(join(sessionRoot, "state.json"), JSON.stringify({
      stateId: "state-a", sessionId: "session-a", status: "waiting",
      waitId: "wait-a", waiterPid: process.pid, pendingInput: { text: "next" },
    }));

    await expect(readTraeQueueStatus({ home: root, sessionId: "session-a" })).resolves.toEqual({
      status: "waiting",
      hasPendingInput: true,
      acceptingInput: true,
    });

    await writeFile(join(sessionRoot, "state.json"), JSON.stringify({
      stateId: "state-a", sessionId: "session-a", status: "waiting",
      waitId: "wait-a", waiterPid: 999_999_999,
    }));
    await expect(readTraeQueueStatus({ home: root, sessionId: "session-a" })).resolves.toEqual({
      status: "inactive",
      hasPendingInput: false,
      acceptingInput: false,
    });
  });
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { await readFile(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForState(path: string, predicate: (state: Record<string, unknown>) => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (predicate(state)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for state in ${path}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Hook did not exit")); }, 2_000);
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
