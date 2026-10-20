import { chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { discoverNativeSkillRoots, parseCodexPluginSkillRoots } from "../../src/server/skill-discovery.js";

describe("Codex Skill discovery", () => {
  it("returns exact installed roots for enabled plugins and excludes disabled plugins", () => {
    const raw = JSON.stringify({
      installed: [
        { name: "browser", marketplaceName: "openai-bundled", version: "1.2.3", installed: true, enabled: true },
        { name: "chrome", marketplaceName: "openai-bundled", version: "1.2.3", installed: true, enabled: false },
        { name: "not-installed", marketplaceName: "openai-bundled", version: "1.2.3", installed: false, enabled: true },
      ],
    });

    expect(parseCodexPluginSkillRoots(raw, "/tmp/codex")).toEqual([{
      agentProductId: "codex",
      path: join("/tmp/codex", "plugins", "cache", "openai-bundled", "browser", "1.2.3", "skills"),
    }]);
  });

  it("does not expose the external Trae Queue plugin after Queue becomes built in", () => {
    const raw = JSON.stringify({
      installed: [
        { name: "trae-queue", marketplaceName: "local", version: "0.3.5", installed: true, enabled: true },
        { name: "browser", marketplaceName: "openai-bundled", version: "1.2.3", installed: true, enabled: true },
      ],
    });

    expect(parseCodexPluginSkillRoots(raw, "/tmp/codex")).toEqual([{
      agentProductId: "codex",
      path: join("/tmp/codex", "plugins", "cache", "openai-bundled", "browser", "1.2.3", "skills"),
    }]);
  });

  it("ignores malformed output and unsafe path segments", () => {
    expect(parseCodexPluginSkillRoots("not json", "/tmp/codex")).toEqual([]);
    expect(parseCodexPluginSkillRoots(JSON.stringify({ installed: [
      { name: "../escape", marketplaceName: "market", version: "1", installed: true, enabled: true },
    ] }), "/tmp/codex")).toEqual([]);
  });

  it("does not let an unresponsive Codex plugin command block discovery", async () => {
    const executable = join(tmpdir(), `ain-one-hanging-codex-${randomUUID()}`);
    await writeFile(executable, "#!/bin/sh\nsleep 10\n");
    await chmod(executable, 0o700);

    await expect(discoverNativeSkillRoots({
      codexExecutable: executable,
      homeDir: tmpdir(),
      timeoutMs: 20,
    })).resolves.toEqual([{ agentProductId: "codex", path: join(tmpdir(), ".agents", "skills") }]);
  });
});
