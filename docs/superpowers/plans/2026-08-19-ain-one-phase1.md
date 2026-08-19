# Ain One Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 1 local Ain One coding platform with Projects, persistent multi-Agent Conversations, FIFO Turns, native Agent Product connectors, shared Skills/MCP management, and the mounted dual-canvas Web UI.

**Architecture:** A single TypeScript repository contains a Node 24 loopback control plane, a React/Vite Web UI, and shared wire/domain types. The server uses `node:sqlite`, `node:http`, and direct child-process spawning; Agent Products keep their own harness and sessions. Phase 2 is represented only by the mounted Graph Canvas and the Connector boundaries it will reuse.

**Tech Stack:** Node.js 24, TypeScript 5.9, React 19, Vite 7, Vitest 4, Testing Library, Playwright with Microsoft Edge, Node built-in SQLite/HTTP/testable child processes.

## Global Constraints

- Phase 1 acceptance target is macOS; do not hard-code macOS paths where a platform-neutral representation is practical.
- Do not start or restart Paseo's `6767` daemon.
- Do not copy Paseo provider implementations or build a new Agent Harness.
- Bind the Ain One API to loopback only and require an installation-scoped bearer token plus origin validation.
- Spawn Agent executables directly with argument arrays; never interpolate commands through a shell.
- A Conversation's Agent Product is immutable after creation.
- Model, permission mode, and plugin changes apply only between Turns.
- Each Conversation has at most one active Turn; messages submitted during a Turn are FIFO queued.
- Only completed and confirmed-cancelled Turns release the next queued message automatically.
- Never automatically retry failed, interrupted, or uncertain work.
- Both Conversation Canvas and Graph Canvas remain mounted while switching visibility.
- Plugin compatibility is explicit; incompatible or unknown plugins are not transformed or materialized.
- Never overwrite unmanaged native plugin/configuration entries.
- Do not commit temporary reports, screenshots, or generated local data.

---

## File Map

```text
package.json                         workspace scripts and dependency pins
tsconfig.json                       shared TypeScript compiler settings
vite.config.ts                      Web build and development proxy
vitest.config.ts                    Node and jsdom test projects
playwright.config.ts                Microsoft Edge-only browser acceptance
src/shared/contracts.ts             domain, connector, API, event, plugin types
src/shared/validation.ts            trust-boundary parsers
src/server/config.ts                data paths, token, loopback settings
src/server/db.ts                    SQLite schema and transactions
src/server/repositories.ts          Project/Conversation/Turn/event persistence
src/server/turn-coordinator.ts      FIFO dispatch and recovery state machine
src/server/connectors/base.ts       Connector contract and process helpers
src/server/connectors/cli-jsonl.ts  common Codex/Trae JSONL session runtime
src/server/connectors/codex.ts      Codex probing/catalog/command mapping
src/server/connectors/claude.ts     Claude stream-json runtime
src/server/connectors/trae.ts       Trae probing/catalog/command mapping
src/server/connectors/opencode.ts   OpenCode availability and SDK runtime
src/server/connectors/registry.ts   Connector registry
src/server/plugins.ts               canonical plugin store/import/materialize
src/server/files.ts                 safe file tree, preview, and Git diff
src/server/api.ts                   loopback HTTP commands and SSE replay
src/server/main.ts                  composition root and shutdown
src/web/main.tsx                    React entry
src/web/app.tsx                     three-column application shell
src/web/api.ts                      authenticated HTTP/SSE client
src/web/store.ts                    client state and event reducer
src/web/components/*                project, conversation, canvases, settings
src/web/styles.css                  responsive visual system
tests/server/*                      state, connector, plugin, API tests
tests/web/*                         React behavior tests
tests/e2e/phase1.spec.ts            Microsoft Edge acceptance flow
```

### Task 1: Repository Skeleton and Shared Contracts

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `index.html`
- Create: `src/shared/contracts.ts`, `src/shared/validation.ts`
- Test: `tests/shared/validation.test.ts`

**Interfaces:**
- Produces: `AgentProductId`, `PermissionMode`, `Conversation`, `Turn`, `QueuedMessage`, `NormalizedEvent`, `AgentConnector`, `PluginVersion`, and API request parsers used by all later tasks.

- [ ] **Step 1: Write the failing validation tests**

```ts
import { describe, expect, it } from "vitest";
import { parseCreateConversation, parseQueueMessage } from "../../src/shared/validation.js";

describe("API validation", () => {
  it("accepts a supported Agent Product and rejects an unknown product", () => {
    expect(parseCreateConversation({ projectId: "p1", agentProductId: "codex", modelId: "gpt-5" }))
      .toMatchObject({ agentProductId: "codex" });
    expect(() => parseCreateConversation({ projectId: "p1", agentProductId: "other" }))
      .toThrow("Unsupported Agent Product");
  });

  it("rejects an empty queued message", () => {
    expect(() => parseQueueMessage({ content: "  " })).toThrow("Message cannot be empty");
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run tests/shared/validation.test.ts`
Expected: FAIL because the shared modules do not exist.

- [ ] **Step 3: Add the minimum project configuration and contracts**

Use ESM, Node `>=24`, exact scripts `dev`, `build`, `typecheck`, `test`, `test:e2e`, and dependencies React/Vite/Vitest/Testing Library/Playwright. Define:

```ts
export type AgentProductId = "codex" | "claude" | "trae" | "opencode";
export type PermissionMode = "request_approval" | "help_me_approve" | "full_access";
export type TurnStatus =
  | "starting" | "running" | "cancelling" | "completed" | "cancelled"
  | "start_failed" | "failed" | "interrupted" | "cancel_failed";

export interface TurnSnapshot {
  modelId: string | null;
  permissionMode: PermissionMode;
  pluginVersions: Array<{ pluginId: string; versionId: string }>;
}

export interface AgentConnector {
  readonly id: AgentProductId;
  probe(): Promise<AgentProbe>;
  fetchCatalog(projectPath: string): Promise<AgentCatalog>;
  createOrResumeSession(input: SessionInput): Promise<LiveSession>;
  startTurn(session: LiveSession, input: StartTurnInput): Promise<NativeTurn>;
  respondToPermission(session: LiveSession, requestId: string, decision: PermissionDecision): Promise<void>;
  cancelTurn(session: LiveSession, nativeTurnId: string | null): Promise<CancelResult>;
  closeSession(session: LiveSession): Promise<void>;
  discoverPlugins(): Promise<NativePluginCandidate[]>;
  materializePlugins(input: MaterializeInput): Promise<MaterializeResult>;
}
```

Implement small assertion helpers in `validation.ts`; do not add a schema library for these fixed request shapes.

- [ ] **Step 4: Run tests and static checks**

Run: `pnpm vitest run tests/shared/validation.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vite.config.ts vitest.config.ts playwright.config.ts index.html src/shared tests/shared
git commit -m "chore: scaffold Ain One phase one"
```

### Task 2: SQLite State and FIFO Turn Coordinator

**Files:**
- Create: `src/server/config.ts`, `src/server/db.ts`, `src/server/repositories.ts`, `src/server/turn-coordinator.ts`
- Test: `tests/server/turn-coordinator.test.ts`, `tests/server/recovery.test.ts`

**Interfaces:**
- Consumes: shared contracts from Task 1.
- Produces: `Repositories`, `TurnCoordinator.enqueueMessage()`, `dispatchNext()`, `cancelActiveTurn()`, and `recoverInterruptedTurns()`.

- [ ] **Step 1: Write failing queue and recovery tests**

```ts
it("runs one Turn at a time and dispatches queued messages in FIFO order", async () => {
  const runtime = new ControlledConnector("codex");
  const app = createTestCoordinator(runtime);
  const conversation = app.createConversation();
  await app.coordinator.enqueueMessage(conversation.id, "first");
  await app.coordinator.enqueueMessage(conversation.id, "second");
  expect(runtime.prompts).toEqual(["first"]);
  await runtime.completeActiveTurn();
  expect(runtime.prompts).toEqual(["first", "second"]);
});

it("pauses the queue after an interrupted Turn", async () => {
  const app = createTestCoordinator(new UncertainStartConnector("codex"));
  const conversation = app.createConversation();
  await app.coordinator.enqueueMessage(conversation.id, "unsafe to repeat");
  expect(app.repositories.getActiveTurn(conversation.id)?.status).toBe("interrupted");
  expect(app.repositories.listQueuedMessages(conversation.id)).toHaveLength(0);
  expect(app.repositories.getConversation(conversation.id)?.queuePaused).toBe(true);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run tests/server/turn-coordinator.test.ts tests/server/recovery.test.ts`
Expected: FAIL because persistence and coordinator modules do not exist.

- [ ] **Step 3: Implement schema and repositories**

Create SQLite tables for projects, conversations, native sessions, queued messages, turns, turn snapshots, and events. Add a partial unique index enforcing one `starting|running|cancelling` Turn per Conversation. Use `BEGIN IMMEDIATE` transactions for queue claims and sequence allocation.

Expose repository methods with these signatures:

```ts
createProject(path: string, name: string): Project;
createConversation(input: CreateConversationInput): Conversation;
enqueueMessage(conversationId: string, content: string): QueuedMessage;
claimNextMessage(conversationId: string, snapshot: TurnSnapshot): { message: QueuedMessage; turn: Turn } | null;
markTurnRunning(turnId: string, nativeTurnId: string | null): void;
finishTurn(turnId: string, status: TerminalTurnStatus, error?: NormalizedError): void;
appendEvent(conversationId: string, event: ConnectorEvent): NormalizedEvent;
eventsAfter(conversationId: string, sequence: number): NormalizedEvent[];
```

- [ ] **Step 4: Implement the coordinator state machine**

The coordinator persists `starting` before invoking a Connector. Definite start rejection returns the message to pending and pauses; unknown start outcome marks `interrupted`, binds the message to that Turn, and pauses. Completion and confirmed cancellation call `dispatchNext`; all other terminal states pause.

- [ ] **Step 5: Run focused and full tests**

Run: `pnpm vitest run tests/server/turn-coordinator.test.ts tests/server/recovery.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/config.ts src/server/db.ts src/server/repositories.ts src/server/turn-coordinator.ts tests/server
git commit -m "feat: persist conversations and FIFO turns"
```

### Task 3: Loopback HTTP API, SSE Replay, and Project Files

**Files:**
- Create: `src/server/files.ts`, `src/server/api.ts`, `src/server/main.ts`
- Test: `tests/server/api.test.ts`, `tests/server/files.test.ts`

**Interfaces:**
- Consumes: `Repositories` and `TurnCoordinator`.
- Produces: authenticated JSON API under `/api`, replayable `/api/conversations/:id/events`, and safe file/Git inspection endpoints.

- [ ] **Step 1: Write failing API security and replay tests**

```ts
it("rejects requests without the installation token", async () => {
  const response = await request(app.url, "/api/projects");
  expect(response.status).toBe(401);
});

it("replays events strictly after the supplied sequence", async () => {
  seedEvents(repository, conversation.id, ["one", "two", "three"]);
  const response = await request(app.url, `/api/conversations/${conversation.id}/events?after=1`, token);
  expect(await readSseData(response, 2)).toEqual([expect.objectContaining({ sequence: 2 }), expect.objectContaining({ sequence: 3 })]);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run tests/server/api.test.ts tests/server/files.test.ts`
Expected: FAIL because API and file services do not exist.

- [ ] **Step 3: Implement loopback API and SSE**

Use `node:http`. Reject non-loopback binding, missing/incorrect bearer tokens, and disallowed `Origin` values. Implement Projects, Conversations, queue submit/delete, permission response, Turn cancel, settings/catalog, events, plugins, file tree, preview, Git status, and Git diff routes. Serve SSE with `id: <sequence>` and heartbeat comments.

- [ ] **Step 4: Implement safe file and Git inspection**

Canonicalize requested paths with `realpath`, require containment inside the Project root, cap preview size, and invoke Git with `spawn` argument arrays and `shell: false`. Return text/binary metadata rather than embedding an editor.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run tests/server/api.test.ts tests/server/files.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/files.ts src/server/api.ts src/server/main.ts tests/server/api.test.ts tests/server/files.test.ts
git commit -m "feat: expose secure local control API"
```

### Task 4: Native Agent Product Connectors

**Files:**
- Create: `src/server/connectors/base.ts`, `src/server/connectors/cli-jsonl.ts`, `src/server/connectors/codex.ts`, `src/server/connectors/claude.ts`, `src/server/connectors/trae.ts`, `src/server/connectors/opencode.ts`, `src/server/connectors/registry.ts`
- Test: `tests/server/connectors.test.ts`, `tests/fixtures/agents/*`

**Interfaces:**
- Consumes: `AgentConnector` contract.
- Produces: a registry with IDs `codex`, `claude`, `trae`, `opencode` and normalized events for message/tool/shell/file/usage/status data.

- [ ] **Step 1: Write failing shared Connector contract tests**

```ts
for (const fixture of connectorFixtures) {
  it(`${fixture.id} probes, starts, resumes, normalizes, and cancels`, async () => {
    const connector = fixture.create();
    expect(await connector.probe()).toMatchObject({ status: "available" });
    const events: ConnectorEvent[] = [];
    const session = await connector.createOrResumeSession(fixture.sessionInput(events));
    const turn = await connector.startTurn(session, fixture.turnInput("hello"));
    await fixture.waitForExit();
    expect(turn.nativeTurnId).toBeTruthy();
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant_message" }));
    if (fixture.supportsPermissionResponse) {
      await expect(connector.respondToPermission(session, "permission-1", "allow_once")).resolves.toBeUndefined();
    }
    await expect(connector.closeSession(session)).resolves.toBeUndefined();
  });
}
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm vitest run tests/server/connectors.test.ts`
Expected: FAIL because Connector implementations do not exist.

- [ ] **Step 3: Implement process and JSONL primitives**

Implement executable lookup, version probing, direct spawn, line-delimited JSON parsing, stderr redaction, abort/kill escalation, and idempotent close. The test fixtures are executable Node scripts that emit representative native event shapes.

- [ ] **Step 4: Implement product-specific mappings**

- Codex: use `codex exec --json` and `codex exec resume <session-id> --json`; read native model cache when present; map `request_approval`, `help_me_approve`, and `full_access` to native CLI flags.
- Claude: use `claude --print --output-format stream-json --include-partial-messages`; resume with `--resume`; expose accepted model aliases and native permission modes; use a UUID session ID supplied by Ain One.
- Trae: use `traecli exec --json`, resume subcommand, and `traecli models --json`; map the three permission choices to native modes.
- OpenCode: probe the `opencode` binary and official SDK availability; when absent return `not_installed`; when present create/resume SDK sessions and consume server events.

If a native protocol cannot provide interactive permission responses in this transport, `respondToPermission` throws a typed unsupported-capability error and probing returns `capability_limited`; never emulate approval.

- [ ] **Step 5: Run contract tests and static checks**

Run: `pnpm vitest run tests/server/connectors.test.ts && pnpm typecheck`
Expected: PASS for fixture-backed contracts; local probes report the actual machine state.

- [ ] **Step 6: Commit**

```bash
git add src/server/connectors tests/server/connectors.test.ts tests/fixtures/agents
git commit -m "feat: connect native coding agents"
```

### Task 5: Shared Skills and MCP Plugin Hub

**Files:**
- Create: `src/server/plugins.ts`, `src/server/keychain.ts`
- Test: `tests/server/plugins.test.ts`, `tests/server/keychain.test.ts`

**Interfaces:**
- Produces: `PluginHub.installLocal()`, `scanNative()`, `acceptCandidate()`, `resolveForTurn()`, and `materialize()`.

- [ ] **Step 1: Write failing import, compatibility, and conflict tests**

```ts
it("imports one native Skill version and ignores its own materialized echo", async () => {
  const hub = createPluginHub();
  const first = await hub.scanNative([{ agentProductId: "claude", path: fixtureSkill }]);
  await hub.acceptCandidate(first[0].id);
  await hub.materialize("codex", [{ pluginId: first[0].pluginId, versionId: first[0].versionId }]);
  expect(await hub.scanNative([{ agentProductId: "codex", path: codexTarget }])).toEqual([]);
});

it("refuses unknown compatibility and unmanaged target conflicts", async () => {
  await expect(hub.materialize("trae", [unknownCompatibilityVersion])).rejects.toThrow("not compatible");
  await expect(hub.materialize("codex", [conflictingVersion])).rejects.toThrow("unmanaged entry");
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run tests/server/plugins.test.ts tests/server/keychain.test.ts`
Expected: FAIL because plugin services do not exist.

- [ ] **Step 3: Implement canonical immutable versions**

Copy accepted local directories into `$AIN_ONE_HOME/plugins/<plugin-id>/<content-hash>`, hash normalized relative paths and bytes, and persist source/compatibility metadata. Treat missing compatibility as incompatible. Detect Skills by `SKILL.md`; detect MCP definitions from explicit Ain One JSON input or Connector discovery.

- [ ] **Step 4: Implement safe materialization and secrets**

For Skills, atomically create managed symlinks in supported native skill directories and record every managed target. Refuse existing unmanaged paths. For MCP, render per-Turn native config files/arguments where supported; do not rewrite native global config. Store secrets through macOS `security add-generic-password`/`find-generic-password` using direct spawn and keep only opaque references in SQLite; tests use an in-memory adapter.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run tests/server/plugins.test.ts tests/server/keychain.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/plugins.ts src/server/keychain.ts tests/server/plugins.test.ts tests/server/keychain.test.ts
git commit -m "feat: share compatible skills and MCP config"
```

### Task 6: Three-Column Conversation UI and Mounted Canvases

**Files:**
- Create: `src/web/main.tsx`, `src/web/app.tsx`, `src/web/api.ts`, `src/web/store.ts`, `src/web/styles.css`
- Create: `src/web/components/project-sidebar.tsx`, `conversation-canvas.tsx`, `graph-canvas.tsx`, `inspector.tsx`, `composer.tsx`, `canvas-switch.tsx`
- Test: `tests/web/app.test.tsx`, `tests/web/canvas-state.test.tsx`

**Interfaces:**
- Consumes: HTTP/SSE API.
- Produces: Project/Conversation shell, normalized timeline, queued composer, mounted Canvas switch, and read-only inspector.

- [ ] **Step 1: Write failing mounted-canvas and queue UI tests**

```tsx
it("keeps both canvases mounted and preserves their state while switching", async () => {
  render(<App api={fakeApi()} />);
  await user.type(screen.getByLabelText("Message"), "draft text");
  await user.click(screen.getByRole("button", { name: "Graph" }));
  expect(screen.getByTestId("conversation-canvas")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Conversation" }));
  expect(screen.getByLabelText("Message")).toHaveValue("draft text");
});

it("queues a message while a Turn is active and disables Turn settings", async () => {
  render(<App api={fakeApi({ activeTurn: true })} />);
  expect(screen.getByLabelText("Model")).toBeDisabled();
  await user.type(screen.getByLabelText("Message"), "next task");
  await user.click(screen.getByRole("button", { name: "Queue message" }));
  expect(await screen.findByText("next task")).toBeVisible();
});
```

- [ ] **Step 2: Run Web tests and verify RED**

Run: `pnpm vitest run --project web tests/web/app.test.tsx tests/web/canvas-state.test.tsx`
Expected: FAIL because Web modules do not exist.

- [ ] **Step 3: Implement client state and event replay**

Load Projects/Conversations over HTTP, connect SSE using the stored sequence, reduce normalized events into the timeline, reconnect with bounded exponential delay, and never repeat command POSTs on reconnect.

- [ ] **Step 4: Implement the responsive three-column UI**

Use a warm neutral palette, expressive serif headings with a compact monospace activity face, CSS variables, subtle grid/paper background, and restrained load/reveal motion. Desktop uses three columns; narrow screens expose left/right panels as drawers. Use one Canvas switch button group. Keep both canvas DOM subtrees mounted and toggle `hidden`, `inert`, and CSS visibility.

- [ ] **Step 5: Implement Conversation and inspector behavior**

Render messages, reasoning, tools, shell, file changes, approval requests, errors, and Turn state. The composer queues during active work. Show pending messages with delete actions. Disable Agent/model/permission/plugin controls while active. Inspector shows file tree, read-only preview, Git status, and diff.

- [ ] **Step 6: Run Web tests, accessibility checks, and build**

Run: `pnpm vitest run --project web && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web tests/web index.html vite.config.ts
git commit -m "feat: add conversation workspace UI"
```

### Task 7: Agent and Plugin Settings, Recovery, and End-to-End Acceptance

**Files:**
- Create: `src/web/components/settings.tsx`, `src/web/components/plugin-settings.tsx`
- Modify: `src/web/app.tsx`, `src/server/api.ts`, `src/server/main.ts`
- Test: `tests/web/settings.test.tsx`, `tests/server/startup-recovery.test.ts`, `tests/e2e/phase1.spec.ts`
- Create: `README.md`

**Interfaces:**
- Completes the Phase 1 user flow and local run documentation.

- [ ] **Step 1: Write failing settings and startup recovery tests**

```ts
it("shows truthful Agent availability and only supported permission modes", async () => {
  render(<Settings api={fakeApi({ agents: [{ id: "opencode", status: "not_installed", modes: [] }] })} />);
  expect(await screen.findByText("OpenCode is not installed")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Full access" })).not.toBeInTheDocument();
});

it("marks active Turns interrupted on startup and preserves queued messages", async () => {
  const app = createPersistedTestApp({ activeTurn: "running", queued: ["next"] });
  await app.recover();
  expect(app.activeTurn.status).toBe("interrupted");
  expect(app.queuedMessages.map((item) => item.content)).toEqual(["next"]);
  expect(app.conversation.queuePaused).toBe(true);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run tests/web/settings.test.tsx tests/server/startup-recovery.test.ts`
Expected: FAIL because final settings/recovery behavior is missing.

- [ ] **Step 3: Implement settings and recovery UX**

Add Agent cards for installation/version/authentication/catalog/modes/path override and diagnostics. Add plugin install/import review, compatibility matrix, scopes, managed versions, and materialization status. On startup mark active Turns interrupted, inspect/stop native work when supported, preserve queues, and require explicit resume/retry.

- [ ] **Step 4: Add Microsoft Edge acceptance flow**

Configure Playwright with `channel: "msedge"`. The E2E test starts Ain One on an ephemeral loopback port with a fake Connector, opens a temporary Project, creates a Conversation, starts one Turn, queues a second message, verifies FIFO dispatch, switches canvases without losing draft/viewport markers, opens file preview/Git diff, and verifies persistence after server restart.

- [ ] **Step 5: Add user documentation**

Document prerequisites, `pnpm install`, `pnpm dev`, local data location, opening a Project, configuring Agent Products, installing/importing compatible Skills/MCP, queue semantics, security boundary, known capability limitations, and Phase 2 deferral. Do not document model-provider API keys as an Ain One requirement.

- [ ] **Step 6: Run full verification**

Run: `pnpm test && pnpm typecheck && pnpm build && pnpm test:e2e`
Expected: all commands exit 0. Local probe output must report Codex, Claude Code, and Trae according to their installed state and OpenCode as `not_installed` on the current machine.

- [ ] **Step 7: Run minimal real-Agent acceptance without modifying the repository**

Start Ain One on an ephemeral port, open a disposable temporary Project, and run a harmless prompt (`Report the current working directory without changing files`) with each installed authenticated Agent Product. Confirm a Native Session reference, normalized assistant event, terminal Turn state, and a second resumed Turn. Do not run this acceptance against an unavailable Agent.

- [ ] **Step 8: Commit**

```bash
git add src/web/components/settings.tsx src/web/components/plugin-settings.tsx src/web/app.tsx src/server/api.ts src/server/main.ts tests README.md playwright.config.ts
git commit -m "feat: complete Ain One phase one"
```

## Final Review

- [ ] Compare every Phase 1 acceptance item in `docs/superpowers/specs/2026-08-19-ain-one-design.md` to code and tests.
- [ ] Confirm no `TBD`, `TODO`, fake provider success, copied Paseo implementation, or automatic retry remains.
- [ ] Run `pnpm test && pnpm typecheck && pnpm build && pnpm test:e2e` again from a clean checkout state.
- [ ] Review the branch diff for dead abstractions, unused dependencies, generated artifacts, credentials, and out-of-scope Graph implementation.
