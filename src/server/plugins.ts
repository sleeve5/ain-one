import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
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

export function createPluginHub(options: CreatePluginHubOptions): PluginHub {
  const dataDir = resolve(options.dataDir);
  const pluginsDir = join(dataDir, "plugins");
  const artifactsDir = join(dataDir, "turn-artifacts");
  const metadataPath = join(dataDir, "plugins.metadata.json");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });
  const metadata = loadMetadata(metadataPath);

  return {
    async installLocal(input) {
      const source = inspectSource(input.path, input.compatibility);
      const stored = storeVersion({ source, metadata, pluginsDir });
      saveMetadata(metadataPath, metadata);
      return mapInstalled(stored);
    },

    async scanNative(inputs) {
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
          item.compatibility ?? inferredScanCompatibility(item.agentProductId, options.skillRoots),
          metadata,
          pluginsDir,
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
          candidates.push({
            id: existing.id,
            pluginId: existing.pluginId,
            versionId: existing.versionId,
            path: existing.path,
            agentProductId: existing.agentProductId,
          });
          continue;
        }

        const id = randomUUID();
        metadata.candidates[id] = {
          id,
          pluginId: source.pluginId,
          versionId: source.contentHash,
          type: source.type,
          path: absolutePath,
          compatibility: source.compatibility,
          agentProductId: item.agentProductId,
        };
        candidates.push({
          id,
          pluginId: source.pluginId,
          versionId: source.contentHash,
          path: absolutePath,
          agentProductId: item.agentProductId,
        });
      }

      saveMetadata(metadataPath, metadata);
      return candidates;
    },

    async acceptCandidate(candidateId) {
      const candidate = metadata.candidates[candidateId];
      if (!candidate) {
        throw new Error("candidate not found");
      }

      const source = inspectSourceForCandidate(candidate, metadata, pluginsDir);
      if (source.contentHash !== candidate.versionId) {
        throw new Error("stale candidate");
      }
      const stored = storeVersion({ source, metadata, pluginsDir });
      delete metadata.candidates[candidateId];
      saveMetadata(metadataPath, metadata);
      return mapInstalled(stored);
    },

    resolveForTurn(input) {
      const resolved = new Map<string, PluginVersion>();
      applyScope(resolved, input.global ?? [], metadata);
      applyScope(resolved, input.project ?? [], metadata);
      applyScope(resolved, input.conversation ?? [], metadata);
      return [...resolved.values()].sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    },

    async materialize(agentProductId, plugins, materializeOptions) {
      const applied: PluginVersion[] = [];
      const mcpServers: Array<{
        pluginId: string;
        versionId: string;
        target: string;
        server: Record<string, unknown>;
      }> = [];

      for (const plugin of plugins) {
        const version = getStoredVersion(metadata, plugin.pluginId, plugin.versionId);
        if (!version) {
          throw new Error("plugin version not found");
        }

        if (version.type === "skill") {
          const compatibility = version.compatibility[agentProductId];
          if (!isSkillCompatibility(compatibility)) {
            throw new Error(`plugin ${plugin.pluginId} not compatible with ${agentProductId}`);
          }
          materializeSkill({
            agentProductId,
            plugin,
            version,
            metadata,
            skillRoots: options.skillRoots,
          });
          applied.push(plugin);
          continue;
        }

        const compatibility = version.compatibility[agentProductId];
        if (!isMcpCompatibility(compatibility)) {
          throw new Error(`plugin ${plugin.pluginId} not compatible with ${agentProductId}`);
        }

        mcpServers.push({
          pluginId: plugin.pluginId,
          versionId: plugin.versionId,
          target: compatibility.target,
          server: compatibility.server,
        });
        applied.push(plugin);
      }

      let turnArtifactPath: string | null = null;
      if (mcpServers.length > 0) {
        const turnId = materializeOptions?.turnId ?? randomUUID();
        const target = join(artifactsDir, agentProductId, `${turnId}.json`);
        mkdirSync(dirname(target), { recursive: true });
        atomicWriteJson(target, {
          format: "ain-one.turn.mcp.v1",
          turnId,
          agentProductId,
          servers: mcpServers,
        });
        turnArtifactPath = target;
      }

      saveMetadata(metadataPath, metadata);
      return {
        applied,
        turnArtifactPath,
      };
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
  pluginsDir: string,
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
    if (isEchoManagedSymlink(agentProductId, absolutePath, metadata, pluginsDir)) {
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
  pluginsDir: string,
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
    pluginsDir,
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
  skillRoots: Partial<Record<AgentProductId, string>>,
): CompatibilityMap {
  const compatibility: CompatibilityMap = {};
  for (const key of Object.keys(skillRoots) as AgentProductId[]) {
    compatibility[key] = { kind: "skill" };
  }
  compatibility[sourceAgent] = { kind: "skill" };
  return compatibility;
}

function hasStoredVersion(metadata: PluginMetadata, pluginId: string, hash: string): boolean {
  return getStoredVersion(metadata, pluginId, hash) !== null;
}

function materializeSkill(input: {
  agentProductId: AgentProductId;
  plugin: PluginVersion;
  version: StoredVersion;
  metadata: PluginMetadata;
  skillRoots: Partial<Record<AgentProductId, string>>;
}): void {
  const root = input.skillRoots[input.agentProductId];
  if (!root) {
    throw new Error(`plugin ${input.plugin.pluginId} not compatible with ${input.agentProductId}`);
  }

  const absoluteRoot = resolve(root);
  mkdirSync(absoluteRoot, { recursive: true });
  const targetPath = join(absoluteRoot, input.plugin.pluginId);
  const managedTargets = (input.metadata.managedTargets[input.agentProductId] ??= {});

  const existing = safeLstat(targetPath);
  if (existing) {
    const managed = managedTargets[targetPath];
    if (!managed || managed.pluginId !== input.plugin.pluginId || !existing.isSymbolicLink()) {
      throw new Error(`unmanaged entry: ${targetPath}`);
    }
    const managedVersion = getStoredVersion(
      input.metadata,
      managed.pluginId,
      managed.versionId,
    );
    const currentReal = safeRealpath(targetPath);
    if (!managedVersion || !currentReal || currentReal !== managedVersion.canonicalPath) {
      throw new Error(`unmanaged entry: ${targetPath}`);
    }
  }

  const temporary = join(absoluteRoot, `${input.plugin.pluginId}.tmp-${randomUUID()}`);
  symlinkSync(input.version.canonicalPath, temporary, "dir");
  renameSync(temporary, targetPath);

  managedTargets[targetPath] = {
    pluginId: input.plugin.pluginId,
    versionId: input.plugin.versionId,
    targetPath,
  };
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
  _pluginsDir: string,
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

  const managedVersion = getStoredVersion(metadata, managed.pluginId, managed.versionId);
  const currentReal = safeRealpath(pathValue);
  return Boolean(managedVersion && currentReal && managedVersion.canonicalPath === currentReal);
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

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    if (isSensitiveKey(normalizedKey) && typeof child === "string") {
      throw new Error(`raw secret value is not allowed at ${[...pathParts, key].join(".")}`);
    }
    if (isSensitiveKey(normalizedKey) && isSecretRefObject(child)) {
      continue;
    }
    assertNoRawSecretFields(child, [...pathParts, key]);
  }
}

function isSensitiveKey(key: string): boolean {
  return (
    key === "token" ||
    key === "apikey" ||
    key === "api_key" ||
    key === "secret" ||
    key === "password" ||
    key === "cookie"
  );
}

function isSecretRefObject(value: unknown): value is { secretRef: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "secretRef" in value &&
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
