#!/usr/bin/env node

import { appendFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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

if ((product === "codex" || product === "trae") && args[0] === "login" && args[1] === "status") {
  if (process.env.AIN_FIXTURE_AUTH === "required") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stdout.write(`Logged in using ${product === "codex" ? "ChatGPT" : "Trae"}\n`);
  process.exit(0);
}

if (product === "trae" && args[0] === "models" && args[1] === "--json") {
  process.stdout.write(
    `${JSON.stringify([{ id: "trae-sonnet" }, { name: "trae-opus" }, null])}\n`,
  );
  process.exit(0);
}

if (product === "opencode" && args[0] === "serve") {
  await runOpenCodeServer(args);
  process.exit(0);
}

if (isExecCommand(product, args)) {
  await runExec(product, args);
  process.exit(0);
}

process.exit(0);

async function runExec(productId, argv) {
  const scenario = process.env.AIN_FIXTURE_SCENARIO ?? "normal";
  const sessionId = scenario === "session-id-drift"
    ? `drifted-native-session-${productId}`
    : sessionIdFor(productId, argv);

  if (scenario === "nonzero-before-identity") {
    process.stderr.write("native process failed before identity\n");
    process.exit(23);
  }

  if (scenario === "codex-modern-jsonl") {
    writeLine({ type: "thread.started", thread_id: sessionId });
    writeLine({ type: "turn.started" });
    writeLine({
      type: "item.completed",
      item: { id: "reasoning-1", type: "reasoning", text: "confirmed working directory" },
    });
    writeLine({
      type: "item.completed",
      item: { id: "warning-1", type: "error", message: "skills context shortened" },
    });
    writeLine({
      type: "item.completed",
      item: {
        id: "shell-1",
        type: "command_execution",
        command: "/bin/zsh -c pwd",
        aggregated_output: "/tmp/project\n",
        exit_code: 0,
        status: "completed",
      },
    });
    writeLine({
      type: "item.completed",
      item: { id: "file-1", type: "file_change", changes: [{ path: "README.md" }] },
    });
    writeLine({
      type: "item.completed",
      item: { id: "mcp-1", type: "mcp_tool_call", server: "docs", tool: "search" },
    });
    writeLine({
      type: "item.completed",
      item: { id: "web-1", type: "web_search", query: "Codex JSONL" },
    });
    writeLine({
      type: "item.completed",
      item: { id: "future-1", type: "future_item", token: "sk-secret-value" },
    });
    writeLine({
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: "/tmp/project" },
    });
    writeLine({
      type: "turn.completed",
      usage: { input_tokens: 12, output_tokens: 4 },
    });
    return;
  }

  if (scenario === "claude-modern-jsonl") {
    writeLine({ type: "system", subtype: "hook_started", session_id: sessionId });
    writeLine({ type: "system", subtype: "init", session_id: sessionId });
    writeLine({
      type: "stream_event",
      session_id: sessionId,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "duplicate" } },
    });
    writeLine({
      type: "assistant",
      session_id: sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking the working directory" },
          { type: "tool_use", id: "tool-claude", name: "Bash", input: { command: "pwd" } },
        ],
      },
    });
    writeLine({
      type: "user",
      session_id: sessionId,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-claude", content: "/tmp/project", is_error: false },
        ],
      },
    });
    writeLine({
      type: "assistant",
      session_id: sessionId,
      message: { role: "assistant", content: [{ type: "text", text: "/tmp/project" }] },
    });
    writeLine({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      is_error: false,
      result: "/tmp/project",
      usage: { input_tokens: 42, output_tokens: 7 },
    });
    return;
  }

  if (scenario === "claude-error-result") {
    writeLine({ type: "system", subtype: "init", session_id: sessionId });
    writeLine({
      type: "result",
      subtype: "error",
      session_id: sessionId,
      is_error: true,
      result: "model denied",
    });
    return;
  }

  if (scenario === "turn-before-session") {
    writeLine({ type: "turn.started", turn_id: `native-turn-${productId}` });
    await sleep(10);
    writeLine({ type: "session.started", session_id: sessionId });
  } else if (scenario === "missing-session-id") {
    writeLine({ type: "turn.started", turn_id: `native-turn-${productId}` });
  } else if (scenario === "missing-turn-id") {
    writeLine({ type: "session.started", session_id: sessionId });
  } else {
    writeLine({ type: "session.started", session_id: sessionId });
    writeLine({ type: "turn.started", turn_id: `native-turn-${productId}` });
  }

  if (scenario === "cancel") {
    const keepAlive = setInterval(() => undefined, 1_000);
    await new Promise((resolvePromise) => {
      const stop = () => {
        clearInterval(keepAlive);
        resolvePromise();
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
    });
    return;
  }

  if (scenario === "descendant") {
    const pidPath = process.env.AIN_FIXTURE_DESCENDANT_PID_PATH;
    if (!pidPath) {
      throw new Error("AIN_FIXTURE_DESCENDANT_PID_PATH is required for descendant");
    }
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    appendFileSync(pidPath, String(descendant.pid));
    await new Promise((resolvePromise) => {
      process.on("SIGTERM", resolvePromise);
      process.on("SIGINT", resolvePromise);
    });
    return;
  }

  if (scenario === "ignore-sigterm") {
    recordInvocation({ product: productId, commandType: "signal-ready" });
    await new Promise((resolvePromise) => {
      process.on("SIGTERM", () => {
        recordInvocation({ product: productId, commandType: "signal", signal: "SIGTERM" });
      });
      process.on("SIGINT", () => {
        recordInvocation({ product: productId, commandType: "signal", signal: "SIGINT" });
      });
      setTimeout(resolvePromise, 5_000);
    });
    return;
  }

  if (scenario === "wait-for-file") {
    const gatePath = process.env.AIN_FIXTURE_GATE_PATH;
    if (!gatePath) {
      throw new Error("AIN_FIXTURE_GATE_PATH is required for wait-for-file");
    }
    while (!existsSync(gatePath)) {
      await sleep(20);
    }
  }

  if (scenario === "malformed-json") {
    process.stdout.write('{"type":"message"\n');
  }

  writeLine({ type: "message", role: "assistant", content: `hello from ${productId}` });
  writeLine({ type: "reasoning", summary: `reasoning from ${productId}` });
  writeLine(
    scenario === "nested-secret-event"
      ? {
          type: "tool",
          tool_name: "search",
          status: "ok",
          nested: {
            bearer: "Bearer abc123",
            apiKey: "sk-live-secret",
            deeper: ["cookie=abc", { token: "token=def" }],
          },
        }
      : { type: "tool", tool_name: "search", status: "ok" },
  );
  writeLine({ type: "shell", command: "ls -la", exit_code: 0 });
  writeLine({ type: "file", path: "README.md", action: "write" });
  writeLine({ type: "usage", input_tokens: 10, output_tokens: 20 });
  writeLine({ type: "warning", message: "fixture warning" });

  if (scenario === "nonzero") {
    process.stderr.write("sk-live-secret Bearer abc123 token=abc cookie=xyz\n");
    process.exit(23);
  }

  writeLine({ type: "turn.completed" });
  if (scenario === "terminal-before-exit") {
    const keepAlive = setInterval(() => undefined, 1_000);
    await new Promise((resolvePromise) => {
      const stop = () => {
        clearInterval(keepAlive);
        resolvePromise();
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
    });
  }
}

async function runOpenCodeServer(argv) {
  const hostname = readFlag(argv, "--hostname=") ?? "127.0.0.1";
  const port = Number(readFlag(argv, "--port=") ?? "0");
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, hostname, resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  process.stdout.write(`opencode server listening on http://${hostname}:${address.port}\n`);
  if (process.env.AIN_FIXTURE_SCENARIO === "ignore-sigterm") {
    await new Promise((resolvePromise) => {
      process.on("SIGTERM", () => {
        recordInvocation({ product: "opencode", commandType: "signal", signal: "SIGTERM" });
      });
      setTimeout(resolvePromise, 5_000);
    });
    return;
  }
  await new Promise((resolvePromise) => {
    const stop = () => server.close(resolvePromise);
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
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
  if ((productId === "codex" || productId === "trae") && argv[0] === "login") {
    return "auth";
  }
  if (productId === "trae" && argv[0] === "models") {
    return "models";
  }
  if (productId === "opencode" && argv[0] === "serve") {
    return "serve";
  }
  return isExecCommand(productId, argv) ? "exec" : "other";
}

function readFlag(argv, prefix) {
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
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
