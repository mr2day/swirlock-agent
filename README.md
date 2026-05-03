swirlock-agent

Local autonomous coding agent implemented as a Visual Studio Code extension. It connects to a local LLM host (e.g. swirlock-llm-host) and executes coding tasks directly inside the workspace.

Purpose

This project provides a self-contained coding agent that runs entirely on the local machine, uses a locally hosted LLM, manages its own context window, and interacts directly with the workspace (files, git, terminal). The LLM is treated strictly as an inference engine. All reasoning, memory, and tool execution are handled by the extension.

Core Principles

Separation of concerns: the LLM host is responsible only for inference, while the agent handles context, planning, and execution. Local-first: no dependency on external APIs and no cloud execution required. Autonomous execution: no human approval loop, runs inside a controlled environment. Deterministic tooling: structured file edits, controlled command execution, and reproducible behavior.

Architecture

VS Code Extension (swirlock-agent) contains the agent loop, context manager, tool layer (file system, terminal/PowerShell, git, workspace inspection), and a WebSocket client that connects to swirlock-llm-host, which in turn runs the local LLM (e.g. gemma4:e4b).

Responsibilities

The agent builds and manages the context window, decides actions based on LLM output, reads and writes files, executes commands, and manages task state and the iteration loop. The LLM host (external) only receives prompts and returns completions, without memory, tools, or planning.

Context Management

The agent constructs a context window dynamically for each LLM call. It includes the current user task, active files, relevant file snippets, recent tool outputs, execution results such as build or test errors, and a compressed history summary. Context is size-limited and prioritized, and older or low-value data is summarized or discarded.

Tooling

The agent operates through local tools: file read/write, diff application, command execution via PowerShell, and git operations. All tools are invoked programmatically by the extension.

Execution Model

Receive task → build context → call LLM → parse response into actions → execute actions → capture results → update context → repeat until task completion.

Environment Assumptions

The agent runs in an isolated workspace or disposable repository, with restricted credentials, no access to sensitive data, and a local LLM available via WebSocket.