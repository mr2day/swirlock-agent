# swirlock-agent Manifest

`swirlock-agent` is a local autonomous coding agent shipped as a Visual Studio Code extension. The user gives it a coding task; it inspects the workspace, manages its own context window, calls a locally hosted LLM through `swirlock-llm-host`, edits files, runs commands, inspects errors, and iterates until the task is complete.

The model host is treated as an inference appliance. All cognition that is not raw token generation lives inside the extension.

## Source-of-truth boundary

The model host contract is owned by [`swirlock-chatbot-contracts`](../RAG%20engine/swirlock-chatbot-contracts/) at `docs/versions/v2/openapi/model-host.openapi.yaml`. This repository implements the **caller side** of that contract. If wire-level details disagree between this manifest and the contract, the contract wins and this manifest is wrong.

## Architecture

```
VS Code Chat (vscode.chat participant)
         ↓
   AgentLoop  ─────►  Plan  (first-class state)
         │
         ├─►  ContextManager  (priorities, eviction, token budget)
         │           │
         │           ▼
         │     PromptAssembler  →  InferenceInput.parts[]
         │           │
         │           ▼
         │     ModelHostClient  ──HTTP / WebSocket──►  swirlock-llm-host
         │           │
         │           ▼  (chunks, queue events, thinking)
         │     ChatResponseStream  →  user-facing UI
         │
         ├─►  ActionParser   (JSON action blocks from model output)
         │
         ├─►  ToolRegistry
         │       ├─ FileTools     (vscode.workspace.fs)
         │       ├─ ShellTool     (Node child_process via PathJail/CommandPolicy)
         │       ├─ GitTool       (git CLI)
         │       └─ WorkspaceTool (diagnostics, search, structure)
         │
         ├─►  SafetyLayer  (PathJail · CommandPolicy · PermissionMode · IterationCap · KillSwitch)
         │
         └─►  RunLogger    (.swirlock/runs/<turnId>.jsonl)
```

The arrow direction matters: nothing below the agent loop knows about the chat participant; nothing inside `ModelHostClient` knows about agent semantics; nothing inside `PromptAssembler` knows about HTTP. Each layer is replaceable.

## Core principles

- **Separation of concerns.** Transport, prompt assembly, context management, action parsing, tool execution, and UI are independent modules. The agent loop is the only place that orchestrates them.
- **Contract-first.** The model host is the v2 agnostic Model Host. The agent owns chat semantics, prompt assembly, and parsing — the host owns model loading, queueing, and inference.
- **Local-first.** No external services. The model is the user's own. The workspace is the user's own. No data leaves the machine.
- **Maximum autonomy by default.** No confirmation prompts during a run. Safety is enforced as guardrails (path jail, command policy, iteration cap) and as a kill switch, not as a turn-by-turn approval loop.
- **Inspectable.** Every iteration is appended to a JSONL run log. The user can replay, audit, or share runs.
- **Streaming everywhere.** WebSocket inference is the default. Queue position, thinking, and chunk events are surfaced live in the chat panel.

## Modules

### `transport/ModelHostClient`

Thin client over the v2 Model Host API. Exposes:

- `infer(request, signal)` — single-shot via `POST /v2/infer`.
- `stream(request, signal)` → `AsyncIterable<StreamEvent>` via WebSocket upgrade on `/v2/infer/stream`. Yields `accepted`, `queued`, `started`, `thinking`, `chunk`, `done`, `error`.
- `health()`, `modelStatus()`, `preload()`, `unload()`.

Owns: correlation IDs (UUIDv7), `x-correlation-id` header, the `{meta, data}` / `{meta, error}` envelopes, retry on `model_unavailable` / `upstream_unavailable`, cancellation propagation.

Knows nothing about prompts, agents, or VS Code.

### `prompt/PromptAssembler`

Takes the prioritized context entries from `ContextManager` and renders them into a single `InferenceInput.parts[]` payload. Also injects the system prompt (with the action schema embedded) and the active plan.

Renders within a token budget. Returns the final `InferRequest` body.

### `context/ContextManager`

Holds a list of `ContextEntry { id, type, content, priority, source, createdAt, tokenEstimate }`. Entry types include: `system`, `task`, `plan`, `file`, `tool_result`, `assistant`, `error`.

When the assembler asks for a budget-bounded slice, the manager returns entries sorted by priority and recency, dropping low-priority entries first. The active plan, current task, and the last N tool results are pinned high-priority.

### `agent/Plan`

First-class object, not a context entry. The model updates it via `update_plan` actions. The latest version is always re-injected at the top of each iteration.

### `agent/actions`

The model emits actions as fenced ` ```action ` JSON blocks inside its text response. The parser extracts every block, validates each against a TypeScript-derived JSON schema, and yields a typed `Action` array. Validation errors become `tool_result` entries — the model self-corrects on the next iteration.

Action set:

- `read_file { path }`
- `write_file { path, content }`
- `edit_file { path, oldString, newString }`
- `list_dir { path }`
- `search { query, glob? }`
- `run_command { command, cwd?, timeoutMs? }`
- `git { args[] }`
- `update_plan { plan }`
- `finish { summary }`

`finish` terminates the loop. Anything else continues it.

### `tools/*`

Each tool is a deterministic function from `(args, ctx) → ToolResult`. Tools never call the LLM. File operations go through `vscode.workspace.fs` so the agent works in remote workspaces. Shell commands go through Node `child_process.spawn`.

### `safety/*`

- **PathJail** — every read/write resolves under the workspace root. Symlink escape is rejected.
- **CommandPolicy** — allow/deny lists of regex patterns matched against the command string. Defaults are conservative; bypass mode disables them.
- **PermissionMode** — `normal` enforces all guardrails; `bypass` enforces only the iteration cap and the kill switch. Toggleable from the status bar (analogous to Claude Code's bypass-permissions mode). Persists in workspace state.
- **IterationCap** — hard maximum loop iterations per task. Always enforced, even in bypass mode.
- **KillSwitch** — `vscode.CancellationToken` threaded through the agent loop, the WebSocket stream, and every tool invocation. Triggered by the chat panel's stop button or the `swirlock-agent.stop` command.

### `ui/ChatParticipant`

A `vscode.chat.createChatParticipant` registration. The user invokes the agent by typing `@swirlock <task>` in the VS Code chat panel. The participant streams the model's text output as it arrives, surfaces queue position when the host is busy, renders tool execution as collapsible markdown blocks, and exposes a stop button that triggers the kill switch.

### `ui/StatusBar`

Two items:

1. Model host status (`● ready` / `◐ loading` / `○ unreachable`) — clickable to preload.
2. Permission mode (`🛡 normal` / `⚡ bypass`) — clickable to toggle.

### `ui/RunLogger`

Appends each iteration to `.swirlock/runs/<isoDate>-<turnId>.jsonl` with the full prompt, response, parsed actions, and tool results. One file per task. Disable via `swirlock-agent.runLog.enabled`.

## Wire format (caller side)

Per the v2 contract, every request to the host:

- Sets header `x-correlation-id` (UUIDv7, stable per task across iterations).
- Has body `{ requestContext: { callerService: "swirlock-agent", requestedAt, priority?: 1 }, input: { parts: [...] }, options: { responseFormat: "text", thinking: true } }`.

Streaming follows the v2 `StreamEvent` sequence: `accepted` → optional `queued`+ → `started` → optional `thinking`+ → `chunk`+ → `done` | `error`.

The agent uses `responseFormat: "text"` and parses fenced action blocks itself rather than `responseFormat: "json"`, because mixing free-form rationale with structured actions inside one streaming response is more useful than a single JSON blob arriving at the end.

## Configuration

All configuration is exposed under `swirlock-agent.*` in VS Code settings. The defaults are:

| Setting | Default |
|---|---|
| `host.baseUrl` | `http://localhost:5050` |
| `host.modelId` | `""` (use host default) |
| `host.callerService` | `swirlock-agent` |
| `host.priority` | `1` |
| `permissionMode` | `normal` |
| `command.allowList` | conservative regex list |
| `command.denyList` | destructive-pattern regex list |
| `maxIterations` | `50` |
| `maxContextTokens` | `8000` |
| `shell` | `auto` |
| `runLog.enabled` | `true` |
| `streaming.showThinking` | `true` |

## Non-goals

- No human approval loop per action.
- No MCP. The extension owns its tools directly.
- No cloud APIs.
- No multi-tenant features.
- No memory or RAG. The agent is task-scoped; long-term memory is the chatbot ecosystem's concern, not this one.

## Hard rules

1. The model host must remain agnostic. If a feature requires the host to know about agent state, the design is wrong.
2. Every wire request carries a correlation ID. Every log entry carries the same correlation ID.
3. Cancellation must propagate end-to-end within one tick — never block on a tool or a WebSocket frame.
4. Iteration cap is always enforced, regardless of permission mode.
5. The run log is append-only and never silently truncated.
