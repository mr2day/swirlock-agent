import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { AgentLoop } from '../agent/AgentLoop';
import { AgentSink } from '../agent/AgentSink';
import { ContextManager } from '../context/ContextManager';
import { Plan } from '../agent/Plan';
import { ModelHostClient } from '../transport/ModelHostClient';
import { PermissionModeController } from '../safety/permissionMode';
import { RunLogger, trackLog } from './RunLogger';
import { uuidv7 } from '../util/uuid';
import { readConfig } from '../config/Config';
import {
    ExtensionMessage,
    HostState,
    WebviewMessage,
} from '../webview/protocol';
import { Action } from '../agent/actions';
import { QueueWaitInfo } from '../transport/contracts';
import { log } from '../util/logger';

export const AGENT_PANEL_VIEW_TYPE = 'swirlock-agent.panel';

export interface AgentPanelDeps {
    loop: AgentLoop;
    client: ModelHostClient;
    permission: PermissionModeController;
    extensionUri: vscode.Uri;
    workspaceRoot: string;
}

interface ActiveTask {
    taskId: string;
    correlationId: string;
    cts: vscode.CancellationTokenSource;
}

/**
 * Singleton webview panel that renders the agent in an editor-area tab —
 * the same surface as a file. Click the activity-bar icon (or run the
 * "Swirlock: Open Agent Panel" command) to open or focus it.
 */
export class AgentPanel implements vscode.Disposable {
    private static instance: AgentPanel | null = null;

    private panel: vscode.WebviewPanel | null = null;
    private active: ActiveTask | null = null;
    private subs: vscode.Disposable[] = [];
    private hostStatusTimer: NodeJS.Timeout | undefined;

    /**
     * Long-lived conversation state for this panel session. Persists across
     * user prompts so the model sees previous turns ("was he married?"
     * resolves "he" against the previous answer). Reset on clear or panel
     * disposal.
     */
    private context = new ContextManager();
    private plan = new Plan();

    constructor(private readonly deps: AgentPanelDeps) {
        this.subs.push(
            this.deps.permission.onChange((mode) => this.post({ type: 'permission_mode', payload: mode })),
        );
    }

    static get(deps: AgentPanelDeps): AgentPanel {
        if (!AgentPanel.instance) {
            AgentPanel.instance = new AgentPanel(deps);
        }
        return AgentPanel.instance;
    }

    /**
     * Reveal the panel, creating it if necessary. Always shows in the active
     * editor group as a tab.
     */
    reveal(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active, false);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            AGENT_PANEL_VIEW_TYPE,
            'Swirlock Agent',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(this.deps.extensionUri, 'dist'),
                    vscode.Uri.joinPath(this.deps.extensionUri, 'media'),
                    vscode.Uri.joinPath(this.deps.extensionUri, 'resources'),
                ],
            },
        );
        this.panel.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, 'resources', 'swirlock.svg');
        this.panel.webview.html = this.renderHtml(this.panel.webview);

        const messageSub = this.panel.webview.onDidReceiveMessage((m: WebviewMessage) =>
            this.handleMessage(m),
        );
        const visibleSub = this.panel.onDidChangeViewState(() => {
            if (this.panel?.visible) {
                this.startHostStatusPolling();
            } else {
                this.stopHostStatusPolling();
            }
        });
        const disposeSub = this.panel.onDidDispose(() => {
            messageSub.dispose();
            visibleSub.dispose();
            disposeSub.dispose();
            this.stopHostStatusPolling();
            this.resetSession();
            this.active = null;
            this.panel = null;
        });
        this.startHostStatusPolling();
    }

    /** Cancel the active task. Returns true if something was cancelled. */
    stopActive(): boolean {
        if (this.active) {
            this.active.cts.cancel();
            return true;
        }
        return false;
    }

    isOpen(): boolean {
        return this.panel !== null;
    }

    /** Wipe conversation state and start fresh. Active task is cancelled. */
    private resetSession(): void {
        this.active?.cts.cancel();
        this.context = new ContextManager();
        this.plan = new Plan();
    }

    dispose(): void {
        this.stopHostStatusPolling();
        this.active?.cts.cancel();
        this.subs.forEach((s) => s.dispose());
        this.panel?.dispose();
        this.panel = null;
        AgentPanel.instance = null;
    }

    // ---------- webview → extension --------------------------------------

    private async handleMessage(msg: WebviewMessage): Promise<void> {
        switch (msg.type) {
            case 'ready':
                await this.sendInit();
                return;
            case 'submit':
                await this.startTask(msg.payload.prompt);
                return;
            case 'stop':
                this.stopActive();
                return;
            case 'toggle_permission_mode': {
                const next = await this.deps.permission.toggle();
                this.post({ type: 'system_message', payload: { markdown: `Permission mode: **${next}**` } });
                return;
            }
            case 'preload_model': {
                const cts = new vscode.CancellationTokenSource();
                try {
                    const res = await this.deps.client.preload(cts.token);
                    this.post({
                        type: 'system_message',
                        payload: {
                            markdown: `Preload accepted for \`${res.data.modelId}\` (status: ${res.data.status ?? 'accepted'}).`,
                        },
                    });
                    await this.refreshHostStatus();
                } catch (e) {
                    this.post({
                        type: 'system_message',
                        payload: { markdown: `Preload failed: ${(e as Error).message}`, tone: 'error' },
                    });
                } finally {
                    cts.dispose();
                }
                return;
            }
            case 'show_status': {
                const cts = new vscode.CancellationTokenSource();
                try {
                    const status = await this.deps.client.modelStatus(cts.token);
                    const doc = await vscode.workspace.openTextDocument({
                        language: 'json',
                        content: JSON.stringify(status, null, 2),
                    });
                    await vscode.window.showTextDocument(doc, { preview: true });
                } catch (e) {
                    this.post({
                        type: 'system_message',
                        payload: { markdown: `Status failed: ${(e as Error).message}`, tone: 'error' },
                    });
                } finally {
                    cts.dispose();
                }
                return;
            }
            case 'open_run_log':
                await vscode.commands.executeCommand('swirlock-agent.openRunLog');
                return;
            case 'clear_conversation':
                this.resetSession();
                return;
            case 'refresh_host':
                await this.refreshHostStatus();
                return;
        }
    }

    // ---------- task lifecycle -------------------------------------------

    private async startTask(prompt: string): Promise<void> {
        if (this.active) {
            this.post({
                type: 'system_message',
                payload: { markdown: 'A task is already running. Stop it first.', tone: 'warn' },
            });
            return;
        }
        const taskId = uuidv7();
        const correlationId = uuidv7();
        const cts = new vscode.CancellationTokenSource();
        this.active = { taskId, correlationId, cts };

        const config = readConfig();
        const runLog = new RunLogger({
            enabled: config.runLog.enabled,
            workspaceRoot: this.deps.workspaceRoot,
            correlationId,
        });
        trackLog(runLog);

        this.post({ type: 'task_started', payload: { taskId, prompt, correlationId } });

        const sink = this.makeSink(taskId);

        try {
            const outcome = await this.deps.loop.run({
                task: prompt,
                context: this.context,
                plan: this.plan,
                correlationId,
                sink,
                token: cts.token,
                runLog,
            });
            this.post({ type: 'task_finished', payload: { taskId, outcome } });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            log().error(`AgentPanel task crashed: ${message}`);
            this.post({
                type: 'task_finished',
                payload: { taskId, outcome: { kind: 'error', iterations: 0, message } },
            });
        } finally {
            cts.dispose();
            this.active = null;
        }
    }

    private makeSink(taskId: string): AgentSink {
        const send = <T extends ExtensionMessage>(m: T) => this.post(m);
        return {
            progress: (text: string) => send({ type: 'progress', payload: { taskId, text } }),
            queued: (info: QueueWaitInfo) => send({ type: 'queued', payload: { taskId, info } }),
            started: () => send({ type: 'progress', payload: { taskId, text: 'Generating…' } }),
            assistantChunk: (text: string) => send({ type: 'assistant_chunk', payload: { taskId, text } }),
            assistantThinking: (text: string) => send({ type: 'assistant_thinking', payload: { taskId, text } }),
            planUpdate: (plan: string) => send({ type: 'plan_update', payload: { taskId, plan } }),
            actionStarted: (action: Action) => send({ type: 'action_started', payload: { taskId, action } }),
            actionFinished: (summary: string, error: boolean) =>
                send({ type: 'action_finished', payload: { taskId, summary, error } }),
            message: (markdown: string, tone?: 'info' | 'warn' | 'error') =>
                send({ type: 'system_message', payload: { taskId, markdown, tone } }),
        };
    }

    // ---------- host status polling --------------------------------------

    private startHostStatusPolling(): void {
        if (this.hostStatusTimer) {
            return;
        }
        const tick = () => void this.refreshHostStatus();
        tick();
        this.hostStatusTimer = setInterval(tick, 15_000);
    }

    private stopHostStatusPolling(): void {
        if (this.hostStatusTimer) {
            clearInterval(this.hostStatusTimer);
            this.hostStatusTimer = undefined;
        }
    }

    private async refreshHostStatus(): Promise<void> {
        if (!this.panel) {
            return;
        }
        const state = await this.fetchHostState();
        this.post({ type: 'host_status', payload: state });
    }

    private async fetchHostState(): Promise<HostState> {
        const cts = new vscode.CancellationTokenSource();
        const timer = setTimeout(() => cts.cancel(), 2_000);
        try {
            const res = await this.deps.client.modelStatus(cts.token);
            return {
                state: 'ok',
                modelId: res.data.modelId,
                ready: res.data.ready,
                loaded: res.data.loaded,
                queueDepth: res.data.capacity.queueDepth,
            };
        } catch (e) {
            return { state: 'unreachable', message: (e as Error).message };
        } finally {
            clearTimeout(timer);
            cts.dispose();
        }
    }

    private async sendInit(): Promise<void> {
        const hostStatus = await this.fetchHostState();
        this.post({
            type: 'init',
            payload: {
                permissionMode: this.deps.permission.mode,
                hostStatus,
            },
        });
    }

    private post(msg: ExtensionMessage): void {
        this.panel?.webview.postMessage(msg);
    }

    // ---------- HTML render ----------------------------------------------

    private renderHtml(webview: vscode.Webview): string {
        const nonce = randomBytes(16).toString('base64');
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.deps.extensionUri, 'dist', 'webview.js'),
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'main.css'),
        );
        const csp = [
            `default-src 'none'`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`,
            `font-src ${webview.cspSource}`,
            `img-src ${webview.cspSource} data:`,
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
<title>Swirlock Agent</title>
</head>
<body>
<div id="root">
  <header>
    <span id="host-status" class="pill">○ checking…</span>
    <span id="mode-badge" class="pill">⚡ bypass</span>
    <span class="spacer"></span>
    <button id="mode-btn" title="Toggle permission mode">mode</button>
    <button id="preload-btn" title="Preload the configured model">preload</button>
    <button id="status-btn" title="Show /v2/model/status">status</button>
    <button id="log-btn" title="Open the latest run log">log</button>
    <button id="clear-btn" title="Clear the conversation">clear</button>
  </header>

  <div id="plan-bar" class="hidden">
    <details>
      <summary>Plan</summary>
      <div id="plan-content" class="plan-content"></div>
    </details>
  </div>

  <main id="messages"></main>

  <footer>
    <div class="row">
      <textarea id="input" placeholder="Ask Swirlock to do something in your workspace…" rows="1"></textarea>
      <button id="send-btn" class="primary">Send</button>
      <button id="stop-btn" class="danger hidden">Stop</button>
    </div>
    <div class="hint">Enter to send · Shift+Enter for newline · Stop cancels the current run</div>
  </footer>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
