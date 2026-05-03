import * as vscode from 'vscode';
import { initLogger, log } from './util/logger';
import { onConfigChange, readConfig } from './config/Config';
import { ModelHostClient } from './transport/ModelHostClient';
import { PathJail } from './safety/pathJail';
import { CommandPolicy } from './safety/commandPolicy';
import { PermissionModeController } from './safety/permissionMode';
import { ToolRegistry } from './tools/ToolRegistry';
import {
    EditFileTool,
    ListDirTool,
    ReadFileTool,
    SearchTool,
    WriteFileTool,
} from './tools/fileTools';
import { ShellTool } from './tools/shellTool';
import { GitTool } from './tools/gitTool';
import { AgentLoop } from './agent/AgentLoop';
import { registerChatParticipant } from './ui/ChatParticipant';
import { StatusBar } from './ui/StatusBar';
import { latestLogPath } from './ui/RunLogger';

let activeCancellation: vscode.CancellationTokenSource | null = null;

export function activate(context: vscode.ExtensionContext): void {
    initLogger();
    log().info('swirlock-agent activating');

    const workspaceRoot = pickWorkspaceRoot();
    if (!workspaceRoot) {
        vscode.window.showWarningMessage(
            'Swirlock Agent: open a workspace folder to use the agent.',
        );
        return;
    }

    let config = readConfig();

    const client = new ModelHostClient({
        baseUrl: config.host.baseUrl,
        callerService: config.host.callerService,
    });

    const pathJail = new PathJail(workspaceRoot);
    const commandPolicy = new CommandPolicy();
    commandPolicy.update(config.command.allowList, config.command.denyList);

    const permission = new PermissionModeController();

    const registry = new ToolRegistry();
    registry.register(new ReadFileTool());
    registry.register(new WriteFileTool());
    registry.register(new EditFileTool());
    registry.register(new ListDirTool());
    registry.register(new SearchTool());
    registry.register(new ShellTool());
    registry.register(new GitTool());

    const loop = new AgentLoop({
        client,
        registry,
        pathJail,
        commandPolicy,
        permission,
        config,
        workspaceRoot,
    });

    const statusBar = new StatusBar(client, permission);
    statusBar.start();

    const participant = registerChatParticipant({
        loop,
        workspaceRoot,
        setActiveCancellation(src) {
            activeCancellation = src;
        },
    });

    context.subscriptions.push(
        statusBar,
        permission,
        participant,
        onConfigChange(() => {
            config = readConfig();
            client.update({
                baseUrl: config.host.baseUrl,
                callerService: config.host.callerService,
            });
            commandPolicy.update(config.command.allowList, config.command.denyList);
            permission.refresh();
            // Loop reads current config via the config reference; rebuild it
            // so future runs pick up new host/iteration/budget settings.
            (loop as unknown as { deps: { config: typeof config } }).deps.config = config;
            log().info('Configuration reloaded.');
        }),
        vscode.commands.registerCommand('swirlock-agent.stop', () => {
            if (activeCancellation) {
                activeCancellation.cancel();
                vscode.window.showInformationMessage('Swirlock: stopping current run…');
            } else {
                vscode.window.showInformationMessage('Swirlock: no active run.');
            }
        }),
        vscode.commands.registerCommand('swirlock-agent.togglePermissionMode', async () => {
            const next = await permission.toggle();
            vscode.window.showInformationMessage(`Swirlock permission mode: ${next}`);
        }),
        vscode.commands.registerCommand('swirlock-agent.preloadModel', async () => {
            const cts = new vscode.CancellationTokenSource();
            try {
                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: 'Swirlock: preloading model…',
                        cancellable: true,
                    },
                    async (_progress, token) => {
                        token.onCancellationRequested(() => cts.cancel());
                        const res = await client.preload(cts.token);
                        vscode.window.showInformationMessage(
                            `Swirlock model "${res.data.modelId}" status: ${res.data.status ?? 'accepted'}`,
                        );
                        await statusBar.refresh();
                    },
                );
            } catch (e) {
                vscode.window.showErrorMessage(`Swirlock preload failed: ${(e as Error).message}`);
            } finally {
                cts.dispose();
            }
        }),
        vscode.commands.registerCommand('swirlock-agent.showStatus', async () => {
            const cts = new vscode.CancellationTokenSource();
            try {
                const status = await client.modelStatus(cts.token);
                const doc = await vscode.workspace.openTextDocument({
                    language: 'json',
                    content: JSON.stringify(status, null, 2),
                });
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch (e) {
                vscode.window.showErrorMessage(`Swirlock status failed: ${(e as Error).message}`);
            } finally {
                cts.dispose();
            }
        }),
        vscode.commands.registerCommand('swirlock-agent.openRunLog', async () => {
            const p = latestLogPath();
            if (!p) {
                vscode.window.showInformationMessage(
                    'Swirlock: no run log yet. Run a task first.',
                );
                return;
            }
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
            await vscode.window.showTextDocument(doc, { preview: true });
        }),
    );

    log().info(`swirlock-agent activated (workspace: ${workspaceRoot})`);
}

export function deactivate(): void {
    activeCancellation?.cancel();
    activeCancellation = null;
}

function pickWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return undefined;
    }
    return folders[0].uri.fsPath;
}
