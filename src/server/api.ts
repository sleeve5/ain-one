import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { access, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AgentCatalog, AgentProbe, AgentProductId, GraphDefinition, GraphRun, PermissionDecision, PluginVersion } from "../shared/contracts.js";
import {
  parseAgentSettings,
  parseConversationSettings,
  parseConversationManagementPatch,
  parseCreateConversation,
  parseCreateProject,
  parsePermissionDecision,
  parsePluginEnablements,
  parseProjectManagementPatch,
  parseQueueMessage,
  parseUncertainMessageResolution,
  ValidationError,
  validateGraphDefinition,
} from "../shared/validation.js";
import type { ProjectFilesService } from "./files.js";
import { FilesServiceError } from "./files.js";
import type { PluginScope, Repositories } from "./repositories.js";
import type { CreateGraphInput, GraphRepository } from "./graph-repository.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SUPPORTED_AGENTS: AgentProductId[] = ["codex", "claude", "trae", "opencode"];

interface TurnCoordinatorLike {
  enqueueMessage(conversationId: string, content: string): Promise<void>;
  cancelActiveTurn(conversationId: string): Promise<boolean>;
  continueConversation(conversationId: string): Promise<boolean>;
  retryInterruptedTurn(conversationId: string, turnId: string): Promise<boolean>;
  resolveUncertainDelivery?(conversationId: string, messageId: string, action: "retry" | "accept"): Promise<boolean>;
  respondToPermission?(conversationId: string, requestId: string, decision: PermissionDecision): Promise<boolean>;
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

interface AgentSettingsUpdate {
  agentProductId: AgentProductId;
  executablePath?: string | null;
  enabled?: boolean;
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
  pickProjectDirectory?: () => Promise<string | null>;
  pickLocalPath?: (kind: "directory" | "file", purpose: "plugin" | "agent") => Promise<string | null>;
  allowedOrigins?: string[];
  bodyLimitBytes?: number;
  ssePollMs?: number;
  sseHeartbeatMs?: number;
  sseReplayBatchSize?: number;
  permissionResponder?: (input: PermissionResponderInput) => Promise<void>;
  catalogProvider?: (input: AgentCatalogProviderInput) => Promise<AgentCatalog>;
  listAgents?: () => Promise<Array<{
    agentProductId: AgentProductId;
    executablePath: string;
    executablePathOverride: string | null;
    enabled: boolean;
    probe: AgentProbe;
  }>>;
  updateAgentSettings?: (
    input: AgentSettingsUpdate,
  ) => Promise<"updated" | "turn_active">;
  resolvePluginVersions?: (input: {
    projectId: string;
    conversationId: string;
    agentProductId: AgentProductId;
  }) => PluginVersion[];
  validatePluginVersions?: (scope: PluginScope, pluginVersions: PluginVersion[]) => void;
  pluginHandler?: (request: PluginRequest) => Promise<PluginResponse>;
  graphRepository?: GraphRepository;
  graphRuntime?: { run(graphId: string, input: string): Promise<GraphRun>; cancel(runId: string): Promise<boolean> };
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
  const replayBatchSize = options.sseReplayBatchSize ?? 100;
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

  const registerProject = async (path: string, name: string | null) => {
    const canonicalPath = await canonicalProjectPath(path);
    const existing = options.repositories.getProjectByPath(canonicalPath);
    if (existing) {
      if (existing.archivedAt) options.repositories.archiveProject(existing.id, false);
      return { status: 200, project: options.repositories.getProject(existing.id)! } as const;
    }
    return {
      status: 201,
      project: options.repositories.createProject(
        canonicalPath,
        name ?? basename(canonicalPath),
      ),
    } as const;
  };

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

    const projectGraphsMatch = match(pathname, /^\/api\/projects\/([^/]+)\/graphs$/);
    if (projectGraphsMatch && request.method === "GET") {
      if (!options.graphRepository) { sendError(response, 501, "graph_unsupported", "Graph is unavailable"); return; }
      if (!options.repositories.getProject(projectGraphsMatch[0])) { sendError(response, 404, "project_not_found", "Project not found"); return; }
      sendJson(response, 200, { graphs: options.graphRepository.listGraphs(projectGraphsMatch[0]) });
      return;
    }
    if (projectGraphsMatch && request.method === "POST") {
      if (!options.graphRepository) { sendError(response, 501, "graph_unsupported", "Graph is unavailable"); return; }
      if (!options.repositories.getProject(projectGraphsMatch[0])) { sendError(response, 404, "project_not_found", "Project not found"); return; }
      const input = parseGraphWrite(await readJsonBody(request, bodyLimitBytes), true);
      sendJson(response, 201, { graph: options.graphRepository.createGraph({ ...input as CreateGraphInput, projectId: projectGraphsMatch[0] }) });
      return;
    }

    const graphMatch = match(pathname, /^\/api\/graphs\/([^/]+)$/);
    if (graphMatch && request.method === "GET") {
      const graph = options.graphRepository?.getGraph(graphMatch[0]);
      if (!graph) { sendError(response, 404, "graph_not_found", "Graph not found"); return; }
      sendJson(response, 200, { graph, latestRun: options.graphRepository?.getLatestRun(graph.id) ?? null });
      return;
    }
    if (graphMatch && request.method === "PUT") {
      const current = options.graphRepository?.getGraph(graphMatch[0]);
      if (!current) { sendError(response, 404, "graph_not_found", "Graph not found"); return; }
      const patch = parseGraphWrite(await readJsonBody(request, bodyLimitBytes), false);
      sendJson(response, 200, { graph: options.graphRepository!.updateGraph(current.id, patch) });
      return;
    }
    if (graphMatch && request.method === "DELETE") {
      if (options.graphRepository?.getLatestRun(graphMatch[0])?.status === "running") { sendError(response, 409, "graph_run_active", "A running Graph cannot be deleted"); return; }
      if (!options.graphRepository?.deleteGraph(graphMatch[0])) { sendError(response, 404, "graph_not_found", "Graph not found"); return; }
      response.writeHead(204); response.end(); return;
    }

    const graphRunsMatch = match(pathname, /^\/api\/graphs\/([^/]+)\/runs$/);
    if (graphRunsMatch && request.method === "POST") {
      const graph = options.graphRepository?.getGraph(graphRunsMatch[0]);
      if (!graph) { sendError(response, 404, "graph_not_found", "Graph not found"); return; }
      if (!options.graphRuntime) { sendError(response, 501, "graph_runtime_unsupported", "Graph runtime is unavailable"); return; }
      const graphRepository = options.graphRepository;
      if (!graphRepository) { sendError(response, 501, "graph_unsupported", "Graph is unavailable"); return; }
      const body = readRecord(await readJsonBody(request, bodyLimitBytes), "Invalid graph run payload");
      if (typeof body.input !== "string") throw new ValidationError("input must be a string");
      const runPromise = options.graphRuntime.run(graph.id, body.input);
      await new Promise((resolve) => setImmediate(resolve));
      const run = graphRepository.getLatestRun(graph.id) ?? await runPromise;
      void runPromise.catch(() => undefined);
      sendJson(response, 202, { run });
      return;
    }

    const graphRunMatch = match(pathname, /^\/api\/graph-runs\/([^/]+)$/);
    if (graphRunMatch && request.method === "GET") {
      const run = options.graphRepository?.getRun(graphRunMatch[0]);
      if (!run) { sendError(response, 404, "graph_run_not_found", "Graph Run not found"); return; }
      sendJson(response, 200, { run, nodeRuns: options.graphRepository!.listNodeRuns(run.id), events: options.graphRepository!.eventsAfter(run.id, 0) });
      return;
    }
    const graphCancelMatch = match(pathname, /^\/api\/graph-runs\/([^/]+)\/cancel$/);
    if (graphCancelMatch && request.method === "POST") {
      const cancelled = await options.graphRuntime?.cancel(graphCancelMatch[0]) ?? false;
      sendJson(response, 200, { cancelled }); return;
    }
    const graphEventsMatch = match(pathname, /^\/api\/graph-runs\/([^/]+)\/events$/);
    if (graphEventsMatch && request.method === "GET") {
      const runId = graphEventsMatch[0];
      if (!options.graphRepository?.getRun(runId)) { sendError(response, 404, "graph_run_not_found", "Graph Run not found"); return; }
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
      let last = parseAfterSequence(requestUrl.searchParams.get("after"), request.headers["last-event-id"]);
      let closed = false;
      const flush = () => { for (const event of options.graphRepository!.eventsAfter(runId, last, replayBatchSize)) { response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`); last = event.sequence; } };
      flush();
      const timer = setInterval(flush, pollMs);
      const close = () => { if (closed) return; closed = true; clearInterval(timer); activeSseClosers.delete(close); if (!response.writableEnded) response.end(); };
      activeSseClosers.add(close); request.once("close", close); response.once("close", close);
      return;
    }

    if (request.method === "GET" && pathname === "/api/projects") {
      sendJson(response, 200, {
        projects: options.repositories.listProjects(requestUrl.searchParams.get("archived") === "true"),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/projects") {
      const body = parseCreateProject(await readJsonBody(request, bodyLimitBytes));
      const result = await registerProject(body.path, body.name);
      sendJson(response, result.status, { project: result.project });
      return;
    }

    if (request.method === "POST" && pathname === "/api/projects/pick") {
      if (!options.pickProjectDirectory) {
        sendError(response, 501, "folder_picker_unsupported", "Folder picker is not available");
        return;
      }
      const selectedPath = await options.pickProjectDirectory();
      if (selectedPath === null) {
        sendJson(response, 200, { project: null });
        return;
      }
      const result = await registerProject(selectedPath, null);
      sendJson(response, result.status, { project: result.project });
      return;
    }

    if (request.method === "GET" && pathname === "/api/host/pick-path") {
      if (!options.pickLocalPath) {
        sendError(response, 501, "path_picker_unsupported", "Path picker is not available");
        return;
      }
      const kind = requestUrl.searchParams.get("kind");
      const purpose = requestUrl.searchParams.get("purpose");
      if ((kind !== "directory" && kind !== "file") || (purpose !== "plugin" && purpose !== "agent")) {
        sendError(response, 400, "invalid_path_picker", "Invalid path picker request");
        return;
      }
      sendJson(response, 200, { path: await options.pickLocalPath(kind, purpose) });
      return;
    }

    const projectMatch = match(pathname, /^\/api\/projects\/([^/]+)$/);
    if (request.method === "PATCH" && projectMatch) {
      const projectId = projectMatch[0];
      const body = parseProjectManagementPatch(await readJsonBody(request, bodyLimitBytes));
      if (!options.repositories.getProject(projectId)) {
        sendError(response, 404, "project_not_found", "Project not found");
        return;
      }
      if (body.name !== undefined) options.repositories.renameProject(projectId, body.name);
      if (body.archived !== undefined && options.repositories.archiveProject(projectId, body.archived) === "turn_active") {
        sendError(response, 409, "turn_active", "A Project with an active Turn cannot be archived");
        return;
      }
      sendJson(response, 200, { project: options.repositories.getProject(projectId) });
      return;
    }
    if (request.method === "DELETE" && projectMatch) {
      const result = options.repositories.deleteArchivedProject(projectMatch[0]);
      if (result === "not_found") { sendError(response, 404, "project_not_found", "Project not found"); return; }
      if (result === "not_archived") { sendError(response, 409, "project_not_archived", "Only archived Projects can be deleted"); return; }
      if (result === "turn_active") { sendError(response, 409, "turn_active", "A Project with an active Turn cannot be deleted"); return; }
      response.writeHead(204);
      response.end();
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
        conversations: options.repositories.listConversations(
          projectId,
          requestUrl.searchParams.get("archived") === "true",
        ),
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

      const permissionMode = await validateConversationCatalog(options, {
        projectId: project.id,
        projectPath: project.path,
        agentProductId: payload.agentProductId,
        modelId: payload.modelId,
        permissionMode: payload.permissionMode,
      });

      const conversation = options.repositories.createConversation({ ...payload, permissionMode });
      sendJson(response, 201, { conversation });
      return;
    }

    const conversationMatch = match(pathname, /^\/api\/conversations\/([^/]+)$/);
    if (request.method === "DELETE" && conversationMatch) {
      const result = options.repositories.deleteArchivedConversation(conversationMatch[0]);
      if (result === "not_found") { sendError(response, 404, "conversation_not_found", "Conversation not found"); return; }
      if (result === "not_archived") { sendError(response, 409, "conversation_not_archived", "Only archived Conversations can be deleted"); return; }
      if (result === "turn_active") { sendError(response, 409, "turn_active", "An active Conversation cannot be deleted"); return; }
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "PATCH" && conversationMatch) {
      const conversationId = conversationMatch[0];
      const body = parseConversationManagementPatch(await readJsonBody(request, bodyLimitBytes));
      const current = options.repositories.getConversation(conversationId);
      if (!current) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }
      if (body.title !== undefined) {
        options.repositories.renameConversation(conversationId, body.title);
      }
      if (body.archived !== undefined) {
        if (options.repositories.archiveConversation(conversationId, body.archived) === "turn_active") {
          sendError(response, 409, "turn_active", "An active Conversation cannot be archived");
          return;
        }
      }
      sendJson(response, 200, { conversation: options.repositories.getConversation(conversationId) });
      return;
    }

    const forkConversationMatch = match(pathname, /^\/api\/conversations\/([^/]+)\/fork$/);
    if (request.method === "POST" && forkConversationMatch) {
      const conversation = options.repositories.forkConversation(forkConversationMatch[0]);
      if (!conversation) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }
      sendJson(response, 201, { conversation });
      return;
    }
    if (request.method === "GET" && conversationMatch) {
      const conversationId = conversationMatch[0];
      const conversation = options.repositories.getConversation(conversationId);
      if (!conversation) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }

      sendJson(response, 200, {
        conversation,
        pluginVersions: resolveConversationPlugins(options, conversation),
        queuedMessages: options.repositories.listQueuedMessages(conversationId),
        activeTurn: options.repositories.getActiveTurn(conversationId),
        latestTurn: options.repositories.getLatestTurn(conversationId),
        events: options.repositories.eventsAfter(conversationId, 0),
      });
      return;
    }

    const conversationSettingsMatch = match(
      pathname,
      /^\/api\/conversations\/([^/]+)\/settings$/,
    );
    if (request.method === "PUT" && conversationSettingsMatch) {
      const conversationId = conversationSettingsMatch[0];
      const settings = parseConversationSettings(await readJsonBody(request, bodyLimitBytes));
      const conversation = options.repositories.getConversation(conversationId);
      if (!conversation) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }
      if (options.repositories.getActiveTurn(conversationId)) {
        sendError(response, 409, "turn_active", "Settings can change only between Turns");
        return;
      }
      const project = options.repositories.getProject(conversation.projectId);
      if (!project) {
        sendError(response, 404, "project_not_found", "Project not found");
        return;
      }
      await validateConversationCatalog(options, {
        projectId: project.id,
        projectPath: project.path,
        agentProductId: conversation.agentProductId,
        modelId: settings.modelId,
        permissionMode: settings.permissionMode,
      });
      const result = options.repositories.updateConversationSettings(conversationId, settings);
      if (result === "not_found") {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }
      if (result === "turn_active") {
        sendError(response, 409, "turn_active", "Settings can change only between Turns");
        return;
      }
      sendJson(response, 200, {
        conversation: options.repositories.getConversation(conversationId),
        pluginVersions: resolveConversationPlugins(
          options,
          options.repositories.getConversation(conversationId)!,
        ),
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
      const conversation = options.repositories.getConversation(conversationId);
      if (!conversation) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }
      if (!options.repositories.isAgentEnabled(conversation.agentProductId)) {
        sendError(response, 409, "agent_disabled", "This Agent is disabled");
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
    const resolveMessageMatch = match(
      pathname,
      /^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/resolve$/,
    );
    if (request.method === "POST" && resolveMessageMatch) {
      const action = parseUncertainMessageResolution(await readJsonBody(request, bodyLimitBytes));
      const resolved = await options.turnCoordinator.resolveUncertainDelivery?.(
        resolveMessageMatch[0], resolveMessageMatch[1], action,
      );
      if (!resolved) {
        sendError(response, 409, "message_not_uncertain", "Message is no longer awaiting confirmation");
        return;
      }
      sendJson(response, 200, { resolved: true });
      return;
    }
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

    const continueMatch = match(pathname, /^\/api\/conversations\/([^/]+)\/continue$/);
    if (request.method === "POST" && continueMatch) {
      const conversationId = continueMatch[0];
      if (!options.repositories.getConversation(conversationId)) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }
      await options.turnCoordinator.continueConversation(conversationId);
      sendJson(response, 200, { accepted: true });
      return;
    }

    const retryMatch = match(
      pathname,
      /^\/api\/conversations\/([^/]+)\/turns\/([^/]+)\/retry$/,
    );
    if (request.method === "POST" && retryMatch) {
      const conversationId = retryMatch[0];
      if (!options.repositories.getConversation(conversationId)) {
        sendError(response, 404, "conversation_not_found", "Conversation not found");
        return;
      }
      const accepted = await options.turnCoordinator.retryInterruptedTurn(
        conversationId,
        retryMatch[1],
      );
      if (!accepted) {
        sendError(response, 409, "turn_not_interrupted", "Turn is not retryable");
        return;
      }
      sendJson(response, 200, { accepted: true });
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

      const respond = options.permissionResponder ?? (options.turnCoordinator.respondToPermission
        ? async (input: PermissionResponderInput) => {
            const accepted = await options.turnCoordinator.respondToPermission!(input.conversationId, input.requestId, input.decision);
            if (!accepted) throw new InputError(409, "permission_not_active", "Permission request is no longer active");
          }
        : undefined);
      if (!respond) {
        sendError(
          response,
          501,
          "permission_unsupported",
          "Permission response is not supported",
        );
        return;
      }

      const decision = parsePermissionDecision(await readJsonBody(request, bodyLimitBytes));
      await respond({
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
      let flushing = false;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        if (pollTimer) {
          clearInterval(pollTimer);
        }
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        activeSseClosers.delete(closeSse);
        request.off("close", cleanup);
        response.off("close", cleanup);
      };

      const closeSse = (): void => {
        cleanup();
        if (!response.writableEnded) {
          response.end();
        }
      };
      activeSseClosers.add(closeSse);

      const flush = async (): Promise<void> => {
        if (closed || flushing) {
          return;
        }
        flushing = true;
        try {
          while (!closed) {
            const events = options.repositories.eventsAfter(
              conversationId,
              lastSequence,
              replayBatchSize,
            );
            if (events.length === 0) {
              return;
            }
            for (const event of events) {
              if (isUncommittedTerminalEvent(options.repositories, event)) {
                return;
              }
              const written = await writeWithBackpressure(
                response,
                `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
              );
              if (!written) {
                return;
              }
              lastSequence = event.sequence;
            }
            if (events.length < replayBatchSize) {
              return;
            }
          }
        } finally {
          flushing = false;
        }
      };

      const scheduleFlush = (): void => {
        void flush().catch(closeSse);
      };
      scheduleFlush();

      pollTimer = setInterval(scheduleFlush, pollMs);
      heartbeatTimer = setInterval(() => {
        if (!closed && !response.writableNeedDrain) {
          response.write(": heartbeat\n\n");
        }
      }, heartbeatMs);

      request.on("close", cleanup);
      response.on("close", cleanup);
      return;
    }

    if (request.method === "GET" && pathname === "/api/agents") {
      const agents = options.listAgents
        ? await options.listAgents()
        : SUPPORTED_AGENTS.map((agentProductId) => ({
            agentProductId,
            executablePath: agentProductId === "trae" ? "traecli" : agentProductId,
            executablePathOverride: null,
            enabled: true,
            probe: {
              status: "not_installed" as const,
              diagnostic: "Connector not installed yet",
            },
          }));
      sendJson(response, 200, { agents });
      return;
    }

    const agentSettingsMatch = match(pathname, /^\/api\/agents\/([^/]+)\/settings$/);
    if (request.method === "PUT" && agentSettingsMatch) {
      const agentProductId = asAgentProductId(agentSettingsMatch[0]);
      if (!agentProductId) {
        sendError(response, 400, "unsupported_agent", "Unsupported agent product");
        return;
      }
      if (options.repositories.hasActiveTurnForAgent(agentProductId)) {
        sendError(response, 409, "turn_active", "Agent settings can change only between Turns");
        return;
      }
      if (!options.updateAgentSettings) {
        sendError(response, 501, "agent_settings_unsupported", "Agent settings are not supported");
        return;
      }

      const settings = parseAgentSettings(await readJsonBody(request, bodyLimitBytes));
      const executablePath = typeof settings.executablePath === "string"
        ? await canonicalExecutablePath(settings.executablePath)
        : settings.executablePath;
      const result = await options.updateAgentSettings({
        agentProductId,
        ...(executablePath !== undefined ? { executablePath } : {}),
        ...(settings.enabled !== undefined ? { enabled: settings.enabled } : {}),
      });
      if (result === "turn_active") {
        sendError(response, 409, "turn_active", "Agent settings can change only between Turns");
        return;
      }
      sendJson(response, 200, { agentProductId, executablePath, enabled: settings.enabled });
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

    const pluginScope = parsePluginScope(pathname);
    if (pluginScope && (request.method === "GET" || request.method === "PUT")) {
      if (!pluginScopeExists(options.repositories, pluginScope)) {
        sendError(response, 404, "scope_not_found", "Plugin scope not found");
        return;
      }
      if (request.method === "PUT") {
        const input = parsePluginEnablements(await readJsonBody(request, bodyLimitBytes));
        options.validatePluginVersions?.(pluginScope, input.pluginVersions);
        options.repositories.setPluginEnablements(pluginScope, input.pluginVersions);
      }
      sendJson(response, 200, {
        pluginVersions: options.repositories.listPluginEnablements(pluginScope),
      });
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

async function writeWithBackpressure(
  response: ServerResponse,
  chunk: string,
): Promise<boolean> {
  if (response.destroyed || response.writableEnded) {
    return false;
  }
  if (response.write(chunk)) {
    return true;
  }

  return new Promise<boolean>((resolvePromise) => {
    const onDrain = (): void => settle(true);
    const onClose = (): void => settle(false);
    const settle = (writable: boolean): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      resolvePromise(writable);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
  });
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

  if (error instanceof ValidationError) {
    return {
      status: 400,
      code: "invalid_input",
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

export class InputError extends Error {
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

async function canonicalExecutablePath(path: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new InputError(404, "executable_not_found", "Agent executable path does not exist");
  }
  const details = await stat(canonical);
  if (!details.isFile()) {
    throw new InputError(400, "executable_not_file", "Agent executable path must be a file");
  }
  try {
    await access(canonical, constants.X_OK);
  } catch {
    throw new InputError(400, "executable_not_executable", "Agent executable path is not executable");
  }
  return canonical;
}

function parsePluginScope(pathname: string): PluginScope | null {
  if (pathname === "/api/plugins/enablements/global") {
    return { type: "global" };
  }
  const project = match(pathname, /^\/api\/plugins\/enablements\/project\/([^/]+)$/);
  if (project) {
    return { type: "project", id: project[0] };
  }
  const conversation = match(
    pathname,
    /^\/api\/plugins\/enablements\/conversation\/([^/]+)$/,
  );
  return conversation ? { type: "conversation", id: conversation[0] } : null;
}

function pluginScopeExists(repositories: Repositories, scope: PluginScope): boolean {
  if (scope.type === "global") {
    return true;
  }
  return scope.type === "project"
    ? repositories.getProject(scope.id) !== null
    : repositories.getConversation(scope.id) !== null;
}

function resolveConversationPlugins(
  options: ApiServerOptions,
  conversation: { id: string; projectId: string; agentProductId: AgentProductId },
): PluginVersion[] {
  return options.resolvePluginVersions?.({
    projectId: conversation.projectId,
    conversationId: conversation.id,
    agentProductId: conversation.agentProductId,
  }) ?? options.repositories.resolvePluginVersions(conversation.projectId, conversation.id);
}

async function validateConversationCatalog(
  options: ApiServerOptions,
  input: AgentCatalogProviderInput & {
    modelId: string | null;
    permissionMode?: import("../shared/contracts.js").PermissionMode;
  },
): Promise<import("../shared/contracts.js").PermissionMode> {
  if (!options.repositories.isAgentEnabled(input.agentProductId)) {
    throw new InputError(409, "agent_disabled", "This Agent is disabled");
  }
  if (!options.catalogProvider) {
    throw new InputError(501, "catalog_unsupported", "Catalog capability is not available");
  }
  const catalog = await options.catalogProvider(input);
  if (input.modelId !== null && !catalog.models.includes(input.modelId)) {
    throw new InputError(400, "unsupported_model", "Model is not supported by this Agent Product");
  }
  const permissionMode = input.permissionMode ?? catalog.permissionModes[0];
  if (!permissionMode || !catalog.permissionModes.includes(permissionMode)) {
    throw new InputError(
      400,
      "unsupported_permission_mode",
      "Permission mode is not supported by this Agent Product",
    );
  }
  return permissionMode;
}

function isUncommittedTerminalEvent(
  repositories: Repositories,
  event: { type: string; payload: Record<string, unknown> },
): boolean {
  if (event.type !== "turn_status") {
    return false;
  }
  const status = event.payload.status;
  if (
    status !== "completed" &&
    status !== "cancelled" &&
    status !== "start_failed" &&
    status !== "failed" &&
    status !== "interrupted" &&
    status !== "cancel_failed"
  ) {
    return false;
  }
  const turnId = event.payload.turnId;
  if (typeof turnId !== "string") {
    return false;
  }
  const turn = repositories.getTurn(turnId);
  return turn?.status === "starting" || turn?.status === "running" || turn?.status === "cancelling";
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError(message);
  return value as Record<string, unknown>;
}

function parseGraphWrite(value: unknown, complete: boolean): Partial<Omit<CreateGraphInput, "projectId">> {
  const body = readRecord(value, "Invalid graph payload");
  const patch: Partial<Omit<CreateGraphInput, "projectId">> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) throw new ValidationError("name must be a non-empty string");
    patch.name = body.name.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") throw new ValidationError("description must be a string");
    patch.description = body.description;
  }
  if (body.definition !== undefined) {
    const errors = validateGraphDefinition(body.definition);
    if (errors.length) throw new ValidationError(errors.join("; "));
    patch.definition = body.definition as GraphDefinition;
  }
  if (body.viewport !== undefined) {
    const viewport = readRecord(body.viewport, "viewport must be an object");
    if (![viewport.x, viewport.y, viewport.zoom].every((item) => typeof item === "number" && Number.isFinite(item)) || (viewport.zoom as number) <= 0) throw new ValidationError("viewport requires finite x, y, and positive zoom");
    patch.viewport = viewport as unknown as CreateGraphInput["viewport"];
  }
  if (body.positions !== undefined) {
    const positions = readRecord(body.positions, "positions must be an object");
    for (const [nodeId, rawPosition] of Object.entries(positions)) {
      const position = readRecord(rawPosition, `position for ${nodeId} must be an object`);
      if (![position.x, position.y].every((item) => typeof item === "number" && Number.isFinite(item))) throw new ValidationError(`position for ${nodeId} requires finite x and y`);
    }
    patch.positions = positions as CreateGraphInput["positions"];
  }
  if (complete && (!patch.name || !patch.definition || !patch.viewport || !patch.positions)) {
    throw new ValidationError("name, definition, viewport, and positions are required");
  }
  return patch;
}
