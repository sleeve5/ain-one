import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
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
  it("reports truthful per-Agent materialization status without repairing conflicts", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "status-skill");
    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const installed = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });

    expect(hub.listInstalled()[0]?.materializations).toEqual([
      { agentProductId: "codex", status: "not_materialized", repairable: true },
    ]);

    await hub.repairMaterialization("codex", {
      pluginId: installed.pluginId,
      versionId: installed.versionId,
    });
    expect(hub.listInstalled()[0]?.materializations).toEqual([
      { agentProductId: "codex", status: "materialized", repairable: false },
    ]);

    writeFileSync(join(codexSkillRoot, installed.pluginId, "SKILL.md"), "# changed\n", "utf8");
    expect(hub.listInstalled()[0]?.materializations).toEqual([
      { agentProductId: "codex", status: "conflicted", repairable: false },
    ]);
  });

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
      agentProductId: "codex",
      global: [
        { pluginId: a.pluginId, versionId: a.versionId },
        { pluginId: b.pluginId, versionId: b.versionId },
      ],
    });
    expect(resolved).toHaveLength(2);

    await hub.materialize("codex", resolved);
    expect(readlinkSync(join(codexSkillRoot, a.pluginId))).toBe(
      join(dataDir, "materialized", "codex", a.pluginId, a.versionId),
    );
    expect(readlinkSync(join(codexSkillRoot, b.pluginId))).toBe(
      join(dataDir, "materialized", "codex", b.pluginId, b.versionId),
    );
  });

  it("removes obsolete managed Skill links and preserves tampered targets", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "disable-skill");
    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const installed = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });
    const target = join(codexSkillRoot, installed.pluginId);

    await hub.materialize("codex", [installed]);
    expect(existsSync(target)).toBe(true);
    await hub.materialize("codex", []);
    expect(existsSync(target)).toBe(false);

    await hub.materialize("codex", [installed]);
    writeFileSync(join(target, "SKILL.md"), "# user changed this\n", "utf8");
    await expect(hub.materialize("codex", [])).rejects.toThrow("local changes");
    expect(existsSync(target)).toBe(true);
  });

  it("switches the complete desired Skill set for one Agent", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillA = createSkillFixture(localRoot, "skill-a");
    const skillB = createSkillFixture(localRoot, "skill-b");
    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const a = await hub.installLocal({ path: skillA, compatibility: { codex: { kind: "skill" } } });
    const b = await hub.installLocal({ path: skillB, compatibility: { codex: { kind: "skill" } } });

    await hub.materialize("codex", [a]);
    await hub.materialize("codex", [b]);

    expect(existsSync(join(codexSkillRoot, a.pluginId))).toBe(false);
    expect(existsSync(join(codexSkillRoot, b.pluginId))).toBe(true);
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

  it("rejects reinstalling identical content with different compatibility", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const skillDir = createSkillFixture(root, "metadata-bound-skill");
    const hub = createPluginHub({ dataDir, skillRoots: {} });

    await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });

    await expect(
      hub.installLocal({
        path: skillDir,
        compatibility: { claude: { kind: "skill" } },
      }),
    ).rejects.toThrow("metadata conflict");
    expect(hub.listInstalled()[0]?.compatibleAgents).toEqual(["codex"]);
  });

  it("rejects reinstalling identical content when stored type conflicts", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const skillDir = createSkillFixture(root, "type-bound-skill");
    const hub = createPluginHub({ dataDir, skillRoots: {} });
    const installed = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });
    const metadataPath = join(dataDir, "plugins.metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      versions: Record<string, Record<string, { type: string }>>;
    };
    metadata.versions[installed.pluginId]![installed.versionId]!.type = "mcp";
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    const reopened = createPluginHub({ dataDir, skillRoots: {} });
    await expect(
      reopened.installLocal({
        path: skillDir,
        compatibility: { codex: { kind: "skill" } },
      }),
    ).rejects.toThrow("metadata conflict");
  });

  it("rejects a symlink introduced after source hashing without storing a version", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const skillDir = createSkillFixture(root, "racy-skill");
    const markerPath = join(skillDir, "zz-marker.txt");
    const replacementPath = join(root, "replacement.txt");
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(join(skillDir, `${String(index).padStart(2, "0")}.bin`), Buffer.alloc(1024 * 1024, index));
    }
    writeFileSync(markerPath, "original\n", "utf8");
    writeFileSync(replacementPath, "replacement\n", "utf8");

    const tempParent = join(dataDir, "plugins", "racy-skill");
    const mutator = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs"); const parent = ${JSON.stringify(tempParent)}; const marker = ${JSON.stringify(markerPath)}; const replacement = ${JSON.stringify(replacementPath)}; const end = Date.now() + 5000; while (Date.now() < end) { try { if (fs.readdirSync(parent).some((name) => name.includes(".tmp-"))) { fs.rmSync(marker, { force: true }); fs.symlinkSync(replacement, marker); process.exit(0); } } catch {} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); } process.exit(2);`,
      ],
      { stdio: "ignore" },
    );
    const hub = createPluginHub({ dataDir, skillRoots: {} });
    let installError: unknown;
    try {
      await hub.installLocal({
        path: skillDir,
        compatibility: { codex: { kind: "skill" } },
      });
    } catch (error) {
      installError = error;
    }
    const exitCode = await new Promise<number | null>((resolvePromise) => {
      mutator.once("close", resolvePromise);
    });

    expect(exitCode).toBe(0);
    expect(installError).toBeInstanceOf(Error);
    expect((installError as Error).message).toMatch(/symlink|changed during copy/);
    expect(hub.listInstalled()).toEqual([]);
    expect(existsSync(tempParent) ? readdirSync(tempParent) : []).toEqual([]);
  });

  it("rejects materialization when canonical content was tampered", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(codexSkillRoot, { recursive: true });
    const skillDir = createSkillFixture(root, "tampered-canonical-skill");
    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const installed = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });
    writeFileSync(join(installed.canonicalPath, "SKILL.md"), "# tampered\n", "utf8");

    await expect(hub.materialize("codex", [installed])).rejects.toThrow(
      "canonical content hash mismatch",
    );
    expect(existsSync(join(codexSkillRoot, installed.pluginId))).toBe(false);
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

    const first = await hub.scanNative([
      {
        agentProductId: "claude",
        path: claudeSkill,
        compatibility: {
          claude: { kind: "skill" },
          codex: { kind: "skill" },
        },
      },
    ]);
    expect(first).toEqual([
      expect.objectContaining({
        type: "skill",
        compatibleAgents: ["claude", "codex"],
      }),
    ]);

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

  it("scans configured Skill-root direct children only", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(codexSkillRoot, { recursive: true });
    createSkillFixture(codexSkillRoot, "native-skill");
    mkdirSync(join(codexSkillRoot, "not-a-skill"));
    writeFileSync(join(codexSkillRoot, "README.md"), "ignore me\n", "utf8");

    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });

    await expect(hub.scanConfiguredRoots()).resolves.toEqual([
      expect.objectContaining({ pluginId: "native-skill", agentProductId: "codex" }),
    ]);
  });

  it("does not infer cross-agent compatibility from configured skill roots", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const nativeRoot = join(root, "native");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(codexSkillRoot, { recursive: true });
    const claudeSkill = createSkillFixture(nativeRoot, "claude-only-skill");

    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const [candidate] = await hub.scanNative([
      { agentProductId: "claude", path: claudeSkill },
    ]);
    const installed = await hub.acceptCandidate(candidate!.id);

    await expect(
      hub.materialize("codex", [
        { pluginId: installed.pluginId, versionId: installed.versionId },
      ]),
    ).rejects.toThrow("not compatible");
  });

  it("keeps canonical immutable when an agent edits the managed materialized copy", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "agent-edited-skill");
    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const installed = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });
    const canonicalSkill = join(installed.canonicalPath, "SKILL.md");
    const canonicalBefore = readFileSync(canonicalSkill, "utf8");

    await hub.materialize("codex", [
      { pluginId: installed.pluginId, versionId: installed.versionId },
    ]);

    const nativeTarget = join(codexSkillRoot, installed.pluginId);
    const expectedMaterializedPath = join(
      dataDir,
      "materialized",
      "codex",
      installed.pluginId,
      installed.versionId,
    );
    expect(realpathSync(nativeTarget)).toBe(realpathSync(expectedMaterializedPath));

    writeFileSync(join(nativeTarget, "SKILL.md"), "# agent-edited-skill\n\nchanged by agent\n", "utf8");

    expect(readFileSync(canonicalSkill, "utf8")).toBe(canonicalBefore);
    const candidates = await hub.scanNative([{ agentProductId: "codex", path: nativeTarget }]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.pluginId).toBe(installed.pluginId);
    expect(candidates[0]?.versionId).not.toBe(installed.versionId);
  });

  it("refuses to overwrite an edited managed materialized copy", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "edited-before-rematerialize");
    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const installed = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });
    await hub.materialize("codex", [
      { pluginId: installed.pluginId, versionId: installed.versionId },
    ]);

    const nativeTarget = join(codexSkillRoot, installed.pluginId);
    writeFileSync(join(nativeTarget, "SKILL.md"), "# edited\n\nkeep this change\n", "utf8");

    await expect(
      hub.materialize("codex", [
        { pluginId: installed.pluginId, versionId: installed.versionId },
      ]),
    ).rejects.toThrow("local changes");
    expect(readFileSync(join(nativeTarget, "SKILL.md"), "utf8")).toContain("keep this change");
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

  it("does not mutate filesystem or metadata when prevalidation fails", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "atomic-new-skill");
    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const installed = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });
    const metadataPath = join(dataDir, "plugins.metadata.json");
    const metadataBefore = readFileSync(metadataPath, "utf8");

    await expect(
      hub.materialize(
        "codex",
        [
          { pluginId: installed.pluginId, versionId: installed.versionId },
          { pluginId: "missing-plugin", versionId: "missing-version" },
        ],
        { turnId: "atomic-new-failure" },
      ),
    ).rejects.toThrow("plugin version not found");

    expect(existsSync(join(codexSkillRoot, installed.pluginId))).toBe(false);
    expect(
      existsSync(
        join(dataDir, "materialized", "codex", installed.pluginId, installed.versionId),
      ),
    ).toBe(false);
    expect(existsSync(join(dataDir, "turn-artifacts", "codex", "atomic-new-failure.json"))).toBe(
      false,
    );
    expect(readFileSync(metadataPath, "utf8")).toBe(metadataBefore);
  });

  it("rolls back an interrupted materialization journal during hub startup", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const skillRoot = join(root, "codex-skills");
    const skillDir = createSkillFixture(root, "journal-skill");
    mkdirSync(skillRoot, { recursive: true });
    const hub = createPluginHub({ dataDir, skillRoots: { codex: skillRoot } });
    const first = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });
    await hub.materialize("codex", [first]);
    writeFileSync(join(skillDir, "README.md"), "second version\n", "utf8");
    const second = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });

    const targetPath = join(skillRoot, first.pluginId);
    const firstMaterialized = join(
      dataDir,
      "materialized",
      "codex",
      first.pluginId,
      first.versionId,
    );
    const secondMaterialized = join(
      dataDir,
      "materialized",
      "codex",
      second.pluginId,
      second.versionId,
    );
    const targetBackup = `${targetPath}.backup-interrupted`;
    mkdirSync(join(secondMaterialized, ".."), { recursive: true });
    cpSync(second.canonicalPath, secondMaterialized, { recursive: true });
    renameSync(targetPath, targetBackup);
    symlinkSync(secondMaterialized, targetPath, "dir");
    writeFileSync(
      join(dataDir, "materialization.journal.json"),
      `${JSON.stringify({
        format: "ain-one.materialization-journal.v1",
        phase: "applying",
        entries: [
          {
            path: secondMaterialized,
            stagedPath: `${secondMaterialized}.stage-interrupted`,
            backupPath: null,
            originalIdentity: null,
            replacementIdentity: { kind: "directory", hash: second.versionId },
          },
          {
            path: targetPath,
            stagedPath: `${targetPath}.stage-interrupted`,
            backupPath: targetBackup,
            originalIdentity: { kind: "symlink", target: firstMaterialized },
            replacementIdentity: { kind: "symlink", target: secondMaterialized },
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const recovered = createPluginHub({ dataDir, skillRoots: { codex: skillRoot } });
    await expect(recovered.materialize("codex", [first])).resolves.toMatchObject({
      applied: [first],
    });
    expect(readlinkSync(targetPath)).toBe(firstMaterialized);
    expect(existsSync(secondMaterialized)).toBe(false);
    expect(existsSync(targetBackup)).toBe(false);
    expect(existsSync(join(dataDir, "materialization.journal.json"))).toBe(false);
  });

  it("rejects a journal that targets paths outside PluginHub-managed roots", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const victimTarget = join(root, "victim-target");
    const victimPath = join(root, "do-not-delete");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(victimTarget);
    symlinkSync(victimTarget, victimPath, "dir");
    writeFileSync(
      join(dataDir, "materialization.journal.json"),
      `${JSON.stringify({
        format: "ain-one.materialization-journal.v1",
        phase: "applying",
        entries: [
          {
            path: victimPath,
            stagedPath: null,
            backupPath: null,
            originalIdentity: null,
            replacementIdentity: { kind: "symlink", target: victimTarget },
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    await expect(hub.scanNative([])).rejects.toThrow("invalid materialization journal path");
    expect(readlinkSync(victimPath)).toBe(victimTarget);
  });

  it("preserves the previous managed target when a later plugin fails validation", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillDir = createSkillFixture(localRoot, "atomic-update-skill");
    const hub = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const first = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });
    await hub.materialize("codex", [{ pluginId: first.pluginId, versionId: first.versionId }]);

    const nativeTarget = join(codexSkillRoot, first.pluginId);
    const previousTarget = realpathSync(nativeTarget);
    const previousBytes = readFileSync(join(nativeTarget, "SKILL.md"), "utf8");

    writeFileSync(join(skillDir, "SKILL.md"), "# atomic-update-skill\n\nversion two\n", "utf8");
    const second = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });

    await expect(
      hub.materialize("codex", [
        { pluginId: second.pluginId, versionId: second.versionId },
        { pluginId: "missing-plugin", versionId: "missing-version" },
      ]),
    ).rejects.toThrow("plugin version not found");

    expect(realpathSync(nativeTarget)).toBe(previousTarget);
    expect(readFileSync(join(nativeTarget, "SKILL.md"), "utf8")).toBe(previousBytes);
  });

  it("serializes complete desired-state mutations across hubs sharing one dataDir", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    const codexSkillRoot = join(root, "codex-skills");
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(codexSkillRoot, { recursive: true });

    const skillA = createSkillFixture(localRoot, "multi-hub-a");
    const skillB = createSkillFixture(localRoot, "multi-hub-b");
    const hubA = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    const hubB = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });

    const installedA = await hubA.installLocal({
      path: skillA,
      compatibility: { codex: { kind: "skill" } },
    });
    const installedB = await hubB.installLocal({
      path: skillB,
      compatibility: { codex: { kind: "skill" } },
    });
    await hubA.materialize("codex", [
      { pluginId: installedA.pluginId, versionId: installedA.versionId },
    ]);
    await hubB.materialize("codex", [
      { pluginId: installedB.pluginId, versionId: installedB.versionId },
    ]);

    const reader = createPluginHub({ dataDir, skillRoots: { codex: codexSkillRoot } });
    expect(reader.listInstalled()).toHaveLength(2);

    const metadata = JSON.parse(readFileSync(join(dataDir, "plugins.metadata.json"), "utf8")) as {
      managedTargets: { codex: Record<string, unknown> };
    };
    expect(Object.keys(metadata.managedTargets.codex)).toEqual([
      join(codexSkillRoot, installedB.pluginId),
    ]);
  });

  it("waits for another process holding the metadata lock", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(localRoot, { recursive: true });
    const skill = createSkillFixture(localRoot, "external-lock-skill");
    const lockPath = join(dataDir, "plugins.metadata.json.lock");
    const lockHolder = spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs"); const path = ${JSON.stringify(lockPath)}; fs.writeFileSync(path, process.pid + ":child", { flag: "wx" }); process.stdout.write("ready\\n"); setTimeout(() => { fs.rmSync(path, { force: true }); }, 100);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolvePromise, rejectPromise) => {
      lockHolder.once("error", rejectPromise);
      lockHolder.stdout.once("data", () => resolvePromise());
    });

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    const install = hub.installLocal({
      path: skill,
      compatibility: { codex: { kind: "skill" } },
    });
    const state = await Promise.race([
      install.then(() => "settled" as const),
      new Promise<"waiting">((resolvePromise) => {
        setTimeout(() => resolvePromise("waiting"), 30);
      }),
    ]);

    expect(state).toBe("waiting");
    await expect(install).resolves.toMatchObject({ pluginId: "external-lock-skill" });
    if (lockHolder.exitCode === null) {
      await new Promise<void>((resolvePromise) => {
        lockHolder.once("close", () => resolvePromise());
      });
    }
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

  it("rejects plugin ids that escape their managed directory", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const mcpPath = join(root, "path-escape-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        format: "ain-one.mcp.v1",
        pluginId: "..",
        compatibility: {},
      }),
      "utf8",
    );

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    await expect(hub.installLocal({ path: mcpPath })).rejects.toThrow("invalid plugin id");
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
      agentProductId: "codex",
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

  it("filters final scoped versions by the target Agent without broader fallback", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const localRoot = join(root, "local");
    mkdirSync(localRoot, { recursive: true });
    const skillDir = createSkillFixture(localRoot, "agent-scoped-skill");
    const hub = createPluginHub({ dataDir, skillRoots: {} });

    const codex = await hub.installLocal({
      path: skillDir,
      compatibility: { codex: { kind: "skill" } },
    });
    writeFileSync(join(skillDir, "README.md"), "claude version\n", "utf8");
    const claude = await hub.installLocal({
      path: skillDir,
      compatibility: { claude: { kind: "skill" } },
    });

    expect(hub.resolveForTurn({
      agentProductId: "codex",
      global: [codex],
      conversation: [claude],
    })).toEqual([]);
    expect(hub.resolveForTurn({
      agentProductId: "claude",
      global: [codex],
      conversation: [claude],
    })).toEqual([{ pluginId: claude.pluginId, versionId: claude.versionId }]);
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

  it("rejects MCP compatibility targeting another Agent product", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const mcpPath = join(root, "cross-agent-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        format: "ain-one.mcp.v1",
        pluginId: "cross-agent-mcp",
        compatibility: {
          codex: {
            kind: "mcp",
            target: "claude.mcp.v1",
            server: { command: "node", args: ["server.js"] },
          },
        },
      }),
      "utf8",
    );

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    await expect(hub.installLocal({ path: mcpPath })).rejects.toThrow(
      "target must be codex.mcp.v1",
    );
  });

  it("requires the claimed Turn ID before materializing MCP configuration", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const mcpPath = join(root, "demo-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        format: "ain-one.mcp.v1",
        pluginId: "demo-mcp",
        compatibility: {
          codex: {
            kind: "mcp",
            target: "codex.mcp.v1",
            server: { command: "node", args: ["server.js"] },
          },
        },
      }),
      "utf8",
    );
    const hub = createPluginHub({ dataDir, skillRoots: {} });
    const installed = await hub.installLocal({ path: mcpPath });

    await expect(
      hub.materialize("codex", [
        { pluginId: installed.pluginId, versionId: installed.versionId },
      ]),
    ).rejects.toThrow("Turn ID is required");
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

  it("rejects MCP compatibility for a Skill directory before storing metadata", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const skillDir = createSkillFixture(root, "mcp-disguised-skill");
    const hub = createPluginHub({ dataDir, skillRoots: {} });

    await expect(
      hub.installLocal({
        path: skillDir,
        compatibility: {
          codex: {
            kind: "mcp",
            target: "codex.mcp.v1",
            server: { apiKey: "RAW_SECRET" },
          },
        },
      }),
    ).rejects.toThrow("Skill compatibility must use kind skill");

    expect(hub.listInstalled()).toEqual([]);
    const metadataPath = join(dataDir, "plugins.metadata.json");
    if (existsSync(metadataPath)) {
      expect(readFileSync(metadataPath, "utf8")).not.toContain("RAW_SECRET");
    }
  });

  it("rejects raw Authorization strings after sensitive-key normalization", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const mcpPath = join(root, "authorization-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        format: "ain-one.mcp.v1",
        pluginId: "authorization-mcp",
        compatibility: {
          codex: {
            kind: "mcp",
            target: "codex.mcp.v1",
            server: { headers: { Authorization: "Bearer RAW-AUTH" } },
          },
        },
      }),
      "utf8",
    );

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    await expect(hub.installLocal({ path: mcpPath })).rejects.toThrow("raw secret");
  });

  it("rejects raw vendor-prefixed API keys", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const mcpPath = join(root, "prefixed-secret-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        format: "ain-one.mcp.v1",
        pluginId: "prefixed-secret-mcp",
        compatibility: {
          codex: {
            kind: "mcp",
            target: "codex.mcp.v1",
            server: { command: "node", env: { OPENAI_API_KEY: "RAW-SECRET" } },
          },
        },
      }),
      "utf8",
    );

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    await expect(hub.installLocal({ path: mcpPath })).rejects.toThrow("raw secret");
  });

  it("recurses through non-exact secretRef objects and rejects nested fallback secrets", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const mcpPath = join(root, "nested-secret-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        format: "ain-one.mcp.v1",
        pluginId: "nested-secret-mcp",
        compatibility: {
          codex: {
            kind: "mcp",
            target: "codex.mcp.v1",
            server: {
              Authorization: {
                secretRef: "opaque-ref",
                fallback: { proxyAuthorization: "Bearer RAW-FALLBACK" },
              },
            },
          },
        },
      }),
      "utf8",
    );

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    await expect(hub.installLocal({ path: mcpPath })).rejects.toThrow("raw secret");
  });

  it("rejects non-secretRef objects under sensitive keys", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const mcpPath = join(root, "wrapped-secret-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        format: "ain-one.mcp.v1",
        pluginId: "wrapped-secret-mcp",
        compatibility: {
          codex: {
            kind: "mcp",
            target: "codex.mcp.v1",
            server: { apiKey: { value: "RAW-SECRET" } },
          },
        },
      }),
      "utf8",
    );

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    await expect(hub.installLocal({ path: mcpPath })).rejects.toThrow("secretRef");
  });

  it("rejects empty secretRef values", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const mcpPath = join(root, "empty-secret-ref-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        format: "ain-one.mcp.v1",
        pluginId: "empty-secret-ref-mcp",
        compatibility: {
          codex: {
            kind: "mcp",
            target: "codex.mcp.v1",
            server: { clientSecret: { secretRef: "" } },
          },
        },
      }),
      "utf8",
    );

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    await expect(hub.installLocal({ path: mcpPath })).rejects.toThrow("invalid secretRef");
  });

  it("rejects empty secretRef values under non-sensitive container keys", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const mcpPath = join(root, "nested-empty-secret-ref-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        format: "ain-one.mcp.v1",
        pluginId: "nested-empty-secret-ref-mcp",
        compatibility: {
          codex: {
            kind: "mcp",
            target: "codex.mcp.v1",
            server: { credentials: { primary: { secretRef: "" } } },
          },
        },
      }),
      "utf8",
    );

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    await expect(hub.installLocal({ path: mcpPath })).rejects.toThrow("invalid secretRef");
  });

  it("stores secretRef metadata but keeps the version unavailable until secrets can resolve", async () => {
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
    expect(hub.listInstalled()).toEqual([
      expect.objectContaining({
        pluginId: installed.pluginId,
        compatibleAgents: [],
      }),
    ]);
    await expect(
      hub.materialize(
        "codex",
        [{ pluginId: installed.pluginId, versionId: installed.versionId }],
        { turnId: "no-raw-secret-turn" },
      ),
    ).rejects.toThrow("secret configuration is not available");

    expect(
      hub.resolveForTurn({
        agentProductId: "codex",
        global: [{ pluginId: installed.pluginId, versionId: installed.versionId }],
      }),
    ).toEqual([]);

    const metadataText = readFileSync(join(dataDir, "plugins.metadata.json"), "utf8");
    expect(metadataText.includes("opaque-ref-1")).toBe(true);
    expect(metadataText.includes("RAW-SECRET")).toBe(false);
  });

  it("writes ordinary per-Turn MCP artifacts with owner-only permissions", async () => {
    const root = makeTempDir("ain-one-task5-plugin-");
    const dataDir = join(root, "data");
    const mcpPath = join(root, "plain-mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        format: "ain-one.mcp.v1",
        pluginId: "plain-mcp",
        compatibility: {
          codex: {
            kind: "mcp",
            target: "codex.mcp.v1",
            server: { command: "node", args: ["server.js"] },
          },
        },
      }),
      "utf8",
    );

    const hub = createPluginHub({ dataDir, skillRoots: {} });
    const installed = await hub.installLocal({ path: mcpPath });
    const materialized = await hub.materialize(
      "codex",
      [{ pluginId: installed.pluginId, versionId: installed.versionId }],
      { turnId: "owner-only-turn" },
    );

    expect(statSync(materialized.turnArtifactPath!).mode & 0o777).toBe(0o600);
  });
});
