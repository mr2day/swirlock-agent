# swirlock-agent

A local autonomous coding agent for Visual Studio Code. Type `@swirlock` in the chat panel, give it a task, walk away.

The agent runs entirely on your machine. It connects to a local `swirlock-llm-host` instance, manages its own context window, edits files, runs commands, runs git, and iterates until the task is finished. The model is treated as an inference appliance — all reasoning, planning, and tool use happens inside the extension.

## Status

Active development. The transport, agent loop, tool layer, and chat participant are in place. Not yet on the VS Code Marketplace; install from a local `.vsix`.

## Prerequisites

- Visual Studio Code 1.118 or newer.
- Node.js 20+ (for building).
- A reachable `swirlock-llm-host` instance implementing the **v2 Model Host API**. Default endpoint is `http://localhost:5050`.
- A loaded model on the host (e.g. `gemma4:e4b`). Use the **Swirlock: Preload Model** command to warm it up before the first task.

## Install

```powershell
npm install
npm run package
code --install-extension ./swirlock-agent-0.0.1.vsix
```

For development:

```powershell
npm install
npm run watch
# then press F5 in VS Code to launch the Extension Development Host
```

## Usage

1. Open the VS Code chat panel (`Ctrl+Alt+I`).
2. Type `@swirlock` followed by your task. Examples:
   - `@swirlock add input validation to the signup form`
   - `@swirlock find why the auth tests are failing and fix it`
   - `@swirlock refactor src/api/* to use async/await instead of callbacks`
3. The agent shows its plan, streams its reasoning, executes file edits and shell commands, and reports when done. Click the stop button at any time to kill the run.

## Permission modes

Two modes, toggleable from the status bar (`🛡 normal` ↔ `⚡ bypass`):

- **Normal** — file writes are confined to the workspace; shell commands are matched against allow/deny lists; the iteration cap and kill switch are active.
- **Bypass** — analogous to Claude Code's bypass-permissions mode. Path and command policies are disabled. The iteration cap and kill switch remain active. Use only in disposable workspaces, sandboxes, or VMs.

The mode persists per workspace.

## Configuration

All settings live under `swirlock-agent.*`:

| Setting | Default | Notes |
|---|---|---|
| `host.baseUrl` | `http://localhost:5050` | Base URL of `swirlock-llm-host`. WebSocket is upgraded from this. |
| `host.modelId` | `""` | Empty means "use the host's default model." Set to override. |
| `host.callerService` | `swirlock-agent` | Identity sent in `requestContext.callerService`. |
| `host.priority` | `1` | Numeric priority sent to the host queue. Higher runs first. |
| `permissionMode` | `normal` | `normal` or `bypass`. |
| `command.allowList` | conservative | Regex patterns; commands matching any are allowed in normal mode. |
| `command.denyList` | destructive patterns | Regex patterns; commands matching any are blocked even in bypass mode if they match the kill list. |
| `maxIterations` | `50` | Hard cap per task. |
| `maxContextTokens` | `8000` | Token budget passed to the prompt assembler. |
| `shell` | `auto` | `auto` / `pwsh` / `powershell` / `bash` / `sh`. |
| `runLog.enabled` | `true` | Write `.swirlock/runs/<turnId>.jsonl` per task. |
| `streaming.showThinking` | `true` | Display the model's `thinking` events in the chat panel. |

## Commands

| Command | Default keybinding | Description |
|---|---|---|
| `Swirlock: Stop Current Run` | — | Kill switch. Cancels the active task. |
| `Swirlock: Toggle Permission Mode` | — | Flip between normal and bypass. |
| `Swirlock: Preload Model` | — | Asks the host to load the configured model. |
| `Swirlock: Show Model Status` | — | Displays the host's `/v2/model/status` response. |
| `Swirlock: Open Latest Run Log` | — | Opens the most recent `.swirlock/runs/*.jsonl` file. |

## Run logs

Every task is logged as JSONL to `.swirlock/runs/<isoDate>-<turnId>.jsonl` inside the workspace. Each line is a structured event: prompt sent, chunks received, actions parsed, tool results, errors. Use these for debugging, replay, or sharing repro cases.

Disable with `swirlock-agent.runLog.enabled: false`.

## Troubleshooting

**`◯ unreachable` in the status bar** — the extension can't reach `swirlock-llm-host`. Check `host.baseUrl` and that the host process is running. Run **Swirlock: Show Model Status** to see the precise error.

**Agent says "model not loaded"** — the host has the model configured but hasn't loaded it. Run **Swirlock: Preload Model**.

**Run stalls with "queued, position N"** — the host is busy. The agent will wait. Either reduce `host.priority` of other callers, or stop the run.

**Action validation errors loop** — the model is producing malformed action blocks. Check the latest run log; the validation error is fed back to the model, but if it persists, the model may be too small or the system prompt may need tuning.

**File writes blocked in normal mode** — the path resolves outside the workspace root. Either move the file inside the workspace or switch to bypass mode.

## Architecture

See [MANIFEST.md](MANIFEST.md) for the full architectural rationale and module map.

## License

TBD.
