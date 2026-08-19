#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { basename } from "node:path";

const product = detectProduct();
const args = process.argv.slice(2);
const stdin = await readStdin();
recordInvocation({
  product,
  args,
  stdin,
  cwd: process.cwd(),
  commandType: detectCommandType(product, args),
});

if (args.includes("--version")) {
  process.stdout.write(`${versionFor(product)}\n`);
  process.exit(0);
}

if (product === "claude" && args[0] === "auth" && args[1] === "status" && args[2] === "--json") {
  process.stdout.write(`${JSON.stringify({ loggedIn: true })}\n`);
  process.exit(0);
}

if (product === "trae" && args[0] === "models" && args[1] === "--json") {
  process.stdout.write(
    `${JSON.stringify([{ id: "trae-sonnet" }, { name: "trae-opus" }, null])}\n`,
  );
  process.exit(0);
}

if (isExecCommand(product, args)) {
  await runExec(product, args);
  process.exit(0);
}

process.exit(0);

async function runExec(productId, argv) {
  const scenario = process.env.AIN_FIXTURE_SCENARIO ?? "normal";
  const sessionId = sessionIdFor(productId, argv);
  writeLine({ type: "session.started", session_id: sessionId });
  writeLine({ type: "turn.started", turn_id: `native-turn-${productId}` });

  if (scenario === "cancel") {
    await new Promise((resolvePromise) => {
      process.on("SIGTERM", () => {
        resolvePromise();
      });
      process.on("SIGINT", () => {
        resolvePromise();
      });
    });
    return;
  }

  if (scenario === "malformed-json") {
    process.stdout.write('{"type":"message"\n');
  }

  writeLine({ type: "message", role: "assistant", content: `hello from ${productId}` });
  writeLine({ type: "reasoning", summary: `reasoning from ${productId}` });
  writeLine({ type: "tool", tool_name: "search", status: "ok" });
  writeLine({ type: "shell", command: "ls -la", exit_code: 0 });
  writeLine({ type: "file", path: "README.md", action: "write" });
  writeLine({ type: "usage", input_tokens: 10, output_tokens: 20 });
  writeLine({ type: "warning", message: "fixture warning" });

  if (scenario === "nonzero") {
    process.stderr.write("sk-live-secret Bearer abc123 token=abc cookie=xyz\n");
    process.exit(23);
  }

  writeLine({ type: "turn.completed" });
}

function versionFor(productId) {
  switch (productId) {
    case "codex":
      return "codex-cli 0.147.0";
    case "claude":
      return "2.1.170";
    case "trae":
      return "traecli 0.201.1";
    default:
      return "opencode 0.1.0";
  }
}

function detectProduct() {
  const file = basename(process.argv[1] ?? "");
  if (file.includes("claude")) {
    return "claude";
  }
  if (file.includes("trae")) {
    return "trae";
  }
  if (file.includes("opencode")) {
    return "opencode";
  }
  return "codex";
}

function detectCommandType(productId, argv) {
  if (argv.includes("--version")) {
    return "version";
  }
  if (productId === "claude" && argv[0] === "auth") {
    return "auth";
  }
  if (productId === "trae" && argv[0] === "models") {
    return "models";
  }
  return isExecCommand(productId, argv) ? "exec" : "other";
}

function isExecCommand(productId, argv) {
  if (productId === "claude") {
    return argv.includes("--print");
  }
  return argv[0] === "exec";
}

function sessionIdFor(productId, argv) {
  if (productId === "claude") {
    const resumeIndex = argv.indexOf("--resume");
    if (resumeIndex >= 0) {
      return argv[resumeIndex + 1] ?? `native-session-${productId}`;
    }
    const sessionIndex = argv.indexOf("--session-id");
    if (sessionIndex >= 0) {
      return argv[sessionIndex + 1] ?? `native-session-${productId}`;
    }
    return `native-session-${productId}`;
  }

  const resumeIndex = argv.indexOf("resume");
  if (resumeIndex >= 0) {
    return argv[resumeIndex + 1] ?? `native-session-${productId}`;
  }
  return `native-session-${productId}`;
}

function writeLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function recordInvocation(record) {
  const target = process.env.AIN_FIXTURE_RECORD_PATH;
  if (!target) {
    return;
  }
  appendFileSync(target, `${JSON.stringify(record)}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
