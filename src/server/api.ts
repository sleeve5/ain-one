import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentCatalog, AgentProbe, AgentProductId, PermissionDecision } from "../shared/contracts.js";
import {
  parseCreateConversation,
  parseCreateProject,
  parsePermissionDecision,
  parseQueueMessage,
} from "../shared/validation.js";
import type { ProjectFilesService } from "./files.js";
import { FilesServiceError } from "./files.js";
import type { Repositories } from "./repositories.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SUPPORTED_AGENTS: AgentProductId[] = ["codex", "claude", "trae", "opencode"];

interface TurnCoordinatorLike {
  enqueueMessage(conversationId: string, content: string): Promise<void>;
  cancelActiveTurn(conversationId: string): Promise<boolean>;
}

interface PermissionResponderInput {
  conversationId: string;
  requestId: string;
  decision: PermissionDecision;
}

interface AgentCatalogProviderInput {
  projectId: string;
  projectPath: string;
  agentProductId: AgentProductId;
}

interface PluginRequest {
  method: string;
  path: string;
  body: unknown;
}

interface PluginResponse {
  status: number;
  body: unknown;
}

interface ApiServerOptions {
  host: string;
  port: number;
  token: string;
  repositories: Repositories;
  turnCoordinator: TurnCoordinatorLike;
  files: ProjectFilesService;
  allowedOrigins?: string[];
  bodyLimitBytes?: number;
  ssePollMs?: number;
  sseHeartbeatMs?: number;
  permissionResponder?: (input: PermissionResponderInput) => Promise<void>;
  catalogProvider?: (input: AgentCatalogProviderInput) => Promise<AgentCatalog>;
  listAgents?: () => Promise<Array<{ agentProductId: AgentProductId; probe: AgentProbe }>>;
  pluginHandler?: (request: PluginRequest) => Promise<PluginResponse>;
}

interface OriginRules {
  exact: Set<string>;
  dynamicLoopback: Set<string>;
}

export interface ApiServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function assertLoopbackHost(host: string): void {
  const normalized = normalizeHost(host);
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new Error(`Loopback host required; received ${host}`);
  }
}

export function createApiServer(options: ApiServerOptions): ApiServer {
  const bodyLimitBytes = options.bodyLimitBytes ?? 64 * 1024;
  const pollMs = options.ssePollMs ?? 500;
  const heartbeatMs = options.sseHeartbeatMs ?? 15_000;
  const originRules = buildOriginRules(options.allowedOrigins);

  let started = false;
  let currentPort = options.port;
  const activeSseClosers = new Set<() => void>();

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      const classified = classifyError(error);
      if (classified.status === 413) {
        response.shouldKeepAlive = false;
        sendError(response, classified.status, classified.code, classified.message, {
          connection: "close",
        });
        response.once("finish", () => {
          request.resume();
          if (!request.destroyed) {
            request.destroy();
          }
        });
        return;
      }
      sendError(response, classified.status, classified.code, classified.message);
    });
  });

  async function start(): Promise<void> {
    if (started) {
      return;
    }

    assertLoopbackHost(options.host);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(options.port, options.host, () => {
        server.off("error", rejectPromise);
        const address = server.address();
        if (address && typeof address === "object") {
          currentPort = address.port;
        }
        started = true;
        resolvePromise();
      });
    });
  }

  async function stop(): Promise<void> {
    if (!started) {
      return;
    }

    for (const closeSse of [...activeSseClosers]) {
      closeSse();
    }

    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      });
    });
    started = false;
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", `http://${formatHost(options.host)}:${currentPort}`);
    const pathname = requestUrl.pathname;

    if (!pathname.startsWith("/api")) {
      sendError(response, 404, "not_found", "Route not found");
      return;
    }

    if (!isAuthorized(request, options.token)) {
      sendError(response, 401, "unauthorized", "Missing or invalid bearer token");
      return;
    }

    if (!isOriginAllowed(request.headers.origin, originRules, currentPort)) {
      sendError(response, 403, "forbidden_origin", "Origin is not allowed");
      return;
    }

    if (request.method === "GET" && pathname === "/api/projects") {
      sendJson(response, 200, { projects: options.repositories.listProjects() });
      return;
    }

    if (request.method === "POST" && pathname === "/api/projects") {
      const body = parseCreateProject(await readJsonBody(request, bodyLimitBytes));
      const canonicalPath = await canonicalProjectPath(body.path);
      const existing = options.repositories.getProjectByPath(canonicalPath);
      if (existing) {
        sendJson(response, 200, { project: existing });
        return;
      }

      const project = options.repositories.createProject(
        canonicalPath,
        body.name ?? basename(canonicalPath),
      );
      sendJson(response, 201, { project });
      return;
    }

    const projectConversationsMatch = match(pathname, /^\/api\/projects\/([^/]+)\/conversations$/);
    if (request.method === "GET" && projectConversationsMatch) {
      const projectId = projectConversationsMatch[0];
      const project = options.repositories.getProject(projectId);
      if (!project) {
        sendError(response, 404, "project_not_found", "Project not found");
        return;
      }
      sendJson(response, 200, {
        conversations: options.repositories.listConversations(projectId),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/conversations") {
      const payload = parseCreateConversation(await readJsonBody(request, bodyLimitBytes));
      const project = options.repositories.getProject(payload.projectId);
      if (!project) {
        sendError(response, 404, "project_not_found", "Project not found");
        return;
      }

      const conversation = options.repositories.createConversation(payload);
      sendJson(response, 201, { conversation });
      return;
    }

    const conversationMatch = match(pathname, /^\/api\/conversations\/([^/]+)$/);
    if (request.method === "GET" && conversationMatch) {
      const conversationId = conversationMatch[0];
      const conversation = options.repositories.getConversation(conversationId);
      if (!conversation) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }

      sendJson(response, 200, {
        conversation,
        queuedMessages: options.repositories.listQueuedMessages(conversationId),
        activeTurn: options.repositories.getActiveTurn(conversationId),
        latestTurn: options.repositories.getLatestTurn(conversationId),
      });
      return;
    }

    const messagesMatch = match(pathname, /^\/api\/conversations\/([^/]+)\/messages$/);
    if (messagesMatch && request.method === "GET") {
      const conversationId = messagesMatch[0];
      if (!options.repositories.getConversation(conversationId)) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }
      sendJson(response, 200, { messages: options.repositories.listQueuedMessages(conversationId) });
      return;
    }

    if (messagesMatch && request.method === "POST") {
      const conversationId = messagesMatch[0];
      if (!options.repositories.getConversation(conversationId)) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }

      const payload = parseQueueMessage(await readJsonBody(request, bodyLimitBytes));
      await options.turnCoordinator.enqueueMessage(conversationId, payload.content);
      sendJson(response, 202, { accepted: true });
      return;
    }

    const deleteMessageMatch = match(
      pathname,
      /^\/api\/conversations\/([^/]+)\/messages\/([^/]+)$/,
    );
    if (request.method === "DELETE" && deleteMessageMatch) {
      const conversationId = deleteMessageMatch[0];
      const messageId = deleteMessageMatch[1];

      if (!options.repositories.getConversation(conversationId)) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }

      const status = options.repositories.deletePendingMessage(conversationId, messageId);
      if (status === "deleted") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (status === "not_pending") {
        sendError(response, 409, "message_not_pending", "Only pending messages can be deleted");
        return;
      }
      sendError(response, 404, "message_not_found", "Message not found");
      return;
    }

    const cancelMatch = match(pathname, /^\/api\/conversations\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      const conversationId = cancelMatch[0];
      if (!options.repositories.getConversation(conversationId)) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }

      const cancelled = await options.turnCoordinator.cancelActiveTurn(conversationId);
      sendJson(response, 200, { cancelled });
      return;
    }

    const permissionMatch = match(
      pathname,
      /^\/api\/conversations\/([^/]+)\/permissions\/([^/]+)$/,
    );
    if (request.method === "POST" && permissionMatch) {
      const conversationId = permissionMatch[0];
      const requestId = permissionMatch[1];

      if (!options.repositories.getConversation(conversationId)) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }

      if (!options.permissionResponder) {
        sendError(
          response,
          501,
          "permission_unsupported",
          "Permission response is not supported",
        );
        return;
      }

      const decision = parsePermissionDecision(await readJsonBody(request, bodyLimitBytes));
      await options.permissionResponder({
        conversationId,
        requestId,
        decision,
      });

      sendJson(response, 200, { accepted: true });
      return;
    }

    const eventsMatch = match(pathname, /^\/api\/conversations\/([^/]+)\/events$/);
    if (request.method === "GET" && eventsMatch) {
      const conversationId = eventsMatch[0];
      if (!options.repositories.getConversation(conversationId)) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }

      const after = parseAfterSequence(requestUrl.searchParams.get("after"), request.headers["last-event-id"]);
      if (after < 0) {
        sendError(response, 400, "invalid_after", "after must be a non-negative integer");
        return;
      }

      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });

      let lastSequence = after;
      let closed = false;

      const flush = (): void => {
        if (closed) {
          return;
        }
        const events = options.repositories.eventsAfter(conversationId, lastSequence);
        for (const event of events) {
          lastSequence = event.sequence;
          response.write(`id: ${event.sequence}\n`);
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      };

      flush();

      const pollTimer = setInterval(flush, pollMs);
      const heartbeatTimer = setInterval(() => {
        if (!closed) {
          response.write(": heartbeat\n\n");
        }
      }, heartbeatMs);

      const closeSse = (): void => {
        cleanup();
        if (!response.writableEnded) {
          response.end();
        }
      };
      activeSseClosers.add(closeSse);

      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        activeSseClosers.delete(closeSse);
        request.off("close", cleanup);
        response.off("close", cleanup);
      };

      request.on("close", cleanup);
      response.on("close", cleanup);
      return;
    }

    if (request.method === "GET" && pathname === "/api/agents") {
      const agents = options.listAgents
        ? await options.listAgents()
        : SUPPORTED_AGENTS.map((agentProductId) => ({
            agentProductId,
            probe: {
              status: "not_installed" as const,
              diagnostic: "Connector not installed yet",
            },
          }));
      sendJson(response, 200, { agents });
      return;
    }

    const catalogMatch = match(pathname, /^\/api\/agents\/([^/]+)\/catalog$/);
    if (request.method === "GET" && catalogMatch) {
      const agentProductId = asAgentProductId(catalogMatch[0]);
      if (!agentProductId) {
        sendError(response, 400, "unsupported_agent", "Unsupported agent product");
        return;
      }

      if (!options.catalogProvider) {
        sendError(response, 501, "catalog_unsupported", "Catalog capability is not available");
        return;
      }

      const projectId = requestUrl.searchParams.get("projectId");
      if (!projectId) {
        sendError(response, 400, "invalid_project", "projectId query parameter is required");
        return;
      }
      const project = options.repositories.getProject(projectId);
      if (!project) {
        sendError(response, 404, "project_not_found", "Project not found");
        return;
      }

      const catalog = await options.catalogProvider({
        agentProductId,
        projectId,
        projectPath: project.path,
      });
      sendJson(response, 200, { catalog });
      return;
    }

    if (pathname === "/api/plugins" && request.method === "GET") {
      if (options.pluginHandler) {
        const result = await options.pluginHandler({
          method: request.method,
          path: pathname,
          body: null,
        });
        sendJson(response, result.status, result.body);
        return;
      }

      sendError(response, 501, "plugins_unsupported", "Plugin listing is not supported");
      return;
    }

    if (pathname.startsWith("/api/plugins") && request.method === "POST") {
      if (!options.pluginHandler) {
        sendError(response, 501, "plugins_unsupported", "Plugin mutations are not supported");
        return;
      }

      const body = await readJsonBody(request, bodyLimitBytes);
      const result = await options.pluginHandler({
        method: request.method,
        path: pathname,
        body,
      });
      sendJson(response, result.status, result.body);
      return;
    }

    const filesMatch = match(pathname, /^\/api\/projects\/([^/]+)\/files$/);
    if (request.method === "GET" && filesMatch) {
      const project = options.repositories.getProject(filesMatch[0]);
      if (!project) {
        sendError(response, 404, "project_not_found", "Project not found");
        return;
      }
      const path = readPathQuery(request.url);
      const files = await options.files.list(project.path, path);
      sendJson(response, 200, files);
      return;
    }

    const previewMatch = match(pathname, /^\/api\/projects\/([^/]+)\/preview$/);
    if (request.method === "GET" && previewMatch) {
      const project = options.repositories.getProject(previewMatch[0]);
      if (!project) {
        sendError(response, 404, "project_not_found", "Project not found");
        return;
      }
      const path = readPathQuery(request.url);
      const preview = await options.files.preview(project.path, path);
      sendJson(response, 200, preview);
      return;
    }

    const gitStatusMatch = match(pathname, /^\/api\/projects\/([^/]+)\/git\/status$/);
    if (request.method === "GET" && gitStatusMatch) {
      const project = options.repositories.getProject(gitStatusMatch[0]);
      if (!project) {
        sendError(response, 404, "project_not_found", "Project not found");
        return;
      }
      const status = await options.files.gitStatus(project.path);
      sendJson(response, 200, status);
      return;
    }

    const gitDiffMatch = match(pathname, /^\/api\/projects\/([^/]+)\/git\/diff$/);
    if (request.method === "GET" && gitDiffMatch) {
      const project = options.repositories.getProject(gitDiffMatch[0]);
      if (!project) {
        sendError(response, 404, "project_not_found", "Project not found");
        return;
      }
      const path = readPathQuery(request.url);
      const diff = await options.files.gitDiff(project.path, path);
      sendJson(response, 200, diff);
      return;
    }

    if (request.method === "GET" && pathname === "/api/settings") {
      sendJson(response, 200, {
        host: options.host,
        port: currentPort,
        securityMode: "bearer_token_with_origin_check",
      });
      return;
    }

    sendError(response, 404, "not_found", "Route not found");
  }

  return {
    get host() {
      return options.host;
    },
    get port() {
      return currentPort;
    },
    get url() {
      return `http://${formatHost(options.host)}:${currentPort}`;
    },
    start,
    stop,
  };
}

interface ClassifiedError {
  status: number;
  code: string;
  message: string;
}

function classifyError(error: unknown): ClassifiedError {
  if (error instanceof FilesServiceError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof InputError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof Error && error.message.startsWith("No connector registered")) {
    return {
      status: 501,
      code: "connector_unsupported",
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      status: 500,
      code: "internal_error",
      message: error.message,
    };
  }

  return {
    status: 500,
    code: "internal_error",
    message: "Unknown error",
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  if (response.writableEnded) {
    return;
  }

  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (response.writableEnded) {
    return;
  }

  for (const [key, value] of Object.entries(headers)) {
    response.setHeader(key, value);
  }

  sendJson(response, status, {
    error: {
      code,
      message,
    },
  });
}

class InputError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += normalized.length;
    if (bytes > maxBytes) {
      throw new InputError(413, "payload_too_large", "Request body exceeds size limit");
    }
    chunks.push(normalized);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new InputError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function readPathQuery(rawUrl: string | undefined): string | null {
  const rawValue = readRawQueryValue(rawUrl, "path");
  if (rawValue === null) {
    return null;
  }

  try {
    return decodeURIComponent(rawValue.replace(/\+/g, "%20"));
  } catch {
    throw new InputError(
      400,
      "invalid_path_encoding",
      "Query parameter path must be valid URL encoding",
    );
  }
}

function readRawQueryValue(rawUrl: string | undefined, key: string): string | null {
  if (!rawUrl) {
    return null;
  }

  const queryIndex = rawUrl.indexOf("?");
  if (queryIndex === -1) {
    return null;
  }

  const query = rawUrl.slice(queryIndex + 1);
  if (query.length === 0) {
    return null;
  }

  for (const part of query.split("&")) {
    const equalsIndex = part.indexOf("=");
    const rawKey = equalsIndex === -1 ? part : part.slice(0, equalsIndex);
    if (rawKey !== key) {
      continue;
    }
    return equalsIndex === -1 ? "" : part.slice(equalsIndex + 1);
  }

  return null;
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") {
    return false;
  }
  const match = /^Bearer (.+)$/.exec(authorization);
  if (!match) {
    return false;
  }
  return secureCompare(token, match[1]);
}

function secureCompare(expected: string, provided: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

function isOriginAllowed(
  originHeader: string | string[] | undefined,
  originRules: OriginRules | null,
  serverPort: number,
): boolean {
  if (!originHeader) {
    return true;
  }

  const value = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  const origin = normalizeOrigin(value);
  if (!origin) {
    return false;
  }

  if (originRules) {
    if (originRules.exact.has(origin)) {
      return true;
    }

    try {
      const parsed = new URL(origin);
      const key = `${parsed.protocol}//${normalizeHost(parsed.hostname)}`;
      return originRules.dynamicLoopback.has(key) && resolveOriginPort(parsed) === serverPort;
    } catch {
      return false;
    }
  }

  try {
    const parsed = new URL(origin);
    return LOOPBACK_HOSTS.has(normalizeHost(parsed.hostname));
  } catch {
    return false;
  }
}

function buildOriginRules(allowedOrigins: string[] | undefined): OriginRules | null {
  if (!allowedOrigins || allowedOrigins.length === 0) {
    return null;
  }

  const exact = new Set<string>();
  const dynamicLoopback = new Set<string>();
  for (const rawOrigin of allowedOrigins) {
    const origin = normalizeOrigin(rawOrigin);
    if (!origin) {
      continue;
    }

    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      continue;
    }

    const host = normalizeHost(parsed.hostname);
    if (LOOPBACK_HOSTS.has(host) && resolveOriginPort(parsed) === 0) {
      dynamicLoopback.add(`${parsed.protocol}//${host}`);
      continue;
    }

    exact.add(origin);
  }

  return { exact, dynamicLoopback };
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function normalizeHost(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function parseAfterSequence(queryValue: string | null, headerValue: string | string[] | undefined): number {
  const raw =
    queryValue ??
    (Array.isArray(headerValue) ? headerValue[0] ?? null : headerValue ?? null) ??
    "0";
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    return -1;
  }

  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < 0) {
    return -1;
  }

  return value;
}

function resolveOriginPort(origin: URL): number | null {
  if (origin.port.length > 0) {
    const value = Number.parseInt(origin.port, 10);
    return Number.isFinite(value) ? value : null;
  }

  if (origin.protocol === "http:") {
    return 80;
  }
  if (origin.protocol === "https:") {
    return 443;
  }
  return null;
}

function formatHost(host: string): string {
  const normalized = normalizeHost(host);
  if (normalized.includes(":")) {
    return `[${normalized}]`;
  }
  return normalized;
}

function match(pathname: string, regex: RegExp): string[] | null {
  const matched = regex.exec(pathname);
  if (!matched) {
    return null;
  }

  try {
    return matched.slice(1).map((segment) => decodeURIComponent(segment));
  } catch {
    throw new InputError(400, "invalid_path_encoding", "Route parameters must be valid URL encoding");
  }
}

function asAgentProductId(value: string): AgentProductId | null {
  return SUPPORTED_AGENTS.includes(value as AgentProductId)
    ? (value as AgentProductId)
    : null;
}

async function canonicalProjectPath(path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new InputError(404, "path_not_found", "Project path does not exist");
  }

  const details = await stat(canonical);
  if (!details.isDirectory()) {
    throw new InputError(400, "path_not_directory", "Project path must be a directory");
  }

  return canonical;
}
