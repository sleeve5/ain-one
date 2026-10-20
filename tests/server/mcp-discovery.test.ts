import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { discoverNativeMcpDefinitions, parseNativeMcpConfig, parseNativeMcpList } from "../../src/server/mcp-discovery.js";

describe("native MCP discovery", () => {
  it("converts safe stdio and URL servers without copying environment values", () => {
    expect(parseNativeMcpList("codex", JSON.stringify([
      { name: "docs", transport: { type: "stdio", command: "node", args: ["server.js"], cwd: "/tmp/docs", env: null, env_vars: ["DOCS_TOKEN"] } },
      { name: "remote", transport: { type: "streamable_http", url: "https://mcp.example.test/api", headers: null } },
    ]))).toEqual([
      { agentProductId: "codex", pluginId: "docs", server: { command: "node", args: ["server.js"], cwd: "/tmp/docs", env_vars: ["DOCS_TOKEN"] } },
      { agentProductId: "codex", pluginId: "remote", server: { url: "https://mcp.example.test/api" } },
    ]);
  });

  it("skips configurations that contain inline secrets or credential-bearing URLs", () => {
    expect(parseNativeMcpList("codex", JSON.stringify([
      { name: "inline-env", transport: { type: "stdio", command: "node", env: { TOKEN: "secret" } } },
      { name: "secret-arg", transport: { type: "stdio", command: "node", args: ["--api-key", "secret"] } },
      { name: "secret-url", transport: { type: "streamable_http", url: "https://mcp.example.test/api?token=secret" } },
      { name: "headers", transport: { type: "streamable_http", url: "https://mcp.example.test/api", headers: { Authorization: "secret" } } },
    ]))).toEqual([]);
  });

  it("reads safe Claude global and project MCP entries and deduplicates them", () => {
    expect(parseNativeMcpConfig("claude", JSON.stringify({
      mcpServers: { docs: { command: "node", args: ["docs.js"] } },
      projects: {
        "/work/one": { mcpServers: { docs: { command: "node", args: ["docs.js"] } } },
        "/work/two": { mcpServers: { unsafe: { command: "node", env: { API_TOKEN: "secret" } } } },
      },
    }))).toEqual([
      { agentProductId: "claude", pluginId: "docs", server: { command: "node", args: ["docs.js"] } },
    ]);
  });

  it("does not let unresponsive Agent MCP commands block discovery", async () => {
    const executable = join(tmpdir(), `ain-one-hanging-mcp-${randomUUID()}`);
    const dataDir = join(tmpdir(), `ain-one-mcp-data-${randomUUID()}`);
    await writeFile(executable, "#!/bin/sh\nsleep 10\n");
    await chmod(executable, 0o700);

    await expect(discoverNativeMcpDefinitions({
      dataDir,
      executables: { codex: executable, trae: executable },
      timeoutMs: 20,
    })).resolves.toEqual([]);
  });
});
