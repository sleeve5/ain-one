# Ain One

Ain One is a local, project-first coding workspace for using installed Agent Products through one conversation UI. Phase 1 focuses on durable chat sessions, FIFO Turn coordination, Agent/model settings, compatible Skills and MCP management, and read-only project inspection. It uses each Agent Product's native harness and authentication rather than calling model-provider APIs directly.

The current target is developers on macOS who already use Codex, Claude Code, or Trae CLI locally and want one place to manage project conversations without moving native session ownership into another harness.

## Prerequisites

- macOS
- Node.js 24 or newer
- pnpm
- Microsoft Edge for `pnpm test:e2e`
- At least one supported local Agent Product installed and authenticated

Default executable names are `codex`, `claude`, and `traecli`. Agent Settings can override each executable with a canonical local path. An OpenCode adapter remains in the backend codebase for later activation, but Phase 1 does not expose OpenCode in the Web UI.

## Quick Start

```bash
pnpm install
pnpm dev
```

Open the Vite URL shown in the terminal, normally `http://127.0.0.1:5173`. The development command starts both the Web UI and the local control plane.

Useful checks:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e
```

## Data and Configuration

Ain One stores local state in `~/.ain-one` by default:

- `ain-one.sqlite`: Projects, Conversations, Turns, queues, events, settings, and native session references
- `install.token`: installation bearer token, created with `0600` permissions
- `plugins/`: immutable canonical plugin versions
- `materialized/`: Ain One-managed Skill copies linked into supported Agent locations
- `turn-artifacts/`: per-Turn MCP configuration artifacts

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AIN_ONE_DATA_DIR` | `~/.ain-one` | Local state and plugin repository |
| `AIN_ONE_HOST` | `127.0.0.1` | Control-plane bind host; it must remain loopback |
| `AIN_ONE_PORT` | `6469` | Control-plane port |
| `AIN_ONE_WEB_PORT` | `5173` | Vite development UI port |
| `AIN_ONE_TOKEN` | persisted install token | Explicit development or test token override |

## Using Ain One

1. Enter a local directory in **Project path** and choose **Open Project**.
2. Select an available Agent Product and one of its reported models, then create a Conversation.
3. Send messages from Conversation Canvas. The Agent Product is fixed for the lifetime of that Conversation; create another Conversation to use a different product.
4. Change the model, permission mode, or compatible plugin versions only while no Turn is active. Each Turn persists the exact settings snapshot used for dispatch.
5. Use the Inspector for the Project file tree, read-only previews, Git status, and Git diff.

Agent Settings reports installation, authentication, version, diagnostics, models, and supported permission modes. Ain One relies on the Agent Product's own login state; model-provider API keys are not an Ain One requirement.

## Turn and Queue Semantics

Each Conversation runs at most one Turn at a time. Messages submitted during an active Turn are stored as separate FIFO queue entries; Ain One does not insert or steer messages mid-Turn.

Only a completed Turn or a confirmed cancellation automatically releases the next queued message. Start failures, runtime failures, interrupted work, and uncertain cancellation pause the queue. Ain One never automatically retries uncertain work because doing so could repeat shell commands or file changes.

When a queue is paused, **Continue pending queue** skips replaying the terminal Turn and attempts the existing pending messages. **Retry interrupted Turn** creates a new queue entry for the interrupted message before the existing pending queue. Before using either action after `interrupted` or `cancel_failed`, confirm in the native Agent Product that the previous work is no longer active. Phase 1 cannot reconnect to an orphaned CLI process after a hard crash, so this confirmation is manual.

## Skills and MCP

Plugin Settings can install a local plugin path or accept a discovered native candidate. Ain One stores immutable versions and enables exact versions at Global, Project, or Conversation scope. Precedence is:

```text
Global < Project < Conversation
```

Compatibility must be declared explicitly for each Agent Product. Ain One does not rewrite or convert incompatible Skill or MCP formats. Agent-native installations may be discovered and imported into the shared repository, but a new candidate requires explicit acceptance before Ain One manages it.

Plugin Settings shows per-Agent Skill materialization status. A safe missing or outdated managed copy can be repaired; conflicts are reported and never overwritten. MCP configuration is generated per Turn rather than installed globally. Codex and Trae receive native `mcp_servers` overrides; Claude Code receives a strict native `--mcp-config`.

MCP definitions reject raw secret-like values and accept opaque `secretRef` entries at the storage boundary. The default Phase 1 server composition and Web UI do not yet create, resolve, or inject those references, so MCP configurations requiring secrets are not currently dispatchable through the default UI.

## Security Boundary

- The control plane binds to loopback and rejects non-loopback hosts.
- API commands require an installation-scoped bearer token and validate browser origins.
- Agent and Git commands are spawned directly with argument arrays and `shell: false`.
- Project paths and file requests are canonicalized and constrained to the selected Project.
- Connector diagnostics and normalized events redact common credential patterns.
- Installed Skills and MCP servers are executable extensions. Review their source and compatibility declarations before accepting or enabling them.

## Canvases

Conversation Canvas and Graph Canvas remain mounted while switching, so drafts and each canvas's local state are preserved. Conversation Canvas is usable in Phase 1. Graph Canvas is intentionally a placeholder and cannot edit or run graphs yet.

Phase 2 will add an adapter for the Python Graph Runtime in `/Users/bytedance/Documents/ChatGPT/chatdev`. Normal Conversations and Graph Runs will keep separate native sessions.

## Phase 1 Limits

- macOS is the only acceptance target.
- Interactive permission replies are not supported by the current non-interactive Codex, Claude Code, and Trae connector modes.
- OpenCode is deferred and is not exposed in the Phase 1 Web UI, although its backend adapter is retained for later activation.
- There is no embedded source editor, graph editor/runtime, online plugin marketplace, automatic plugin upgrade, or automatic cross-Agent session migration.
- Plugin compatibility is explicit; undeclared or incompatible formats remain unavailable rather than being transformed.
