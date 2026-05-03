swirlock-agent Manifest

swirlock-agent is a local autonomous coding agent implemented as a Visual Studio Code extension. Its purpose is to let the user give coding tasks inside VS Code and have the agent inspect the workspace, manage its own context window, call a locally hosted LLM through swirlock-llm-host, edit files, run commands, inspect errors, and iterate until the task is complete. The project must be built as a TypeScript VS Code extension. The LLM host is external and must remain only an inference gateway. It must not manage memory, tools, files, terminal commands, plans, or task state. All agent behavior belongs inside swirlock-agent.

The architecture is: VS Code extension → agent loop → context manager → tool layer → WebSocket client → swirlock-llm-host → local LLM. The VS Code extension owns the agent loop, UI entry points, command registration, file access, terminal or PowerShell command execution, git operations, workspace inspection, context selection, context compression, and interpretation of LLM responses. swirlock-llm-host only receives prompts over WebSocket and returns model output.

The project must use TypeScript, modern import/export syntax, and a modular folder structure. 

The context manager must be local to the extension. It should not send the whole project to the LLM. It should build a compact prompt from prioritized context entries. Context entries should include type, content, priority, source, createdAt, and tokenEstimate. High-priority context includes system instructions, current user task, active file content, recent tool results, recent errors, current plan, and touched files. Low-priority context includes old command outputs, old assistant messages, and stale file contents. When the context becomes too large, the manager should drop low-priority entries first.

The agent loop should follow this model: receive task → build context → call LLM → parse response → execute tool actions → capture results → update context → repeat. The LLM should return structured JSON actions such as read_file, write_file, run_command, git_status, git_commit, and finish. The extension should execute these actions directly using VS Code APIs and Node APIs.

The tool layer should be deterministic. File reading and writing should use VS Code workspace APIs or Node fs where appropriate. Commands should be executed through Node child_process, preferably spawn, so stdout, stderr, and exit codes can be captured cleanly and returned to the context manager. PowerShell should be supported as the default shell on Windows. Git operations can initially be plain git commands executed in the workspace folder.

The agent is intended to run autonomously in a protected environment. It does not need a human approval loop before every command. 

MCP is not required for this project. The VS Code extension can access files, terminal, git, UI, and workspace state directly through VS Code and Node APIs. MCP may be added later only if the project needs reusable external tool servers shared with other agents or applications. The first version must avoid MCP to reduce complexity.

The LLM client must connect to swirlock-llm-host over WebSocket. The exact host URL should be configurable in VS Code settings, with a sensible default such as ws://localhost:5000 or whatever the existing swirlock-llm-host uses. Streaming is a must.

The project must remain local-first, modular, and easy to reason about. The LLM is only the inference engine. The extension is the agent.