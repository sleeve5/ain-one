import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  type: PluginType;
  path: string;
  agentProductId: AgentProductId;
  compatibleAgents: AgentProductId[];
}

export interface InstalledPluginVersion extends PluginVersion {
  type: PluginType;
  contentHash: string;
  canonicalPath: string;
}

export interface InstalledPluginSummary extends InstalledPluginVersion {
  compatibleAgents: AgentProductId[];
  materializations: PluginMaterializationStatus[];
}

export interface PluginMaterializationStatus {
  agentProductId: AgentProductId;
  status: "materialized" | "not_materialized" | "conflicted" | "turn_scoped";
  repairable: boolean;
}

export interface ResolveForTurnInput {
  agentProductId: AgentProductId;
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
  listInstalled(): InstalledPluginSummary[];
  listCandidates(): PluginCandidate[];
  installLocal(input: InstallLocalInput): Promise<InstalledPluginVersion>;
  scanNative(input: ScanNativeInput[]): Promise<PluginCandidate[]>;
  scanConfiguredRoots(): Promise<PluginCandidate[]>;
  acceptCandidate(candidateId: string): Promise<InstalledPluginVersion>;
  repairMaterialization(agentProductId: AgentProductId, plugin: PluginVersion): Promise<void>;
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

type PathIdentity =
  | { kind: "directory"; hash: string }
  | { kind: "file"; hash: string }
  | { kind: "symlink"; target: string };

interface MaterializationJournalEntry {
  path: string;
  stagedPath: string | null;
  backupPath: string | null;
  originalIdentity: PathIdentity | null;
  replacementIdentity: PathIdentity | null;
}

interface MaterializationJournal {
  format: typeof MATERIALIZATION_JOURNAL_FORMAT;
  phase: "applying" | "committed";
  entries: MaterializationJournalEntry[];
}

const EMPTY_METADATA: PluginMetadata = {
  versions: {},
  candidates: {},
  managedTargets: {},
};

const MCP_FORMAT = "ain-one.mcp.v1";
const MATERIALIZATION_JOURNAL_FORMAT = "ain-one.materialization-journal.v1";
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
  const journalPath = join(dataDir, "materialization.journal.json");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  const startupRecovery = withMetadataLock(metadataPath, () => {
    recoverMaterializationJournal(journalPath, dataDir, options.skillRoots);
  });
  void startupRecovery.catch(() => undefined);

  const scanNative = async (inputs: ScanNativeInput[]): Promise<PluginCandidate[]> => {
    await startupRecovery;
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
  };

  return {
    listInstalled() {
      assertNoPendingMaterializationRecovery(journalPath);
      const metadata = loadMetadata(metadataPath);
      return Object.values(metadata.versions)
        .flatMap((versions) => Object.values(versions))
        .map((version) => ({
          ...mapInstalled(version),
          compatibleAgents: Object.keys(version.compatibility)
            .filter(isAgentProductId)
            .filter((agentProductId) =>
              isDispatchableCompatibility(version.compatibility[agentProductId]),
            )
            .sort(),
          materializations: materializationStatuses(version, metadata, options.skillRoots),
        }))
        .sort((left, right) =>
          left.pluginId.localeCompare(right.pluginId) ||
          left.versionId.localeCompare(right.versionId),
        );
    },

    listCandidates() {
      assertNoPendingMaterializationRecovery(journalPath);
      return Object.values(loadMetadata(metadataPath).candidates)
        .map(mapCandidate)
        .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    },

    async installLocal(input) {
      await startupRecovery;
      return withMetadataLock(metadataPath, () => {
        const metadata = loadMetadata(metadataPath);
        const source = inspectSource(input.path, input.compatibility);
        const stored = storeVersion({ source, metadata, pluginsDir });
        saveMetadata(metadataPath, metadata);
        return mapInstalled(stored);
      });
    },

    scanNative,

    async scanConfiguredRoots() {
      const candidates: PluginCandidate[] = [];
      for (const input of configuredSkillInputs(options.skillRoots)) {
        try {
          candidates.push(...await scanNative([input]));
        } catch {
          // A malformed native Skill must not prevent other imports or server startup.
        }
      }
      return candidates;
    },

    async acceptCandidate(candidateId) {
      await startupRecovery;
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

    async repairMaterialization(agentProductId, plugin) {
      await startupRecovery;
      await withMetadataLock(metadataPath, () => {
        const metadata = loadMetadata(metadataPath);
        const version = getStoredVersion(metadata, plugin.pluginId, plugin.versionId);
        if (!version || version.type !== "skill") {
          throw new Error("repair is only available for installed Skills");
        }
        materializeTransaction({
          agentProductId,
          plugins: [plugin],
          reconcileManagedTargets: false,
          skillRoots: options.skillRoots,
          materializedDir,
          artifactsDir,
          metadataPath,
          journalPath,
        });
      });
    },

    resolveForTurn(input) {
      assertNoPendingMaterializationRecovery(journalPath);
      const metadata = loadMetadata(metadataPath);
      const resolved = new Map<string, PluginVersion>();
      applyScope(resolved, input.global ?? [], metadata);
      applyScope(resolved, input.project ?? [], metadata);
      applyScope(resolved, input.conversation ?? [], metadata);
      return [...resolved.values()]
        .filter((plugin) => {
          const version = getStoredVersion(metadata, plugin.pluginId, plugin.versionId);
          const compatibility = version?.compatibility[input.agentProductId];
          return isDispatchableCompatibility(compatibility);
        })
        .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    },

    async materialize(agentProductId, plugins, materializeOptions) {
      await startupRecovery;
      return withMetadataLock(metadataPath, () =>
        materializeTransaction({
          agentProductId,
          plugins,
          reconcileManagedTargets: true,
          turnId: materializeOptions?.turnId,
          skillRoots: options.skillRoots,
          materializedDir,
          artifactsDir,
          metadataPath,
          journalPath,
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
    if (Object.values(compatibility).some((spec) => spec?.kind === "mcp")) {
      throw new Error("Skill compatibility must use kind skill");
    }
    validateCompatibilityTargets(compatibility);
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
  validateCompatibilityTargets(compatibility);
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
    if (
      existing.type !== input.source.type ||
      existing.contentHash !== input.source.contentHash ||
      !isDeepStrictEqual(existing.compatibility, input.source.compatibility)
    ) {
      throw new Error("plugin version metadata conflict");
    }
    assertCanonicalIntegrity(existing);
    return existing;
  }

  const versionId = input.source.contentHash;
  const canonicalPath = join(input.pluginsDir, input.source.pluginId, input.source.contentHash);
  copyCanonicalImmutable(
    input.source.path,
    canonicalPath,
    input.source.type,
    input.source.contentHash,
  );

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

function copyCanonicalImmutable(
  sourcePath: string,
  destinationPath: string,
  type: PluginType,
  expectedHash: string,
): void {
  if (safeLstat(destinationPath)) {
    try {
      if (hashCanonicalPath(destinationPath, type) !== expectedHash) {
        throw new Error("canonical content hash mismatch");
      }
      return;
    } catch (error) {
      removePath(destinationPath);
      throw error;
    }
  }
  mkdirSync(dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.tmp-${randomUUID()}`;
  try {
    if (type === "skill") {
      copyDirectoryWithoutSymlink(sourcePath, tempPath);
    } else {
      mkdirSync(tempPath, { recursive: true });
      copyFileWithoutSymlink(sourcePath, join(tempPath, "plugin.json"));
    }
    if (hashCanonicalPath(tempPath, type) !== expectedHash) {
      throw new Error("source changed during copy");
    }
    renameSync(tempPath, destinationPath);
  } catch (error) {
    rmSync(tempPath, { recursive: true, force: true });
    throw error;
  }
}

function copyDirectoryWithoutSymlink(source: string, destination: string): void {
  const before = lstatSync(source);
  if (before.isSymbolicLink()) {
    throw new Error("symlink source is not allowed");
  }
  if (!before.isDirectory()) {
    throw new Error("skill source must be a directory");
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourceChild = join(source, entry.name);
    const destinationChild = join(destination, entry.name);
    const stats = lstatSync(sourceChild);
    if (stats.isSymbolicLink()) {
      throw new Error("symlink source is not allowed");
    }
    if (stats.isDirectory()) {
      copyDirectoryWithoutSymlink(sourceChild, destinationChild);
      continue;
    }
    if (stats.isFile()) {
      copyFileWithoutSymlink(sourceChild, destinationChild);
      continue;
    }
    throw new Error("unsupported source entry");
  }
  const after = lstatSync(source);
  if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error("source changed during copy");
  }
}

function copyFileWithoutSymlink(source: string, destination: string): void {
  writeFileSync(destination, readFileWithoutSymlink(source), { flag: "wx" });
}

function readFileWithoutSymlink(source: string): Buffer {
  const descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error("source file changed during copy");
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function hashCanonicalPath(pathValue: string, type: PluginType): string {
  const root = lstatSync(pathValue);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("canonical content hash mismatch");
  }
  if (type === "skill") {
    return hashSkillDirectory(pathValue);
  }
  const pluginPath = join(pathValue, "plugin.json");
  const plugin = lstatSync(pluginPath);
  if (plugin.isSymbolicLink() || !plugin.isFile()) {
    throw new Error("canonical content hash mismatch");
  }
  return hashBytes("plugin.json", readFileWithoutSymlink(pluginPath));
}

function assertCanonicalIntegrity(version: StoredVersion): void {
  try {
    if (hashCanonicalPath(version.canonicalPath, version.type) !== version.contentHash) {
      throw new Error("mismatch");
    }
  } catch {
    throw new Error(`canonical content hash mismatch: ${version.pluginId}@${version.versionId}`);
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
    const bytes = readFileWithoutSymlink(childAbsolute);
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

function configuredSkillInputs(
  skillRoots: Partial<Record<AgentProductId, string>>,
): ScanNativeInput[] {
  const inputs: ScanNativeInput[] = [];
  for (const [agentProductId, root] of Object.entries(skillRoots)) {
    if (!isAgentProductId(agentProductId) || !root) {
      continue;
    }
    const stats = safeLstat(root);
    if (!stats?.isDirectory()) {
      continue;
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const path = join(root, entry.name);
      if (existsSync(join(path, "SKILL.md"))) {
        inputs.push({ agentProductId, path });
      }
    }
  }
  return inputs;
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
}

interface StaleManagedTargetPlan {
  targetPath: string;
}

function materializeTransaction(input: {
  agentProductId: AgentProductId;
  plugins: PluginVersion[];
  reconcileManagedTargets: boolean;
  turnId?: string;
  skillRoots: Partial<Record<AgentProductId, string>>;
  materializedDir: string;
  artifactsDir: string;
  metadataPath: string;
  journalPath: string;
}): MaterializeResult {
  const metadata = loadMetadata(input.metadataPath);
  const skillPlans: SkillMaterializationPlan[] = [];
  const stalePlans: StaleManagedTargetPlan[] = [];
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
    assertCanonicalIntegrity(version);

    if (version.type === "mcp") {
      const compatibility = version.compatibility[input.agentProductId];
      if (!isMcpCompatibility(compatibility)) {
        throw new Error(`plugin ${plugin.pluginId} not compatible with ${input.agentProductId}`);
      }
      if (!isDispatchableCompatibility(compatibility)) {
        throw new Error("MCP secret configuration is not available in Phase 1");
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
    });
  }

  if (input.reconcileManagedTargets) {
    const desiredTargets = new Set(skillPlans.map((plan) => plan.targetPath));
    for (const managed of Object.values(metadata.managedTargets[input.agentProductId] ?? {})) {
      if (desiredTargets.has(managed.targetPath)) {
        continue;
      }
      validateManagedTarget(
        metadata,
        input.agentProductId,
        managed.pluginId,
        managed.targetPath,
      );
      stalePlans.push({ targetPath: managed.targetPath });
    }
  }

  if (mcpServers.length > 0 && !input.turnId) {
    throw new Error("Turn ID is required for MCP materialization");
  }
  const turnId = input.turnId;
  const artifactPath =
    mcpServers.length > 0
      ? join(input.artifactsDir, input.agentProductId, `${turnId!}.json`)
      : null;
  const stagedArtifactPath = artifactPath ? `${artifactPath}.stage-${randomUUID()}` : null;
  const stagedMetadataPath = `${input.metadataPath}.stage-${randomUUID()}`;
  let journalWritten = false;

  try {
    for (const plan of skillPlans) {
      copyDirectoryWithoutSymlink(plan.version.canonicalPath, plan.stagedCopyPath);
      mkdirSync(dirname(plan.stagedLinkPath), { recursive: true });
      symlinkSync(plan.materializedPath, plan.stagedLinkPath, "dir");
    }

    if (artifactPath && stagedArtifactPath) {
      atomicWriteJson(stagedArtifactPath, {
        format: "ain-one.turn.mcp.v1",
        turnId: turnId!,
        agentProductId: input.agentProductId,
        servers: mcpServers,
      });
    }

    for (const plan of skillPlans) {
      validateManagedTarget(metadata, input.agentProductId, plan.plugin.pluginId, plan.targetPath);
    }
    for (const plan of stalePlans) {
      const managed = metadata.managedTargets[input.agentProductId]?.[plan.targetPath];
      if (managed) {
        validateManagedTarget(metadata, input.agentProductId, managed.pluginId, plan.targetPath);
      }
    }

    const managedTargets = (metadata.managedTargets[input.agentProductId] ??= {});
    for (const plan of stalePlans) {
      delete managedTargets[plan.targetPath];
    }
    for (const plan of skillPlans) {
      managedTargets[plan.targetPath] = {
        pluginId: plan.plugin.pluginId,
        versionId: plan.plugin.versionId,
        targetPath: plan.targetPath,
        materializedPath: plan.materializedPath,
      };
    }
    atomicWriteJson(stagedMetadataPath, metadata);

    const entries: MaterializationJournalEntry[] = [];
    for (const plan of stalePlans) {
      entries.push(createJournalEntry(plan.targetPath, null));
    }
    for (const plan of skillPlans) {
      entries.push(createJournalEntry(plan.materializedPath, plan.stagedCopyPath));
      entries.push(createJournalEntry(plan.targetPath, plan.stagedLinkPath));
    }
    if (artifactPath && stagedArtifactPath) {
      entries.push(createJournalEntry(artifactPath, stagedArtifactPath));
    }
    entries.push(createJournalEntry(input.metadataPath, stagedMetadataPath));

    const journal: MaterializationJournal = {
      format: MATERIALIZATION_JOURNAL_FORMAT,
      phase: "applying",
      entries,
    };
    atomicWriteJson(input.journalPath, journal, true);
    journalWritten = true;
    applyMaterializationJournal(journal);
    atomicWriteJson(input.journalPath, { ...journal, phase: "committed" }, true);
    recoverMaterializationJournal(input.journalPath, dirname(input.metadataPath), input.skillRoots);
  } catch (error) {
    if (journalWritten) {
      try {
        recoverMaterializationJournal(
          input.journalPath,
          dirname(input.metadataPath),
          input.skillRoots,
        );
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "plugin materialization rollback failed");
      }
    } else {
      for (const plan of skillPlans) {
        removePath(plan.stagedLinkPath);
        removePath(plan.stagedCopyPath);
      }
      removePath(stagedArtifactPath);
      removePath(stagedMetadataPath);
    }
    throw error;
  }

  return {
    applied: input.plugins,
    turnArtifactPath: artifactPath,
  };
}

function createJournalEntry(pathValue: string, stagedPath: string | null): MaterializationJournalEntry {
  const originalIdentity = readPathIdentity(pathValue);
  return {
    path: pathValue,
    stagedPath,
    backupPath: originalIdentity ? `${pathValue}.backup-${randomUUID()}` : null,
    originalIdentity,
    replacementIdentity: stagedPath ? readPathIdentity(stagedPath) : null,
  };
}

function applyMaterializationJournal(journal: MaterializationJournal): void {
  for (const entry of journal.entries) {
    if (!isDeepStrictEqual(readPathIdentity(entry.path), entry.originalIdentity)) {
      throw new Error(`materialization path changed before switch: ${entry.path}`);
    }
    if (entry.backupPath) {
      renameSync(entry.path, entry.backupPath);
      if (!isDeepStrictEqual(readPathIdentity(entry.backupPath), entry.originalIdentity)) {
        throw new Error(`materialization path changed during switch: ${entry.path}`);
      }
    }
    if (entry.stagedPath) {
      if (!isDeepStrictEqual(readPathIdentity(entry.stagedPath), entry.replacementIdentity)) {
        throw new Error(`materialization staged path changed: ${entry.stagedPath}`);
      }
      renameSync(entry.stagedPath, entry.path);
    }
  }
}

function recoverMaterializationJournal(
  journalPath: string,
  dataDir: string,
  skillRoots: Partial<Record<AgentProductId, string>>,
): void {
  if (!safeLstat(journalPath)) {
    return;
  }
  const journal = parseMaterializationJournal(
    readFileSync(journalPath, "utf8"),
    dataDir,
    skillRoots,
  );
  if (journal.phase === "committed") {
    for (const entry of journal.entries) {
      removePath(entry.stagedPath);
      removePath(entry.backupPath);
    }
    removePath(journalPath);
    return;
  }

  for (const entry of [...journal.entries].reverse()) {
    if (entry.backupPath && safeLstat(entry.backupPath)) {
      const current = readPathIdentity(entry.path);
      if (
        current &&
        (!entry.replacementIdentity || !isDeepStrictEqual(current, entry.replacementIdentity))
      ) {
        throw new Error(`materialization recovery conflict: ${entry.path}`);
      }
      removePath(entry.path);
      renameSync(entry.backupPath, entry.path);
    } else {
      const current = readPathIdentity(entry.path);
      if (entry.originalIdentity === null) {
        if (
          current &&
          entry.replacementIdentity &&
          isDeepStrictEqual(current, entry.replacementIdentity)
        ) {
          removePath(entry.path);
        } else if (current) {
          throw new Error(`materialization recovery conflict: ${entry.path}`);
        }
      } else if (!current || !isDeepStrictEqual(current, entry.originalIdentity)) {
        throw new Error(`materialization recovery missing backup: ${entry.path}`);
      }
    }
    removePath(entry.stagedPath);
  }
  removePath(journalPath);
}

function parseMaterializationJournal(
  raw: string,
  dataDir: string,
  skillRoots: Partial<Record<AgentProductId, string>>,
): MaterializationJournal {
  const parsed = JSON.parse(raw) as Partial<MaterializationJournal>;
  if (
    parsed.format !== MATERIALIZATION_JOURNAL_FORMAT ||
    (parsed.phase !== "applying" && parsed.phase !== "committed") ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error("invalid plugin materialization journal");
  }
  for (const entry of parsed.entries) {
    if (!isValidMaterializationJournalEntry(entry, dataDir, skillRoots)) {
      throw new Error("invalid materialization journal path");
    }
  }
  return parsed as MaterializationJournal;
}

function isValidMaterializationJournalEntry(
  entry: unknown,
  dataDir: string,
  skillRoots: Partial<Record<AgentProductId, string>>,
): entry is MaterializationJournalEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const value = entry as Partial<MaterializationJournalEntry>;
  if (typeof value.path !== "string" || !isManagedJournalPath(value.path, dataDir, skillRoots)) {
    return false;
  }
  if (!isJournalSiblingPath(value.backupPath, value.path, "backup")) {
    return false;
  }
  if (!isJournalSiblingPath(value.stagedPath, value.path, "stage")) {
    return false;
  }
  if (!isPathIdentity(value.originalIdentity) || !isPathIdentity(value.replacementIdentity)) {
    return false;
  }
  return (
    (value.backupPath === null) === (value.originalIdentity === null) &&
    (value.stagedPath === null) === (value.replacementIdentity === null)
  );
}

function isManagedJournalPath(
  pathValue: string,
  dataDir: string,
  skillRoots: Partial<Record<AgentProductId, string>>,
): boolean {
  if (!isAbsolute(pathValue) || resolve(pathValue) !== pathValue) {
    return false;
  }
  if (
    pathValue === join(dataDir, "plugins.metadata.json") ||
    isWithinPath(join(dataDir, "materialized"), pathValue) ||
    isWithinPath(join(dataDir, "turn-artifacts"), pathValue)
  ) {
    return true;
  }
  return Object.values(skillRoots).some(
    (root) => root && dirname(pathValue) === resolve(root),
  );
}

function isWithinPath(root: string, pathValue: string): boolean {
  const relativePath = relative(resolve(root), pathValue);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function isJournalSiblingPath(
  candidate: string | null | undefined,
  pathValue: string,
  marker: "backup" | "stage",
): boolean {
  return candidate === null || (
    typeof candidate === "string" &&
    isAbsolute(candidate) &&
    dirname(candidate) === dirname(pathValue) &&
    basename(candidate).startsWith(`${basename(pathValue)}.${marker}-`)
  );
}

function isPathIdentity(value: unknown): value is PathIdentity | null {
  if (value === null) {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const identity = value as Partial<PathIdentity>;
  return (
    (identity.kind === "symlink" && typeof identity.target === "string") ||
    ((identity.kind === "directory" || identity.kind === "file") &&
      typeof identity.hash === "string")
  );
}

function readPathIdentity(pathValue: string): PathIdentity | null {
  const stats = safeLstat(pathValue);
  if (!stats) {
    return null;
  }
  if (stats.isSymbolicLink()) {
    return { kind: "symlink", target: readlinkSync(pathValue) };
  }
  if (stats.isDirectory()) {
    return { kind: "directory", hash: hashSkillDirectory(pathValue) };
  }
  if (stats.isFile()) {
    return {
      kind: "file",
      hash: createHash("sha256").update(readFileWithoutSymlink(pathValue)).digest("hex"),
    };
  }
  throw new Error(`unsupported materialization path: ${pathValue}`);
}

function assertNoPendingMaterializationRecovery(journalPath: string): void {
  if (safeLstat(journalPath)) {
    throw new Error("plugin materialization recovery is pending");
  }
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

function materializationStatuses(
  version: StoredVersion,
  metadata: PluginMetadata,
  skillRoots: Partial<Record<AgentProductId, string>>,
): PluginMaterializationStatus[] {
  return Object.keys(version.compatibility)
    .filter(isAgentProductId)
    .filter((agentProductId) =>
      isDispatchableCompatibility(version.compatibility[agentProductId]),
    )
    .sort()
    .map((agentProductId) => {
      const compatibility = version.compatibility[agentProductId];
      if (isMcpCompatibility(compatibility)) {
        return { agentProductId, status: "turn_scoped", repairable: false };
      }
      const root = skillRoots[agentProductId];
      if (!isSkillCompatibility(compatibility) || !root) {
        return { agentProductId, status: "conflicted", repairable: false };
      }

      const targetPath = join(resolve(root), version.pluginId);
      const target = safeLstat(targetPath);
      const managed = metadata.managedTargets[agentProductId]?.[targetPath];
      if (!target) {
        return { agentProductId, status: "not_materialized", repairable: true };
      }
      if (!managed || managed.pluginId !== version.pluginId || !target.isSymbolicLink()) {
        return { agentProductId, status: "conflicted", repairable: false };
      }

      const currentReal = safeRealpath(targetPath);
      const materializedReal = safeRealpath(managed.materializedPath);
      if (!currentReal || !materializedReal || currentReal !== materializedReal) {
        return { agentProductId, status: "conflicted", repairable: false };
      }
      try {
        if (hashSkillDirectory(managed.materializedPath) !== managed.versionId) {
          return { agentProductId, status: "conflicted", repairable: false };
        }
      } catch {
        return { agentProductId, status: "conflicted", repairable: false };
      }
      return managed.versionId === version.versionId
        ? { agentProductId, status: "materialized", repairable: false }
        : { agentProductId, status: "not_materialized", repairable: true };
    });
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

function validateCompatibilityTargets(compatibility: CompatibilityMap): void {
  for (const [agentProductId, spec] of Object.entries(compatibility)) {
    if (!isAgentProductId(agentProductId) || !isMcpCompatibility(spec)) {
      continue;
    }
    const expected = `${agentProductId}.mcp.v1`;
    if (spec.target !== expected) {
      throw new Error(`MCP compatibility target must be ${expected}`);
    }
  }
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

function isDispatchableCompatibility(
  compatibility: CompatibilitySpec | undefined,
): boolean {
  return isSkillCompatibility(compatibility) ||
    (isMcpCompatibility(compatibility) && !containsSecretRef(compatibility.server));
}

function containsSecretRef(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (isExactSecretRefObject(value)) {
    return true;
  }
  return (Array.isArray(value) ? value : Object.values(value)).some(containsSecretRef);
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
  return [
    "authorization",
    "proxyauthorization",
    "accesskey",
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
  ].some((suffix) => key.endsWith(suffix));
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

function atomicWriteJson(pathValue: string, value: unknown, durable = false): void {
  mkdirSync(dirname(pathValue), { recursive: true });
  const temporary = `${pathValue}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (durable) {
    const descriptor = openSync(temporary, constants.O_RDONLY);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
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
    type: candidate.type,
    path: candidate.path,
    agentProductId: candidate.agentProductId,
    compatibleAgents: Object.keys(candidate.compatibility)
      .filter(isAgentProductId)
      .sort(),
  };
}

function removePath(pathValue: string | null): void {
  if (!pathValue) {
    return;
  }
  rmSync(pathValue, { recursive: true, force: true });
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
