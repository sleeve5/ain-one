import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginHub } from "../../src/server/plugins.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createSkillFixture(root: string, name: string): string {
  return createSkillFixtureWithContent(root, name, {
    skill: `# ${name}\n\nhello\n`,
    readme: `${name} readme\n`,
  });
}

function createSkillFixtureWithContent(
  root: string,
  name: string,
  content: { skill: string; readme: string },
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content.skill, "utf8");
  writeFileSync(join(dir, "README.md"), content.readme, "utf8");
  return dir;
}

describe("plugin hub", () => {
  it("supports same contentHash across different pluginIds without overwrite", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const sameContent = {
      skill: "# Shared\n\nidentical\n",
      readme: "identical\n",
    };
    const skillA = createSkillFixtureWithContent(localRoot, "alpha-skill", sameContent);
    const skillB = createSkillFixtureWithContent(localRoot, "beta-skill", sameContent);

    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const a = await hub.installLocal({ path: skillA, compatibility: { codex: { kind: "skill" } } });
    const b = await hub.installLocal({ path: skillB, compatibility: { codex: { kind: "skill" } } });

    expect(a.versionId).toBe(b.versionId);
    expect(a.pluginId).not.toBe(b.pluginId);

    const resolved = hub.resolveForTurn({
      global: [
        { pluginId: a.pluginId, versionId: a.versionId },
        { pluginId: b.pluginId, versionId: b.versionId },
      ],
    });
    expect(resolved).toHaveLength(2);

    await hub.materialize("codex", resolved);
    expect(readlinkSync(join(codexSkillRoot, a.pluginId)).endsWith(`/${a.pluginId}/${a.versionId}`)).toBe(true);
    expect(readlinkSync(join(codexSkillRoot, b.pluginId)).endsWith(`/${b.pluginId}/${b.versionId}`)).toBe(true);
  });

  it("stores immutable canonical copy with content hash", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    mkdirSync(localRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "immutable-skill");
    const hub = createPluginHub({ dataDir, skillRoots: {} });

    const first = await hub.installLocal({
      path: skillDir,
      compatibility: {
        codex: {
          kind: "skill",
        },
      },
    });
    const canonicalSkill = join(first.canonicalPath, "SKILL.md");
    const before = readFileSync(canonicalSkill, "utf8");

    writeFileSync(join(skillDir, "SKILL.md"), "# immutable-skill\n\nchanged\n", "utf8");

    const second = await hub.installLocal({
      path: skillDir,
      compatibility: {
        codex: {
          kind: "skill",
        },
      },
    });

    expect(second.contentHash).not.toBe(first.contentHash);
    expect(readFileSync(canonicalSkill, "utf8")).toBe(before);
    expect(existsSync(join(second.canonicalPath, "SKILL.md"))).toBe(true);
  });

  it("rejects symlink source path", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    mkdirSync(localRoot, { recursive: true });

    const realSkill = createSkillFixture(localRoot, "real-skill");
    const symlinkPath = join(localRoot, "link-skill");
    symlinkSync(realSkill, symlinkPath, "dir");

    const hub = createPluginHub({ dataDir, skillRoots: {} });

    await expect(
      hub.installLocal({
        path: symlinkPath,
        compatibility: {
          codex: {
            kind: "skill",
          },
        },
      }),
    ).rejects.toThrow("symlink");
  });

  it("imports one native Skill version and ignores its own materialized echo", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const nativeRoot = join(root, "native");
    const codexSkillRoot = join(nativeRoot, "codex-skills");
    mkdirSync(codexSkillRoot, { recursive: true });

    const claudeSkill = createSkillFixture(nativeRoot, "shared-skill");

    const hub = createPluginHub({
      dataDir,
      skillRoots: {
        codex: codexSkillRoot,
      },
    });

    const first = await hub.scanNative([{ agentProductId: "claude", path: claudeSkill }]);
    expect(first).toHaveLength(1);

    await hub.acceptCandidate(first[0]!.id);
    await hub.materialize("codex", [
      {
        pluginId: first[0]!.pluginId,
        versionId: first[0]!.versionId,
      },
    ]);

    const codexTarget = join(codexSkillRoot, first[0]!.pluginId);
    expect(readlinkSync(codexTarget).length).toBeGreaterThan(0);

    expect(await hub.scanNative([{ agentProductId: "codex", path: codexTarget }])).toEqual([]);
  });

  it("treats tampered managed symlink as non-echo candidate", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "managed-skill");
    const tamperedSource = createSkillFixture(localRoot, "tampered-source");

    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const installed = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });

    await hub.materialize("codex", [{ pluginId: installed.pluginId, versionId: installed.versionId }]);

    const target = join(codexSkillRoot, installed.pluginId);
    rmSync(target, { recursive: true, force: true });
    symlinkSync(tamperedSource, target, "dir");

    const candidates = await hub.scanNative([{ agentProductId: "codex", path: target }]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.pluginId).toBe(installed.pluginId);
    expect(candidates[0]?.versionId).not.toBe(installed.versionId);
  });

  it("fails materialize when managed target is replaced by a regular file", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "managed-file-skill");
    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const installed = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });

    await hub.materialize("codex", [{ pluginId: installed.pluginId, versionId: installed.versionId }]);
    const target = join(codexSkillRoot, installed.pluginId);
    rmSync(target, { recursive: true, force: true });
    writeFileSync(target, "hijacked", "utf8");

    await expect(
      hub.materialize("codex", [{ pluginId: installed.pluginId, versionId: installed.versionId }]),
    ).rejects.toThrow("unmanaged entry");
  });

  it("refuses unknown compatibility and unmanaged target conflicts", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "compat-skill");
    const hub = createPluginHub({
      dataDir,
      skillRoots: {
        codex: codexSkillRoot,
      },
    });

    const accepted = await hub.installLocal({
      path: skillDir,
      compatibility: {
        codex: {
          kind: "skill",
        },
      },
    });

    await expect(
      hub.materialize("trae", [
        {
          pluginId: accepted.pluginId,
          versionId: accepted.versionId,
        },
      ]),
    ).rejects.toThrow("not compatible");

    const conflictPath = join(codexSkillRoot, accepted.pluginId);
    writeFileSync(conflictPath, "user-owned", "utf8");

    await expect(
      hub.materialize("codex", [
        {
          pluginId: accepted.pluginId,
          versionId: accepted.versionId,
        },
      ]),
    ).rejects.toThrow("unmanaged entry");
  });

  it("treats explicit unknown compatibility as incompatible", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "unknown-compat-skill");
    const hub = createPluginHub({
      dataDir,
      skillRoots: { codex: codexSkillRoot },
    });

    const installed = await hub.installLocal({
      path: skillDir,
      compatibility: {
        codex: {
          kind: "unknown" as never,
        },
      },
    });

    await expect(
      hub.materialize("codex", [
        {
          pluginId: installed.pluginId,
          versionId: installed.versionId,
        },
      ]),
    ).rejects.toThrow("not compatible");
  });

  it("treats local skill install without compatibility as incompatible everywhere", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "no-compat-local-skill");
    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const installed = await hub.installLocal({ path: skillDir });

    await expect(
      hub.materialize("codex", [{ pluginId: installed.pluginId, versionId: installed.versionId }]),
    ).rejects.toThrow("not compatible");
    await expect(
      hub.materialize("claude", [{ pluginId: installed.pluginId, versionId: installed.versionId }]),
    ).rejects.toThrow("not compatible");
  });

  it("rejects stale native candidate when source hash changes before acceptance", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const nativeRoot = join(root, "native");
    mkdirSync(nativeRoot, { recursive: true });

    const nativeSkill = createSkillFixture(nativeRoot, "stale-candidate-skill");
    const hub = createPluginHub({ dataDir, skillRoots: {} });

    const candidates = await hub.scanNative([{ agentProductId: "claude", path: nativeSkill }]);
    expect(candidates).toHaveLength(1);

    writeFileSync(join(nativeSkill, "README.md"), "changed after scan\n", "utf8");

    await expect(hub.acceptCandidate(candidates[0]!.id)).rejects.toThrow("stale candidate");
  });

  it("applies global < project < conversation scope precedence", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    mkdirSync(localRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "scoped-skill");
    const hub = createPluginHub({ dataDir, skillRoots: {} });

    const v1 = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });

    writeFileSync(join(skillDir, "README.md"), "project version\n", "utf8");
    const v2 = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });

    writeFileSync(join(skillDir, "README.md"), "conversation version\n", "utf8");
    const v3 = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });

    const resolved = hub.resolveForTurn({
      global: [
        {
          pluginId: v1.pluginId,
          versionId: v1.versionId,
        },
      ],
      project: [
        {
          pluginId: v2.pluginId,
          versionId: v2.versionId,
        },
      ],
      conversation: [
        {
          pluginId: v3.pluginId,
          versionId: v3.versionId,
        },
      ],
    });

    expect(resolved).toEqual([
      {
        pluginId: v1.pluginId,
        versionId: v3.versionId,
      },
    ]);
  });

  it("installs explicit MCP JSON and emits per-turn artifact without touching global config", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    mkdirSync(localRoot, { recursive: true });

    const mcpPath = join(localRoot, "demo-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          format: "ain-one.mcp.v1",
          pluginId: "demo-mcp",
          name: "Demo MCP",
          compatibility: {
            codex: {
              kind: "mcp",
              target: "codex.mcp.v1",
              server: {
                command: "node",
                args: ["server.js"],
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const globalConfig = join(root, "global-mcp.json");
    writeFileSync(globalConfig, '{"unchanged":true}\n', "utf8");

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    const installed = await hub.installLocal({ path: mcpPath });

    const turn1 = await hub.materialize(
      "codex",
      [{ pluginId: installed.pluginId, versionId: installed.versionId }],
      { turnId: "turn-1" },
    );
    const turn2 = await hub.materialize(
      "codex",
      [{ pluginId: installed.pluginId, versionId: installed.versionId }],
      { turnId: "turn-2" },
    );

    expect(turn1.turnArtifactPath).not.toBeNull();
    expect(turn2.turnArtifactPath).not.toBeNull();
    expect(turn1.turnArtifactPath).not.toBe(turn2.turnArtifactPath);

    const artifact = JSON.parse(readFileSync(turn1.turnArtifactPath!, "utf8")) as {
      format: string;
      servers: Array<{ pluginId: string }>;
    };
    expect(artifact.format).toBe("ain-one.turn.mcp.v1");
    expect(artifact.servers[0]?.pluginId).toBe("demo-mcp");

    expect(readFileSync(globalConfig, "utf8")).toBe('{"unchanged":true}\n');
  });

  it("rejects raw secret-like string values in MCP server config", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    mkdirSync(localRoot, { recursive: true });

    const mcpPath = join(localRoot, "bad-secret-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          format: "ain-one.mcp.v1",
          pluginId: "bad-secret-mcp",
          compatibility: {
            codex: {
              kind: "mcp",
              target: "codex.mcp.v1",
              server: {
                command: "node",
                args: ["server.js"],
                apiKey: "RAW-SECRET",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    await expect(hub.installLocal({ path: mcpPath })).rejects.toThrow("raw secret");
  });

  it("allows secretRef objects and never persists raw secret strings", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    mkdirSync(localRoot, { recursive: true });

    const mcpPath = join(localRoot, "secret-ref-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          format: "ain-one.mcp.v1",
          pluginId: "secret-ref-mcp",
          compatibility: {
            codex: {
              kind: "mcp",
              target: "codex.mcp.v1",
              server: {
                command: "node",
                args: ["server.js"],
                apiKey: { secretRef: "opaque-ref-1" },
                headers: {
                  authorization: { secretRef: "opaque-ref-2" },
                },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    const installed = await hub.installLocal({ path: mcpPath });
    const materialized = await hub.materialize(
      "codex",
      [{ pluginId: installed.pluginId, versionId: installed.versionId }],
      { turnId: "no-raw-secret-turn" },
    );

    const metadataText = readFileSync(join(dataDir, "plugins.metadata.json"), "utf8");
    const artifactText = readFileSync(materialized.turnArtifactPath!, "utf8");
    expect(metadataText.includes("RAW-SECRET")).toBe(false);
    expect(artifactText.includes("RAW-SECRET")).toBe(false);
  });
});
