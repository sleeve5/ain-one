import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentProductId, PluginVersion } from "../shared/contracts.js";

type PluginType = "skill" | "mcp";

type CompatibilitySpec =
  | {
      kind: "skill";
    }
  | {
      kind: "mcp";
      target: string;
      server: Record<string, unknown>;
    }
  | {
      kind: string;
      [key: string]: unknown;
    };

type CompatibilityMap = Partial<Record<AgentProductId, CompatibilitySpec>>;

export interface InstallLocalInput {
  path: string;
  compatibility?: CompatibilityMap;
}

export interface ScanNativeInput {
  agentProductId: AgentProductId;
  path: string;
  compatibility?: CompatibilityMap;
}

export interface PluginCandidate {
  id: string;
  pluginId: string;
  versionId: string;
  path: string;
  agentProductId: AgentProductId;
}

export interface InstalledPluginVersion extends PluginVersion {
  type: PluginType;
  contentHash: string;
  canonicalPath: string;
}

export interface ResolveForTurnInput {
  global?: PluginVersion[];
  project?: PluginVersion[];
  conversation?: PluginVersion[];
}

export interface MaterializeOptions {
  turnId?: string;
}

export interface MaterializeResult {
  applied: PluginVersion[];
  turnArtifactPath: string | null;
}

export interface PluginHub {
  installLocal(input: InstallLocalInput): Promise<InstalledPluginVersion>;
  scanNative(input: ScanNativeInput[]): Promise<PluginCandidate[]>;
  acceptCandidate(candidateId: string): Promise<InstalledPluginVersion>;
  resolveForTurn(input: ResolveForTurnInput): PluginVersion[];
  materialize(
    agentProductId: AgentProductId,
    plugins: PluginVersion[],
    options?: MaterializeOptions,
  ): Promise<MaterializeResult>;
}

export interface CreatePluginHubOptions {
  dataDir: string;
  skillRoots: Partial<Record<AgentProductId, string>>;
}

interface StoredVersion {
  pluginId: string;
  versionId: string;
  type: PluginType;
  contentHash: string;
  canonicalPath: string;
  compatibility: CompatibilityMap;
}

interface StoredCandidate {
  id: string;
  pluginId: string;
  versionId: string;
  type: PluginType;
  path: string;
  compatibility: CompatibilityMap;
  agentProductId: AgentProductId;
}

interface ManagedTarget {
  pluginId: string;
  versionId: string;
  targetPath: string;
  materializedPath: string;
}

interface PluginMetadata {
  versions: Record<string, Record<string, StoredVersion>>;
  candidates: Record<string, StoredCandidate>;
  managedTargets: Partial<Record<AgentProductId, Record<string, ManagedTarget>>>;
}

const EMPTY_METADATA: PluginMetadata = {
  versions: {},
  candidates: {},
  managedTargets: {},
};

const MCP_FORMAT = "ain-one.mcp.v1";
const METADATA_LOCK_POLL_MS = 10;
const METADATA_LOCK_TIMEOUT_MS = 10_000;
const STALE_METADATA_LOCK_MS = 30_000;
const metadataQueues = new Map<string, Promise<void>>();

export function createPluginHub(options: CreatePluginHubOptions): PluginHub {
  const dataDir = resolve(options.dataDir);
  const pluginsDir = join(dataDir, "plugins");
  const materializedDir = join(dataDir, "materialized");
  const artifactsDir = join(dataDir, "turn-artifacts");
  const metadataPath = join(dataDir, "plugins.metadata.json");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });

  return {
    async installLocal(input) {
      return withMetadataLock(metadataPath, () => {
        const metadata = loadMetadata(metadataPath);
        const source = inspectSource(input.path, input.compatibility);
        const stored = storeVersion({ source, metadata, pluginsDir });
        saveMetadata(metadataPath, metadata);
        return mapInstalled(stored);
      });
    },

    async scanNative(inputs) {
      return withMetadataLock(metadataPath, () => {
        const metadata = loadMetadata(metadataPath);
        const candidates: PluginCandidate[] = [];
        for (const item of inputs) {
          const absolutePath = resolve(item.path);
          const stats = safeLstat(absolutePath);
          if (!stats) {
            continue;
          }

          const source = inspectSourceForNativeScan(
            absolutePath,
            item.agentProductId,
            item.compatibility ?? inferredScanCompatibility(item.agentProductId),
            metadata,
          );
          if (!source) {
            continue;
          }

          if (hasStoredVersion(metadata, source.pluginId, source.contentHash)) {
            continue;
          }

          const existing = Object.values(metadata.candidates).find(
            (candidate) =>
              candidate.pluginId === source.pluginId &&
              candidate.versionId === source.contentHash &&
              candidate.agentProductId === item.agentProductId,
          );
          if (existing) {
            candidates.push(mapCandidate(existing));
            continue;
          }

          const id = randomUUID();
          const candidate: StoredCandidate = {
            id,
            pluginId: source.pluginId,
            versionId: source.contentHash,
            type: source.type,
            path: absolutePath,
            compatibility: source.compatibility,
            agentProductId: item.agentProductId,
          };
          metadata.candidates[id] = candidate;
          candidates.push(mapCandidate(candidate));
        }

        saveMetadata(metadataPath, metadata);
        return candidates;
      });
    },

    async acceptCandidate(candidateId) {
      return withMetadataLock(metadataPath, () => {
        const metadata = loadMetadata(metadataPath);
        const candidate = metadata.candidates[candidateId];
        if (!candidate) {
          throw new Error("candidate not found");
        }

        const source = inspectSourceForCandidate(candidate, metadata);
        if (source.contentHash !== candidate.versionId) {
          throw new Error("stale candidate");
        }
        const stored = storeVersion({ source, metadata, pluginsDir });
        delete metadata.candidates[candidateId];
        saveMetadata(metadataPath, metadata);
        return mapInstalled(stored);
      });
    },

    resolveForTurn(input) {
      const metadata = loadMetadata(metadataPath);
      const resolved = new Map<string, PluginVersion>();
      applyScope(resolved, input.global ?? [], metadata);
      applyScope(resolved, input.project ?? [], metadata);
      applyScope(resolved, input.conversation ?? [], metadata);
      return [...resolved.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    },

    async materialize(agentProductId, plugins, materializeOptions) {
      return withMetadataLock(metadataPath, () =>
        materializeTransaction({
          agentProductId,
          plugins,
          turnId: materializeOptions?.turnId,
          skillRoots: options.skillRoots,
          materializedDir,
          artifactsDir,
          metadataPath,
        }),
      );
    },
  };
}

function inspectSource(
  pathInput: string,
  compatibilityInput: CompatibilityMap | undefined,
): {
  path: string;
  pluginId: string;
  type: PluginType;
  contentHash: string;
  compatibility: CompatibilityMap;
} {
  const absolutePath = resolve(pathInput);
  const stats = safeLstat(absolutePath);
  if (!stats) {
    throw new Error("source path not found");
  }
  if (stats.isSymbolicLink()) {
    throw new Error("symlink source is not allowed");
  }

  if (stats.isDirectory()) {
    const skillFile = join(absolutePath, "SKILL.md");
    if (!existsSync(skillFile)) {
      throw new Error("skill directory must contain SKILL.md");
    }
    const pluginId = normalizePluginId(basename(absolutePath));
    const contentHash = hashSkillDirectory(absolutePath);
    const compatibility = compatibilityInput ?? {};
    return {
      path: absolutePath,
      pluginId,
      type: "skill",
      contentHash,
      compatibility,
    };
  }

  const raw = readFileSync(absolutePath, "utf8");
  const parsed = parseMcpDefinition(raw);
  const compatibility = parsed.compatibility;
  const hash = hashBytes("plugin.json", Buffer.from(raw, "utf8"));
  return {
    path: absolutePath,
    pluginId: normalizePluginId(parsed.pluginId),
    type: "mcp",
    contentHash: hash,
    compatibility,
  };
}

function inspectSourceForNativeScan(
  pathInput: string,
  agentProductId: AgentProductId,
  compatibilityInput: CompatibilityMap,
  metadata: PluginMetadata,
): {
  path: string;
  pluginId: string;
  type: PluginType;
  contentHash: string;
  compatibility: CompatibilityMap;
} | null {
  const absolutePath = resolve(pathInput);
  const stats = safeLstat(absolutePath);
  if (!stats) {
    return null;
  }

  if (stats.isSymbolicLink()) {
    if (isEchoManagedSymlink(agentProductId, absolutePath, metadata)) {
      return null;
    }
    const real = safeRealpath(absolutePath);
    if (!real) {
      return null;
    }
    const inspected = inspectSource(real, compatibilityInput);
    return {
      ...inspected,
      path: absolutePath,
      pluginId: normalizePluginId(basename(absolutePath)),
    };
  }

  return inspectSource(absolutePath, compatibilityInput);
}

function inspectSourceForCandidate(
  candidate: StoredCandidate,
  metadata: PluginMetadata,
): {
  path: string;
  pluginId: string;
  type: PluginType;
  contentHash: string;
  compatibility: CompatibilityMap;
} {
  const inspected = inspectSourceForNativeScan(
    candidate.path,
    candidate.agentProductId,
    candidate.compatibility,
    metadata,
  );
  if (!inspected) {
    throw new Error("candidate source missing");
  }
  return {
    ...inspected,
    pluginId: candidate.pluginId,
  };
}

function storeVersion(input: {
  source: {
    path: string;
    pluginId: string;
    type: PluginType;
    contentHash: string;
    compatibility: CompatibilityMap;
  };
  metadata: PluginMetadata;
  pluginsDir: string;
}): StoredVersion {
  const existing = getStoredVersion(
    input.metadata,
    input.source.pluginId,
    input.source.contentHash,
  );
  if (existing) {
    return existing;
  }

  const versionId = input.source.contentHash;
  const canonicalPath = join(input.pluginsDir, input.source.pluginId, input.source.contentHash);
  copyCanonicalImmutable(input.source.path, canonicalPath, input.source.type);

  const stored: StoredVersion = {
    pluginId: input.source.pluginId,
    versionId,
    type: input.source.type,
    contentHash: input.source.contentHash,
    canonicalPath,
    compatibility: input.source.compatibility,
  };
  const versionsByPlugin = (input.metadata.versions[input.source.pluginId] ??= {});
  versionsByPlugin[versionId] = stored;
  return stored;
}

function copyCanonicalImmutable(sourcePath: string, destinationPath: string, type: PluginType): void {
  if (existsSync(destinationPath)) {
    return;
  }
  mkdirSync(dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.tmp-${randomUUID()}`;
  try {
    if (type === "skill") {
      copyDirectoryWithoutSymlink(sourcePath, tempPath);
    } else {
      mkdirSync(tempPath, { recursive: true });
      copyFileSync(sourcePath, join(tempPath, "plugin.json"));
    }
    renameSync(tempPath, destinationPath);
  } catch (error) {
    rmSync(tempPath, { recursive: true, force: true });
    throw error;
  }
}

function copyDirectoryWithoutSymlink(source: string, destination: string): void {
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) {
    throw new Error("symlink source is not allowed");
  }
  if (!stats.isDirectory()) {
    throw new Error("skill source must be a directory");
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourceChild = join(source, entry.name);
    const destinationChild = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("symlink source is not allowed");
    }
    if (entry.isDirectory()) {
      copyDirectoryWithoutSymlink(sourceChild, destinationChild);
      continue;
    }
    if (entry.isFile()) {
      copyFileSync(sourceChild, destinationChild);
      continue;
    }
    throw new Error("unsupported source entry");
  }
}

function hashSkillDirectory(root: string): string {
  const hash = createHash("sha256");
  walkSkillFiles(root, ".", hash);
  return hash.digest("hex");
}

function walkSkillFiles(root: string, relativePath: string, hash: ReturnType<typeof createHash>): void {
  const absolute = relativePath === "." ? root : join(root, relativePath);
  const entries = readdirSync(absolute, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const childRelative = relativePath === "." ? entry.name : `${relativePath}/${entry.name}`;
    const childAbsolute = join(root, ...childRelative.split("/"));
    const stats = lstatSync(childAbsolute);
    if (stats.isSymbolicLink()) {
      throw new Error("symlink source is not allowed");
    }
    if (stats.isDirectory()) {
      walkSkillFiles(root, childRelative, hash);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error("unsupported source entry");
    }
    const bytes = readFileSync(childAbsolute);
    hash.update(childRelative);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
}

function hashBytes(relativePathValue: string, bytes: Buffer): string {
  const hash = createHash("sha256");
  hash.update(relativePathValue);
  hash.update("\0");
  hash.update(bytes);
  hash.update("\0");
  return hash.digest("hex");
}

function inferredScanCompatibility(
  sourceAgent: AgentProductId,
): CompatibilityMap {
  return { [sourceAgent]: { kind: "skill" } };
}

function hasStoredVersion(metadata: PluginMetadata, pluginId: string, hash: string): boolean {
  return getStoredVersion(metadata, pluginId, hash) !== null;
}

interface SkillMaterializationPlan {
  plugin: PluginVersion;
  version: StoredVersion;
  targetPath: string;
  materializedPath: string;
  stagedCopyPath: string;
  stagedLinkPath: string;
  previousTargetBackup: string | null;
  previousMaterializedBackup: string | null;
  targetSwitched: boolean;
  materializedSwitched: boolean;
}

function materializeTransaction(input: {
  agentProductId: AgentProductId;
  plugins: PluginVersion[];
  turnId?: string;
  skillRoots: Partial<Record<AgentProductId, string>>;
  materializedDir: string;
  artifactsDir: string;
  metadataPath: string;
}): MaterializeResult {
  const metadata = loadMetadata(input.metadataPath);
  const skillPlans: SkillMaterializationPlan[] = [];
  const mcpServers: Array<{
    pluginId: string;
    versionId: string;
    target: string;
    server: Record<string, unknown>;
  }> = [];

  for (const plugin of input.plugins) {
    const version = getStoredVersion(metadata, plugin.pluginId, plugin.versionId);
    if (!version) {
      throw new Error("plugin version not found");
    }

    if (version.type === "mcp") {
      const compatibility = version.compatibility[input.agentProductId];
      if (!isMcpCompatibility(compatibility)) {
        throw new Error(`plugin ${plugin.pluginId} not compatible with ${input.agentProductId}`);
      }
      assertNoRawSecretFields(compatibility.server, []);
      mcpServers.push({
        pluginId: plugin.pluginId,
        versionId: plugin.versionId,
        target: compatibility.target,
        server: compatibility.server,
      });
      continue;
    }

    const compatibility = version.compatibility[input.agentProductId];
    const root = input.skillRoots[input.agentProductId];
    if (!isSkillCompatibility(compatibility) || !root) {
      throw new Error(`plugin ${plugin.pluginId} not compatible with ${input.agentProductId}`);
    }

    const targetPath = join(resolve(root), plugin.pluginId);
    validateManagedTarget(metadata, input.agentProductId, plugin.pluginId, targetPath);
    const materializedPath = join(
      input.materializedDir,
      input.agentProductId,
      plugin.pluginId,
      plugin.versionId,
    );
    skillPlans.push({
      plugin,
      version,
      targetPath,
      materializedPath,
      stagedCopyPath: `${materializedPath}.stage-${randomUUID()}`,
      stagedLinkPath: join(dirname(targetPath), `${plugin.pluginId}.stage-${randomUUID()}`),
      previousTargetBackup: null,
      previousMaterializedBackup: null,
      targetSwitched: false,
      materializedSwitched: false,
    });
  }

  const turnId = input.turnId ?? randomUUID();
  const artifactPath =
    mcpServers.length > 0
      ? join(input.artifactsDir, input.agentProductId, `${turnId}.json`)
      : null;
  const stagedArtifactPath = artifactPath ? `${artifactPath}.stage-${randomUUID()}` : null;
  const artifactBackupPath = artifactPath && existsSync(artifactPath)
    ? `${artifactPath}.backup-${randomUUID()}`
    : null;
  let artifactSwitched = false;

  try {
    for (const plan of skillPlans) {
      copyDirectoryWithoutSymlink(plan.version.canonicalPath, plan.stagedCopyPath);
      mkdirSync(dirname(plan.stagedLinkPath), { recursive: true });
      symlinkSync(plan.materializedPath, plan.stagedLinkPath, "dir");
    }

    if (artifactPath && stagedArtifactPath) {
      atomicWriteJson(stagedArtifactPath, {
        format: "ain-one.turn.mcp.v1",
        turnId,
        agentProductId: input.agentProductId,
        servers: mcpServers,
      });
    }

    for (const plan of skillPlans) {
      mkdirSync(dirname(plan.materializedPath), { recursive: true });
      if (existsSync(plan.materializedPath)) {
        plan.previousMaterializedBackup = `${plan.materializedPath}.backup-${randomUUID()}`;
        renameSync(plan.materializedPath, plan.previousMaterializedBackup);
      }
      renameSync(plan.stagedCopyPath, plan.materializedPath);
      plan.materializedSwitched = true;

      if (safeLstat(plan.targetPath)) {
        plan.previousTargetBackup = `${plan.targetPath}.backup-${randomUUID()}`;
        renameSync(plan.targetPath, plan.previousTargetBackup);
      }
      renameSync(plan.stagedLinkPath, plan.targetPath);
      plan.targetSwitched = true;
    }

    if (artifactPath && stagedArtifactPath) {
      mkdirSync(dirname(artifactPath), { recursive: true });
      if (artifactBackupPath) {
        renameSync(artifactPath, artifactBackupPath);
      }
      renameSync(stagedArtifactPath, artifactPath);
      artifactSwitched = true;
    }

    const managedTargets = (metadata.managedTargets[input.agentProductId] ??= {});
    for (const plan of skillPlans) {
      managedTargets[plan.targetPath] = {
        pluginId: plan.plugin.pluginId,
        versionId: plan.plugin.versionId,
        targetPath: plan.targetPath,
        materializedPath: plan.materializedPath,
      };
    }
    saveMetadata(input.metadataPath, metadata);
  } catch (error) {
    if (artifactSwitched && artifactPath) {
      removePath(artifactPath);
    }
    if (artifactBackupPath && existsSync(artifactBackupPath) && artifactPath) {
      renameSync(artifactBackupPath, artifactPath);
    }
    removePath(stagedArtifactPath);

    for (const plan of [...skillPlans].reverse()) {
      if (plan.targetSwitched) {
        removePath(plan.targetPath);
      }
      if (plan.previousTargetBackup && existsSync(plan.previousTargetBackup)) {
        renameSync(plan.previousTargetBackup, plan.targetPath);
      }
      if (plan.materializedSwitched) {
        removePath(plan.materializedPath);
      }
      if (plan.previousMaterializedBackup && existsSync(plan.previousMaterializedBackup)) {
        renameSync(plan.previousMaterializedBackup, plan.materializedPath);
      }
      removePath(plan.stagedLinkPath);
      removePath(plan.stagedCopyPath);
    }
    throw error;
  }

  for (const plan of skillPlans) {
    removePathBestEffort(plan.previousTargetBackup);
    removePathBestEffort(plan.previousMaterializedBackup);
  }
  removePathBestEffort(artifactBackupPath);
  return {
    applied: input.plugins,
    turnArtifactPath: artifactPath,
  };
}

function validateManagedTarget(
  metadata: PluginMetadata,
  agentProductId: AgentProductId,
  pluginId: string,
  targetPath: string,
): void {
  const existing = safeLstat(targetPath);
  if (!existing) {
    return;
  }
  const managed = metadata.managedTargets[agentProductId]?.[targetPath];
  if (!managed || managed.pluginId !== pluginId || !existing.isSymbolicLink()) {
    throw new Error(`unmanaged entry: ${targetPath}`);
  }
  const currentReal = safeRealpath(targetPath);
  const materializedReal = safeRealpath(managed.materializedPath);
  if (!currentReal || !materializedReal || currentReal !== materializedReal) {
    throw new Error(`unmanaged entry: ${targetPath}`);
  }
  if (hashSkillDirectory(managed.materializedPath) !== managed.versionId) {
    throw new Error(`managed target has local changes: ${targetPath}`);
  }
}

function applyScope(
  target: Map<string, PluginVersion>,
  scope: PluginVersion[],
  metadata: PluginMetadata,
): void {
  for (const plugin of scope) {
    const version = getStoredVersion(metadata, plugin.pluginId, plugin.versionId);
    if (!version) {
      throw new Error("plugin version not found");
    }
    target.set(plugin.pluginId, {
      pluginId: plugin.pluginId,
      versionId: plugin.versionId,
    });
  }
}

function parseMcpDefinition(raw: string): {
  pluginId: string;
  compatibility: CompatibilityMap;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("invalid JSON plugin definition");
  }

  if (typeof parsed !== "object" || parsed == null) {
    throw new Error("invalid MCP definition");
  }

  const record = parsed as Record<string, unknown>;
  if (record.format !== MCP_FORMAT) {
    throw new Error("MCP definition must use explicit Ain One format");
  }
  if (typeof record.pluginId !== "string" || record.pluginId.trim().length === 0) {
    throw new Error("MCP definition missing pluginId");
  }

  const compatibilityRaw = record.compatibility;
  if (typeof compatibilityRaw !== "object" || compatibilityRaw == null) {
    throw new Error("MCP definition missing compatibility");
  }

  const compatibility: CompatibilityMap = {};
  for (const [agent, spec] of Object.entries(compatibilityRaw)) {
    if (!isAgentProductId(agent)) {
      continue;
    }
    if (typeof spec !== "object" || spec == null) {
      continue;
    }
    const value = spec as Record<string, unknown>;
    if (value.kind !== "mcp") {
      compatibility[agent] = {
        kind: String(value.kind ?? "unknown"),
      };
      continue;
    }
    if (typeof value.target !== "string" || typeof value.server !== "object" || value.server == null) {
      throw new Error("invalid mcp compatibility payload");
    }
    assertNoRawSecretFields(value.server, []);
    compatibility[agent] = {
      kind: "mcp",
      target: value.target,
      server: value.server as Record<string, unknown>,
    };
  }

  return {
    pluginId: record.pluginId,
    compatibility,
  };
}

function isSkillCompatibility(
  compatibility: CompatibilitySpec | undefined,
): compatibility is { kind: "skill" } {
  return compatibility?.kind === "skill";
}

function isMcpCompatibility(
  compatibility: CompatibilitySpec | undefined,
): compatibility is { kind: "mcp"; target: string; server: Record<string, unknown> } {
  return (
    compatibility?.kind === "mcp" &&
    typeof compatibility.target === "string" &&
    typeof compatibility.server === "object" &&
    compatibility.server !== null
  );
}

function isEchoManagedSymlink(
  agentProductId: AgentProductId,
  pathValue: string,
  metadata: PluginMetadata,
): boolean {
  const stats = safeLstat(pathValue);
  if (!stats || !stats.isSymbolicLink()) {
    return false;
  }

  const managedTargets = metadata.managedTargets[agentProductId] ?? {};
  const managed = managedTargets[resolve(pathValue)];
  if (!managed) {
    return false;
  }

  const currentReal = safeRealpath(pathValue);
  const materializedReal = safeRealpath(managed.materializedPath);
  if (!currentReal || !materializedReal || currentReal !== materializedReal) {
    return false;
  }

  try {
    return hashSkillDirectory(managed.materializedPath) === managed.versionId;
  } catch {
    return false;
  }
}

function assertNoRawSecretFields(value: unknown, pathParts: string[]): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoRawSecretFields(value[index], [...pathParts, String(index)]);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  if (isExactSecretRefObject(value)) {
    if (value.secretRef.trim().length === 0) {
      throw new Error(`invalid secretRef at ${pathParts.join(".")}`);
    }
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (isSensitiveKey(normalizedKey)) {
      const childPath = [...pathParts, key].join(".");
      if (typeof child === "string") {
        throw new Error(`raw secret value is not allowed at ${childPath}`);
      }
      if (isExactSecretRefObject(child)) {
        if (child.secretRef.trim().length === 0) {
          throw new Error(`invalid secretRef at ${childPath}`);
        }
        continue;
      }
      assertNoRawSecretFields(child, [...pathParts, key]);
      throw new Error(`sensitive field must use a non-empty secretRef at ${childPath}`);
    }
    assertNoRawSecretFields(child, [...pathParts, key]);
  }
}

function isSensitiveKey(key: string): boolean {
  return new Set([
    "authorization",
    "proxyauthorization",
    "accesstoken",
    "refreshtoken",
    "clientsecret",
    "privatekey",
    "password",
    "passphrase",
    "cookie",
    "setcookie",
    "apikey",
    "token",
    "secret",
  ]).has(key);
}

function isExactSecretRefObject(value: unknown): value is { secretRef: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    Object.keys(value)[0] === "secretRef" &&
    typeof (value as { secretRef?: unknown }).secretRef === "string"
  );
}

function safeLstat(pathValue: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(pathValue);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function safeRealpath(pathValue: string): string | null {
  try {
    return realpathSync(pathValue);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

function loadMetadata(pathValue: string): PluginMetadata {
  if (!existsSync(pathValue)) {
    return structuredClone(EMPTY_METADATA);
  }
  const parsed = JSON.parse(readFileSync(pathValue, "utf8")) as {
    versions?: unknown;
    candidates?: PluginMetadata["candidates"];
    managedTargets?: PluginMetadata["managedTargets"];
  };
  return {
    versions: normalizeVersions(parsed.versions),
    candidates: parsed.candidates ?? {},
    managedTargets: parsed.managedTargets ?? {},
  };
}

function saveMetadata(pathValue: string, metadata: PluginMetadata): void {
  atomicWriteJson(pathValue, metadata);
}

// ponytail: process-local queue; add a filesystem lock if multiple server processes share dataDir.
async function withMetadataLock<T>(pathValue: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = metadataQueues.get(pathValue) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  metadataQueues.set(pathValue, queued);

  await previous.catch(() => undefined);
  let releaseFileLock: (() => void) | null = null;
  try {
    releaseFileLock = await acquireMetadataFileLock(pathValue);
    return await operation();
  } finally {
    releaseFileLock?.();
    release();
    if (metadataQueues.get(pathValue) === queued) {
      metadataQueues.delete(pathValue);
    }
  }
}

async function acquireMetadataFileLock(metadataPath: string): Promise<() => void> {
  const lockPath = `${metadataPath}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const startedAt = Date.now();

  for (;;) {
    let descriptor: number | null = null;
    let created = false;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      created = true;
      writeFileSync(descriptor, token, "utf8");
      closeSync(descriptor);
      descriptor = null;
      return () => releaseMetadataFileLock(lockPath, token);
    } catch (error) {
      if (descriptor !== null) {
        closeSync(descriptor);
      }
      if (created) {
        rmSync(lockPath, { force: true });
      }
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
    }

    if (removeStaleMetadataFileLock(lockPath)) {
      continue;
    }
    if (Date.now() - startedAt >= METADATA_LOCK_TIMEOUT_MS) {
      throw new Error(`plugin metadata lock timeout: ${lockPath}`);
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, METADATA_LOCK_POLL_MS);
    });
  }
}

function releaseMetadataFileLock(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, "utf8") === token) {
      rmSync(lockPath, { force: true });
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

function removeStaleMetadataFileLock(lockPath: string): boolean {
  try {
    const stats = lstatSync(lockPath);
    const ownerPid = Number.parseInt(readFileSync(lockPath, "utf8").split(":", 1)[0] ?? "", 10);
    const ownerGone = Number.isInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid);
    const invalidAndExpired = !Number.isInteger(ownerPid) && Date.now() - stats.mtimeMs > STALE_METADATA_LOCK_MS;
    if (!ownerGone && !invalidAndExpired) {
      return false;
    }
    rmSync(lockPath, { force: true });
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function atomicWriteJson(pathValue: string, value: unknown): void {
  mkdirSync(dirname(pathValue), { recursive: true });
  const temporary = `${pathValue}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, pathValue);
}

function normalizePluginId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (normalized.length === 0) {
    throw new Error("invalid plugin id");
  }
  if (normalized === "." || normalized === "..") {
    throw new Error("invalid plugin id");
  }
  return normalized;
}

function mapInstalled(version: StoredVersion): InstalledPluginVersion {
  return {
    pluginId: version.pluginId,
    versionId: version.versionId,
    type: version.type,
    contentHash: version.contentHash,
    canonicalPath: version.canonicalPath,
  };
}

function mapCandidate(candidate: StoredCandidate): PluginCandidate {
  return {
    id: candidate.id,
    pluginId: candidate.pluginId,
    versionId: candidate.versionId,
    path: candidate.path,
    agentProductId: candidate.agentProductId,
  };
}

function removePath(pathValue: string | null): void {
  if (!pathValue) {
    return;
  }
  rmSync(pathValue, { recursive: true, force: true });
}

function removePathBestEffort(pathValue: string | null): void {
  try {
    removePath(pathValue);
  } catch {
    // A committed materialization stays valid even if an obsolete backup cannot be removed.
  }
}

function getStoredVersion(
  metadata: PluginMetadata,
  pluginId: string,
  versionId: string,
): StoredVersion | null {
  return metadata.versions[pluginId]?.[versionId] ?? null;
}

function normalizeVersions(raw: unknown): PluginMetadata["versions"] {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    return {};
  }

  const looksLegacyFlat = entries.every(([, value]) =>
    typeof value === "object" && value !== null && "pluginId" in value && "versionId" in value,
  );
  if (looksLegacyFlat) {
    const converted: PluginMetadata["versions"] = {};
    for (const [, value] of entries) {
      const version = value as StoredVersion;
      const bucket = (converted[version.pluginId] ??= {});
      bucket[version.versionId] = version;
    }
    return converted;
  }

  const nested: PluginMetadata["versions"] = {};
  for (const [pluginId, versions] of entries) {
    if (!versions || typeof versions !== "object") {
      continue;
    }
    const bucket = (nested[pluginId] ??= {});
    for (const [versionId, value] of Object.entries(versions as Record<string, unknown>)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      bucket[versionId] = value as StoredVersion;
    }
  }
  return nested;
}

function isAgentProductId(value: string): value is AgentProductId {
  return value === "codex" || value === "claude" || value === "trae" || value === "opencode";
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
