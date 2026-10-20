import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface TraeQueueState {
  status?: unknown;
  acceptingInput?: unknown;
  waitId?: unknown;
  waiterPid?: unknown;
  pendingInput?: unknown;
  safePointId?: unknown;
  lastAcknowledged?: unknown;
  leaseId?: unknown;
  [key: string]: unknown;
}

export function resolveTraeQueueHome(env: NodeJS.ProcessEnv): string {
  return env.TRAE_QUEUE_HOME
    ? resolve(env.TRAE_QUEUE_HOME)
    : join(env.HOME || homedir(), ".trae", "queue-runtime");
}

export async function readTraeQueueStatus(input: {
  home: string;
  sessionId: string;
  leaseId?: string;
}): Promise<{
  status: "inactive" | "processing" | "waiting";
  hasPendingInput: boolean;
  acceptingInput: boolean;
  safePointId?: string;
  acknowledged?: { messageId: string; deliveryId: string };
}> {
  const target = join(input.home, "hook-sessions", sanitizeSessionId(input.sessionId), "state.json");
  try {
    const state = JSON.parse(await readFile(target, "utf8")) as TraeQueueState;
    if (input.leaseId && state.leaseId !== input.leaseId) {
      return { status: "inactive", hasPendingInput: false, acceptingInput: false };
    }
    const waiting = state.status === "waiting"
      && typeof state.waitId === "string"
      && isProcessAlive(state.waiterPid);
    const acknowledged = readAcknowledgement(state.lastAcknowledged);
    return {
      status: waiting ? "waiting" : state.status === "processing" ? "processing" : "inactive",
      hasPendingInput: state.pendingInput != null,
      acceptingInput: waiting || (state.status === "processing" && state.acceptingInput === true),
      ...(typeof state.safePointId === "string" ? { safePointId: state.safePointId } : {}),
      ...(acknowledged ? { acknowledged } : {}),
    };
  } catch (error) {
    if (isErrno(error, "ENOENT") || error instanceof SyntaxError) {
      return { status: "inactive", hasPendingInput: false, acceptingInput: false };
    }
    throw error;
  }
}

function readAcknowledgement(value: unknown): { messageId: string; deliveryId: string } | null {
  if (!value || typeof value !== "object") return null;
  const { messageId, deliveryId } = value as Record<string, unknown>;
  return typeof messageId === "string" && typeof deliveryId === "string" ? { messageId, deliveryId } : null;
}

export async function beginTraeQueueTurn(input: { home: string; sessionId: string; leaseId?: string }): Promise<void> {
  const sessionId = sanitizeSessionId(input.sessionId);
  const root = join(input.home, "hook-sessions", sessionId);
  const target = join(root, "state.json");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify({
    stateId: randomUUID(), leaseId: input.leaseId, sessionId, status: "processing", acceptingInput: true,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export async function cancelTraeQueueWait(input: { home: string; sessionId: string }): Promise<void> {
  await rm(join(input.home, "hook-sessions", sanitizeSessionId(input.sessionId)), { recursive: true, force: true });
}

export async function deliverToWaitingTraeQueue(input: {
  home: string;
  sessionId: string;
  leaseId?: string;
  messageId: string;
  deliveryId: string;
  content: string;
}): Promise<boolean> {
  const sessionId = sanitizeSessionId(input.sessionId);
  const target = join(input.home, "hook-sessions", sessionId, "state.json");
  const claimed = `${target}.${process.pid}.${randomUUID()}.claimed`;
  try {
    await rename(target, claimed);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }

  let state: TraeQueueState;
  try {
    state = JSON.parse(await readFile(claimed, "utf8")) as TraeQueueState;
  } catch (error) {
    await restoreClaim(target, claimed);
    throw error;
  }
  if (input.leaseId && state.leaseId !== input.leaseId) {
    await restoreClaim(target, claimed);
    return false;
  }

  const active = (state.status === "waiting"
    && typeof state.waitId === "string"
    && isProcessAlive(state.waiterPid))
    || (state.status === "processing" && state.acceptingInput === true);
  if (!active || state.pendingInput != null) {
    await restoreClaim(target, claimed);
    return false;
  }

  const temporary = `${claimed}.${randomUUID()}.next`;
  try {
    await writeFile(temporary, `${JSON.stringify({
      ...state,
      pendingInput: { messageId: input.messageId, deliveryId: input.deliveryId, text: input.content, timestamp: Date.now() },
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    await link(temporary, target);
  } catch (error) {
    await restoreClaim(target, claimed);
    if (!isErrno(error, "EEXIST")) throw error;
    return false;
  } finally {
    await rm(temporary, { force: true });
  }
  await rm(claimed, { force: true });
  return true;
}

async function restoreClaim(target: string, claimed: string): Promise<void> {
  try {
    await link(claimed, target);
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  } finally {
    await rm(claimed, { force: true });
  }
}

function sanitizeSessionId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "default";
}

function isProcessAlive(value: unknown): boolean {
  if (!Number.isInteger(value) || Number(value) <= 0) return false;
  try {
    process.kill(Number(value), 0);
    return true;
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}
