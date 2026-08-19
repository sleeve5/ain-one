# Ain One Product and Architecture Design

- Status: Approved design baseline, pending written-spec review
- Date: 2026-08-19
- Scope: Phase 1 chat platform and shared plugin management; Phase 2 graph integration boundary

## 1. Product Definition

Ain One is a local coding platform that combines three product directions without copying their full implementations:

- Paseo is a reference for the three-column interface, native Agent session boundary, and normalized event stream.
- DSH is a reference for settings, model discovery, redacted credential handling, and configuration usability.
- ChatDev supplies the Python graph orchestration runtime in Phase 2.

The central product decision is that an **Agent Product** is not merely a model API provider. It is software installed and authenticated on the user's machine, such as Codex, Claude Code, Trae, or OpenCode. Ain One invokes the software through its supported CLI, SDK, App Server, server API, or ACP interface and uses the complete native Agent capability.

Ain One does not implement another Agent Harness. The Agent Product remains responsible for its own agent loop, context management, model requests, tools, shell execution, file modification, native approvals, Skills, MCP execution, and durable native session data.

## 2. Goals

### Phase 1

1. Open a local directory as a Project.
2. Create multiple concurrent Conversations under a Project.
3. Choose an Agent Product and model when creating a Conversation.
4. Keep the Agent Product fixed for the lifetime of a Conversation.
5. Allow model, permission mode, and plugin selection changes only between Turns.
6. Queue messages sent during an active Turn and dispatch them in FIFO order.
7. Connect to Codex, Claude Code, Trae, and OpenCode through their supported runtime interfaces.
8. Provide a shared plugin hub for compatible Skills and MCP servers.
9. Preserve Conversations, queues, events, settings, and native session references across restarts.
10. Deliver a usable Conversation Canvas while keeping a mounted Graph Canvas placeholder.

### Phase 2

1. Integrate the existing ChatDev Python Graph Runtime through an adapter.
2. Build, run, observe, cancel, and recover graph runs in the Graph Canvas.
3. Delegate every Agent node to an installed Agent Product instead of ChatDev's own LLM harness.
4. Support ChatDev's DAG, parallel, cycle, and node failure behavior without merging the Python runtime into the TypeScript control plane.

## 3. Non-goals

The following are intentionally excluded:

- Reimplementing Codex, Claude Code, Trae, or OpenCode agent loops.
- Calling model APIs directly as a replacement for an Agent Product.
- Copying the full Paseo AGPL daemon or its provider implementations.
- Automating Desktop or IDE user interfaces to drive Agent execution.
- Automatically translating an incompatible Skill into another Agent's format.
- Building an online plugin marketplace, automatic plugin upgrades, or plugin publishing in Phase 1.
- Sharing a normal Conversation's native session with a Graph Run.
- Adding an embedded source-code editor in Phase 1.
- Implementing the Graph editor or Graph Runtime in Phase 1.
- Supporting Workspace or Worktree as first-class Ain One concepts in Phase 1.

Phase 1 is validated on macOS, the current target environment. Connector and persistence boundaries must not hard-code macOS paths where a platform-neutral representation is practical, but Windows and Linux are not Phase 1 acceptance targets.

## 4. Terminology

- **Project**: One local directory selected by the user.
- **Agent Product**: Installed software that supplies complete Agent behavior, for example Codex or Claude Code.
- **Connector**: Ain One's adapter to one Agent Product's supported machine interface.
- **Native Session**: A durable conversation/session owned by an Agent Product.
- **Conversation**: Ain One's user-facing chat container, bound to one Agent Product and normally one Native Session.
- **Turn**: One dispatched user message and the resulting Agent execution.
- **Queued Message**: A user message waiting for the current Turn to reach a safe terminal state.
- **Plugin**: A Skill or MCP server managed by the Shared Plugin Hub.
- **Materialization**: Writing a compatible plugin version into an Agent Product's native configuration or discovery location.
- **Canvas**: The central Conversation or Graph working surface.

## 5. System Architecture

```text
Ain One Web UI
        |
        | local HTTP commands + replayable SSE events
        v
TypeScript / Node Control Plane
  |-- Project and filesystem services
  |-- Conversation, Turn, and FIFO queue coordinator
  |-- Agent Runtime Connector registry
  |     |-- Codex CLI / App Server
  |     |-- Claude Code CLI / Agent SDK or ACP
  |     |-- Trae CLI / ACP
  |     `-- OpenCode CLI / Server SDK
  |-- Shared Plugin Hub
  |-- SQLite event and metadata store
  |-- Plugin content store on filesystem
  |-- OS Keychain secret references
  `-- ChatDev Graph Adapter (Phase 2)
          |
          `-- Python Graph Runtime sidecar
```

The control plane is one local TypeScript/Node service. The Web UI issues commands over a local API and receives persisted events over SSE. Commands and events are separate so reconnecting the browser cannot repeat a Turn command. SSE is sufficient because the required live path is server-to-browser; interactive actions such as approvals, cancellation, and message submission remain ordinary commands.

The local API binds to loopback only. It uses an installation-scoped local token and validates browser origins so an unrelated web page cannot command local Agent software.

### 5.1 Control Plane Responsibilities

The control plane owns:

- Project registration and directory identity.
- Conversation metadata and lifecycle.
- Turn serialization and queued message dispatch.
- Connector lifecycle and capability discovery.
- Native Session creation, resume, cancellation, and close requests.
- Model and permission selection at Turn boundaries.
- Normalized event persistence and replay.
- Shared plugin import, versioning, compatibility, and materialization.
- UI-facing diagnostics and redacted logs.
- The Phase 2 bridge between ChatDev scheduling and Agent Runtime Connectors.

### 5.2 Agent Product Responsibilities

Each Agent Product continues to own:

- Its agent loop and context compaction.
- Model authentication and model request execution.
- Native tools, shell access, file changes, and tool results.
- Skills and MCP execution semantics.
- Native approval behavior.
- Native Session content and its durable storage.

Desktop applications and IDEs are installation, login, and configuration entry points. Ain One does not click or automate them. If an Agent Product exposes no supported CLI, SDK, App Server, server API, or ACP interface, Ain One reports it as not connectable.

## 6. Agent Runtime Connector Contract

Every Connector presents the same product-level operations while declaring unsupported capabilities explicitly:

```text
probeInstallation() -> installation, version, executable, diagnostic
probeAuthentication() -> authenticated | required | unknown
fetchCatalog(projectPath) -> models, permissionModes, capabilities
createSession(config) -> nativeSessionRef
resumeSession(nativeSessionRef, config) -> liveSession
startTurn(liveSession, prompt, turnSnapshot) -> nativeTurnRef
subscribe(liveSession, emitNormalizedEvent) -> unsubscribe
respondToPermission(liveSession, requestId, decision)
cancelTurn(liveSession, nativeTurnRef)
closeSession(liveSession)
discoverPlugins(scopes) -> nativePluginCandidates
materializePlugins(targetState) -> materializationResult
```

This is an Ain One contract, not a copy of Paseo's interface. Implementations may use a subprocess, JSON-RPC, ACP, HTTP, or an official SDK internally.

Connectors must:

- Launch executables directly with argument arrays, never through interpolated shell strings.
- Preserve the Agent Product's own authentication and configuration environment.
- Return capability flags instead of pretending unsupported operations work.
- Normalize product events without discarding a redacted diagnostic payload.
- Treat native identifiers as opaque strings.
- Make resource cleanup idempotent.
- Never silently replace a lost Native Session with a new one because that would hide context loss.

### 6.1 Connector Status

The settings UI exposes these normalized states:

- `not_installed`
- `authentication_required`
- `available`
- `runtime_error`
- `version_unsupported`
- `capability_limited`

Each state includes a concise user action and expandable, redacted diagnostics. Login is performed through the Agent Product's native flow; Ain One only detects and displays the result.

### 6.2 Models and Permission Modes

The model catalog comes from the Agent Product through its Connector. Ain One may cache the latest successful catalog, but a cached entry is marked stale when probing fails.

The common permission choices are:

- **Request approval**: native approval prompts are surfaced to the user.
- **Help me approve**: enabled only when the Agent Product exposes an equivalent native assisted-review mode.
- **Full access**: enabled only when the Agent Product exposes an equivalent unrestricted mode.

Ain One maps these choices to native modes. It does not create its own approval Agent. Unsupported choices are disabled with an explanation.

## 7. Project and Conversation Model

A Project is a canonical local directory path plus display metadata. Opening the same canonical directory reuses the existing Project record.

A Project may contain multiple Conversations, and different Conversations may execute concurrently. Each Conversation has exactly one immutable `agentProductId`. The native session is created lazily on the first Turn and its opaque reference is persisted for later resume.

The Agent Product cannot change after the Conversation starts. To use another Agent Product, the user creates another Conversation. Ain One may offer a future explicit context export, but no automatic cross-product session migration is part of this design.

The model may change within the same Conversation only while no Turn is active. The selected model, permission mode, and enabled plugin versions are resolved again when a queued message is dispatched and are then frozen in that Turn's snapshot.

If the Connector cannot apply a changed configuration to an existing native session, it may restart its transport and resume the same Native Session. If safe resume is impossible, it blocks dispatch and explains that a new Conversation is required. It must not silently discard native context.

## 8. Turn and Queue State Machine

Each Conversation has at most one active Turn.

```text
queued message
      |
      v
   starting ---- definite rejection --> start_failed --> message returns to pending
      |
      +---- outcome unknown ---------> interrupted --> queue paused
      |
      v
   running ---- completion ----------> completed
      |                                  |
      |                                  `--> dispatch next FIFO message
      |
      +---- cancel requested ---------> cancelling
      |                                  |-- confirmed --> cancelled --> dispatch next
      |                                  `-- uncertain --> cancel_failed --> queue paused
      |
      +---- controlled runtime error --> failed -------> queue paused
      `---- process/control loss ------> interrupted --> queue paused
```

### 8.1 Message Submission

- If the Conversation is idle, submitting a message creates a queue entry and immediately attempts dispatch.
- If a Turn is active, each submitted message becomes a separate FIFO queue entry.
- Mid-Turn steering or message insertion is not supported in Phase 1, even when a native runtime offers it.
- Pending messages are visible and may be deleted individually before dispatch.
- Deleting a pending message never changes the active Turn.

### 8.2 Dispatch Rules

Dispatch is transactional:

1. Confirm there is no active Turn for the Conversation.
2. Resolve current model, permission mode, and compatible plugin versions.
3. Ensure plugin materialization is valid for the target Agent Product.
4. Create or resume the Native Session without starting work.
5. In one SQLite transaction, claim the oldest pending queue entry, create a durable `starting` Turn, bind the message, and persist the immutable Turn snapshot.
6. Start the native Turn with an Ain One dispatch ID when the native protocol supports client metadata or idempotency keys.
7. On native start acknowledgement, persist the native Turn reference, move the Turn to `running`, and mark the queue entry consumed.

If the Connector definitively rejects start and guarantees that no native execution began, Ain One marks the Turn `start_failed` and returns the queue entry to pending. The failure is recorded and automatic dispatch pauses until the cause is resolved or the user retries.

If the process or control connection is lost before Ain One can determine whether start succeeded, the Turn becomes `interrupted` and remains bound to the message. The queue pauses and Ain One never sends that message automatically again. The user may inspect native history and explicitly retry it as a new Turn.

Only `completed` and confirmed `cancelled` Turns automatically release the next FIFO message. `failed`, `interrupted`, and `cancel_failed` preserve the queue but pause it to avoid duplicate shell commands or file edits.

### 8.3 Model, Permission, and Plugin Changes

Selectors are disabled while a Turn is active. Changes made after a Turn ends affect only the next dispatched Turn. Historical Turn snapshots never change.

### 8.4 Cancellation

Stopping a Turn does not clear pending messages. Ain One enters `cancelling`, asks the Connector to stop the native Turn, and waits for confirmation. It cannot dispatch another message while native execution may still be active.

After confirmed cancellation, the next queued message dispatches automatically. If cancellation cannot be confirmed, the state becomes `cancel_failed`; the user receives diagnostics and the queue remains paused.

## 9. Normalized Event Stream

Connectors translate native output into a small shared event vocabulary:

- user and assistant message deltas/finals
- reasoning or progress deltas when exposed
- tool or shell start/update/result
- file change summary
- permission request and resolution
- usage information
- provider notice or warning
- Turn terminal status

Each Conversation has a monotonically increasing event sequence. Events are committed to SQLite before being broadcast. The browser reconnects with its last sequence and receives missed events, so UI disconnection does not affect native execution.

When a native event ID exists, the Connector provides a stable deduplication key. Ain One enforces uniqueness for that Native Session and event key. Products without stable IDs still receive local sequence protection, but the Connector must not claim replay deduplication it cannot guarantee.

The normalized payload drives the UI. A redacted native diagnostic payload may also be retained for troubleshooting but is never treated as a stable application contract.

## 10. Shared Plugin Hub

The Shared Plugin Hub provides one management surface for Skills and MCP servers while preserving each Agent Product's native execution semantics.

### 10.1 Supported Sources

Phase 1 supports:

- Installing a local plugin directory or archive through Ain One.
- Registering an MCP server configuration through Ain One.
- Discovering plugins already installed in supported Agent Product user or Project locations.

Online marketplaces, remote search, automatic upgrades, and publishing are deferred.

### 10.2 Canonical Repository

After installation or first native discovery, Ain One stores a canonical immutable plugin version in its own filesystem repository. Metadata in SQLite records:

- plugin ID, type, name, and version
- content hash
- source Agent Product and source path, if imported
- compatible Agent Products
- supported scopes
- configuration schema and secret references
- target-specific payload variants, when supplied by the plugin

One plugin version may contain a genuinely portable payload or explicit payloads for individual Agent Products. Ain One does not synthesize or rewrite variants.

### 10.3 Compatibility

Compatibility is explicit and version-specific. A Connector may validate whether a declared payload can be materialized for its Agent Product.

- Compatible: the version can be enabled and materialized.
- Incompatible: it is not written into that Agent Product and the reason is displayed.
- Unknown: treated as incompatible until compatibility is declared or proven.

An MCP server may be shared only with Agent Products whose native interfaces support equivalent MCP configuration. Agent-specific Skills remain limited to their declared compatible products.

### 10.4 Import from Agent Products

Connectors scan supported native plugin locations at startup, on settings refresh, and after a filesystem change notification.

For each discovered item:

- A new content hash creates an import candidate.
- A hash already managed by Ain One is ignored as a synchronization echo.
- A change made in a materialized native copy becomes a candidate version; it never silently overwrites the active canonical version.
- The user reviews conflicts and chooses whether to accept the candidate.

Origin metadata and content hashes prevent Agent A to Ain One to Agent B to Ain One synchronization loops.

### 10.5 Scopes and Resolution

Plugins can be enabled at three scopes:

1. Global defaults.
2. Project overrides.
3. Conversation overrides.

The narrower scope wins. A Turn snapshot records the final plugin IDs, versions, configurations, and secret reference revisions used for dispatch.

### 10.6 Materialization Safety

Each Connector renders only known compatible payloads into its Agent Product's native form. Materialization must be atomic and must preserve unrelated native configuration.

Ain One only updates or removes entries it has previously registered as managed. If an unmanaged native entry occupies the same identity or path, materialization stops with a conflict instead of overwriting it.

If an Agent Product only loads Skills or MCP configuration at process start, the Connector may restart its transport and resume the same Native Session between Turns. It cannot restart or mutate configuration during an active Turn.

### 10.7 Secrets

Agent Product login credentials remain owned by the Agent Product. MCP and plugin secrets entered through Ain One are write-only and stored in the OS Keychain. SQLite stores only an opaque secret reference and redacted descriptor.

Secrets are injected only into the target plugin process or native configuration mechanism that requires them. They are excluded from event payloads, logs, exported plugin packages, and diagnostics.

## 11. Settings Experience

Settings has two Phase 1 sections.

### 11.1 Agent Products

Each Agent card shows:

- installation and supported-version status
- resolved executable or endpoint
- native login status and login/open-product action
- model catalog and default model
- available permission modes
- runtime diagnostics
- plugin discovery and materialization status

The user may override an executable path or endpoint. Ain One validates it before saving and never stores model-provider API keys merely to bypass the Agent Product's native authentication.

### 11.2 Plugins

The plugin settings page supports:

- local install and native import review
- versions and source history
- compatibility matrix
- global and Project enablement
- configuration and write-only secret fields
- per-Agent materialization status and repair action
- conflict and candidate-version review

## 12. Persistence and Recovery

### 12.1 Storage Boundaries

- SQLite stores structured product state and the append-only event log.
- The filesystem stores immutable plugin version content and non-secret generated artifacts.
- The OS Keychain stores Ain One-managed plugin secrets.
- Agent Products retain their own native session history and credentials.

SQLite uses transactional constraints to enforce one active Turn per Conversation and one dispatch claim per queue entry.

### 12.2 Core Records

The conceptual data model contains:

- `projects`
- `conversations`
- `native_sessions`
- `queued_messages`
- `turns`
- `turn_snapshots`
- `events`
- `agent_installations`
- `agent_catalog_snapshots`
- `plugins`
- `plugin_versions`
- `plugin_enablements`
- `plugin_materializations`
- `secret_refs`

Phase 2 adds graph definitions, graph runs, node runs, node session bindings, and graph events without changing Conversation or Connector ownership.

### 12.3 Startup Recovery

On control-plane startup:

1. Mark any locally `starting`, `running`, or `cancelling` Turn as `interrupted`.
2. Ask the Connector to inspect or stop any possibly active native execution when supported.
3. Preserve the Native Session reference, all events, and every pending queue entry.
4. Block new dispatch until native execution is confirmed inactive.
5. Resume the durable Native Session only after the user chooses to continue.

Ain One does not automatically retry an interrupted Turn. Manual retry creates a new Turn and retains the interrupted Turn as history.

If the native session no longer exists, the Conversation enters a recoverable error state. Ain One offers creation of a new Conversation but does not silently substitute a blank Native Session.

## 13. User Interface

The Phase 1 interface follows Paseo's broad three-column composition without copying its implementation.

### 13.1 Left Column

- Project list and open-directory action.
- Conversation list grouped by Project.
- Agent Product indicator and current status.
- Running, queued, failed, and interrupted badges.
- New Conversation flow with Agent Product and model selection.

### 13.2 Center Column

The center contains Conversation Canvas and Graph Canvas under one toolbar toggle.

Both Canvas components remain mounted for the lifetime of the Project view. Switching uses visibility and interaction state rather than conditional unmounting. Each Canvas retains its own scroll position, draft, selection, and viewport state.

Conversation Canvas includes:

- normalized message and activity timeline
- tool, shell, file-change, and permission events
- composer and attachment support exposed by the Connector
- model selector, permission-mode button, and plugin summary
- Stop action
- visible FIFO pending-message list with per-item deletion

During an active Turn, model, permission, and plugin controls are disabled. Sending remains enabled and clearly indicates that the message will be queued.

Graph Canvas is a mounted placeholder in Phase 1. It preserves its future viewport state but cannot edit or run graphs.

### 13.3 Right Column

- Project file tree.
- Read-only file preview.
- Git status and diff view.

No embedded source editor is included. File changes are made by the selected Agent Product or an external editor.

## 14. Error Handling

Errors are normalized for user action while retaining redacted native diagnostics. Important error classes include:

- Agent not installed or not authenticated.
- Unsupported Agent version or capability.
- Native Session missing or not resumable.
- Turn start rejected.
- Turn start outcome unknown.
- Active Turn failed or control connection interrupted.
- Cancellation not confirmed.
- Model unavailable.
- Plugin incompatible, conflicted, or not materialized.
- Plugin secret or configuration missing.
- Project path inaccessible.

No running Turn is automatically retried because shell commands and file modifications may already have occurred. A manual retry always creates a new Turn.

One Connector, plugin, Conversation, or Graph node failure must not crash the control plane. Process supervision records exit code and stderr location, applies log redaction, and releases resources idempotently.

## 15. Phase 2 Graph Integration

ChatDev remains a Python sidecar and owns graph definition validation and graph scheduling. Ain One does not port its DAG, parallel, cycle, majority-vote, or failure-strategy implementation to TypeScript.

The integration replaces ChatDev Agent-node execution with an Ain One gateway:

```text
Graph Canvas -> TypeScript Control Plane -> ChatDev Graph Runtime
                                           |
                                           | execute Agent node
                                           v
                                  Ain One Agent Gateway
                                           |
                                           v
                                  Agent Runtime Connector
```

For each Graph Run:

- Every Agent node is bound to a configured Agent Product, model, permission mode, and plugin set before the Run starts.
- The first execution of a node creates a dedicated Native Session.
- Re-entering the same node during a cycle reuses that node's Native Session.
- Different nodes do not share Native Sessions unless a future graph feature explicitly models that relationship.
- Different Graph Runs never reuse Native Sessions.
- Normal Conversations and Graph Runs never share Native Sessions in Phase 2.
- Run-time changes to Agent Product, model, permission mode, or plugin set are rejected.

ChatDev passes node input to the gateway and receives normalized output or a typed failure. Ain One persists Graph Run and node state and relays events to the Graph Canvas. Node failure behavior is selected from ChatDev's supported graph policies rather than invented by the Connector layer.

## 16. Testing Strategy

### 16.1 Unit Tests

- Conversation and Turn state transitions.
- One-active-Turn invariant.
- FIFO queue claiming, deletion, pause, and automatic dispatch.
- Immutable Agent Product binding.
- Between-Turn model and permission changes.
- Turn snapshot resolution.
- Plugin compatibility, scope precedence, hash import, and conflict rules.
- Secret redaction.

### 16.2 Connector Contract Tests

Each Connector runs the same contract suite against a fake process, protocol fixture, or SDK double:

- installation and authentication probing
- catalog and capability discovery
- session create and resume
- Turn start acknowledgement
- streaming event normalization
- permission response
- cancellation confirmation and uncertainty
- native failure mapping
- plugin discovery and safe materialization
- idempotent close

Recorded native event fixtures may be used as behavioral evidence, but Ain One tests do not copy the reference project's implementation.

### 16.3 Integration Tests

Use a temporary Project, real SQLite database, filesystem plugin store, fake Keychain adapter, and fake Agent Runtime to cover:

- browser event replay after disconnect
- process crash and startup recovery
- event deduplication
- definite Turn start rejection returning the message to pending
- control loss during Turn start preventing automatic resend
- failed or interrupted Turn pausing the queue
- cancellation failure blocking the next Turn
- plugin native import, synchronization-loop prevention, and conflict handling
- atomic materialization that preserves unmanaged native entries

### 16.4 UI Tests

- Open Project and create Conversation.
- Lock Agent Product after first Turn.
- Queue messages during a Turn and delete a pending item.
- Disable configuration controls while active.
- Show approval requests and normalized errors.
- Toggle Canvas with one control without losing draft, scroll, selection, or viewport state.
- Display file tree, read-only preview, and Git diff.

### 16.5 Local Acceptance

For each installed and authenticated Agent Product, run a minimal real Conversation that proves create/resume, one tool or shell event, cancellation where supported, and a second Turn. Account credentials never enter CI.

Tests explicitly do not validate model quality, native Agent reasoning, native tool correctness, or an Agent Product's internal Skills/MCP executor.

## 17. Security and Trust Boundaries

- The control API is loopback-only and protected against cross-origin local-service attacks.
- Project paths are canonicalized and validated before use.
- Connector commands use direct process spawning with explicit argument arrays.
- Agent Product credentials remain in their native stores.
- Ain One-managed plugin secrets remain in the OS Keychain and are redacted everywhere else.
- Plugin packages are untrusted behavior extensions; installation and newly imported versions require explicit user acceptance before activation.
- Materialization never overwrites unmanaged native files or configuration entries.
- Full access is never emulated. It is selectable only when the Agent Product exposes the native capability and the user chooses it.

## 18. Delivery Phases

### Phase 1 Acceptance

Phase 1 is complete when:

1. A user can open a local Project and manage multiple Conversations.
2. Codex, Claude Code, Trae, and OpenCode Connectors report truthful availability and can run a minimal Conversation when their required local software is supported and configured.
3. A Conversation permanently retains its Agent Product while allowing model changes between Turns.
4. Messages sent during a Turn queue and dispatch in FIFO order after safe completion or confirmed cancellation.
5. Restart recovery preserves history and pending messages without automatically retrying work.
6. Compatible Skills and MCP configurations can be installed or imported once, managed by Ain One, and materialized to supported Agent Products without overwriting unmanaged configuration.
7. Both canvases stay mounted and preserve independent state while Conversation Canvas is usable and Graph Canvas is a placeholder.
8. The three-column file and Git inspection experience works without an embedded editor.
9. Unit, contract, integration, UI, build, and local Agent acceptance checks pass with traceable evidence.

### Phase 2 Acceptance

Phase 2 is complete when:

1. The Graph Canvas can edit and run a supported ChatDev graph.
2. Graph Agent nodes execute through Agent Runtime Connectors rather than a new Ain One or ChatDev model harness.
3. Node Native Sessions are reused within cycles of one Run and isolated across Runs.
4. DAG, parallel, cycle, cancellation, node failure policy, event replay, and recovery behaviors are covered by integration tests.

## 19. Reference Boundaries

The following local sources were inspected only as behavioral and interface references:

- Paseo Agent session contract: `packages/server/src/server/agent/agent-sdk-types.ts`
- Paseo Codex App Server connector: `packages/server/src/server/agent/providers/codex-app-server-agent.ts`
- Paseo Trae ACP connector: `packages/server/src/server/agent/providers/trae-acp-agent.ts`
- Paseo OpenCode connector: `packages/server/src/server/agent/providers/opencode-agent.ts`
- DSH provider/model settings guide: `docs/user/guide/providers.md`
- ChatDev graph executor: `workflow/graph.py`
- ChatDev Python SDK: `runtime/sdk.py`

These references define expected behavior and useful boundaries. Ain One will implement its own minimum contracts and will not copy the full Paseo daemon or provider code.
