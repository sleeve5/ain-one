#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const payload = raw ? JSON.parse(raw) : {};
const sessionId = String(payload.session_id || payload.thread_name || payload.session_name || "default")
  .trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "default";
const home = process.env.TRAE_QUEUE_HOME
  ? resolve(process.env.TRAE_QUEUE_HOME)
  : join(process.env.HOME || homedir(), ".trae", "queue-runtime");
const root = join(home, "hook-sessions", sessionId);
const stateFile = join(root, "state.json");
const leaseId = process.argv[2];

if (payload.hook_event_name === "SessionEnd") {
  const claimed = await claimState();
  if (!claimed) process.exit(0);
  const state = JSON.parse(await readFile(claimed, "utf8"));
  if (leaseId && state.leaseId !== leaseId) await rename(claimed, stateFile);
  else await rm(claimed, { force: true });
  process.exit(0);
}
if (payload.hook_event_name === "PostToolUse") {
  const claimed = await claimState();
  if (!claimed) process.exit(0);
  const state = JSON.parse(await readFile(claimed, "utf8"));
  if (leaseId && state.leaseId !== leaseId) { await rename(claimed, stateFile); process.exit(0); }
  const text = state.pendingInput?.text ? String(state.pendingInput.text) : "";
  const acknowledged = state.pendingInput?.messageId && state.pendingInput?.deliveryId
    ? { messageId: String(state.pendingInput.messageId), deliveryId: String(state.pendingInput.deliveryId) }
    : null;
  if (!text) {
    await rename(claimed, stateFile);
    process.exit(0);
  }
  delete state.pendingInput;
  await writeState({ ...state, status: "processing", acceptingInput: true, safePointId: randomUUID(), ...(acknowledged ? { lastAcknowledged: acknowledged } : {}), updatedAt: new Date().toISOString() });
  await rm(claimed, { force: true });
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
  })}\n`);
  process.exit(0);
}
if (payload.hook_event_name !== "Stop") process.exit(0);

await mkdir(root, { recursive: true, mode: 0o700 });
const existing = await claimState();
let waitingState = {};
if (existing) {
  const state = JSON.parse(await readFile(existing, "utf8"));
  if (leaseId && state.leaseId !== leaseId) { await rename(existing, stateFile); process.exit(0); }
  const text = state.pendingInput?.text ? String(state.pendingInput.text) : "";
  await rm(existing, { force: true });
  if (text) {
    await continueTurn(state, text);
    process.exit(0);
  }
  waitingState = state;
}
const waitId = randomUUID();
await writeState({
  ...waitingState, stateId: randomUUID(), leaseId: leaseId || waitingState.leaseId, sessionId, turnId: payload.turn_id || null,
  status: "waiting", acceptingInput: true, waitId, waiterPid: process.pid, updatedAt: new Date().toISOString(),
});

while (true) {
  await new Promise((done) => setTimeout(done, 100));
  let state;
  try { state = JSON.parse(await readFile(stateFile, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") {
      const files = await readdir(root).catch(() => []);
      if (files.some((name) => name.startsWith("state.json.") && (name.endsWith(".claimed") || name.endsWith(".hook")))) continue;
      process.exit(0);
    }
    throw error;
  }
  if (state.waitId !== waitId) process.exit(0);
  if (!state.pendingInput?.text) continue;
  const text = String(state.pendingInput.text);
  await continueTurn(state, text);
  process.exit(0);
}

async function continueTurn(state, text) {
  const acknowledged = state.pendingInput?.messageId && state.pendingInput?.deliveryId
    ? { messageId: String(state.pendingInput.messageId), deliveryId: String(state.pendingInput.deliveryId) }
    : null;
  delete state.waitId; delete state.waiterPid; delete state.pendingInput;
  await writeState({ ...state, status: "processing", acceptingInput: true, safePointId: randomUUID(), ...(acknowledged ? { lastAcknowledged: acknowledged } : {}), updatedAt: new Date().toISOString() });
  process.stdout.write(`${JSON.stringify({ decision: "block", reason: `Continue the existing Ain One turn with this exact user task:\n${text}\n\nAfter answering, finish normally so Ain One can wait again.` })}\n`);
}

async function claimState() {
  const claimed = `${stateFile}.${process.pid}.${randomUUID()}.hook`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { await rename(stateFile, claimed); return claimed; }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const files = await readdir(root).catch(() => []);
      if (!files.some((name) => name.includes(".claimed") || name.includes(".hook"))) return null;
      await new Promise((done) => setTimeout(done, 10));
    }
  }
  return null;
}

async function writeState(state) {
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, stateFile);
}
