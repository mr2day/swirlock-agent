import * as vscode from 'vscode';
import { ModelHostClient } from '../transport/ModelHostClient';
import { PermissionModeController } from '../safety/permissionMode';

export class StatusBar implements vscode.Disposable {
    private host: vscode.StatusBarItem;
    private mode: vscode.StatusBarItem;
    private timer: NodeJS.Timeout | undefined;
    private subs: vscode.Disposable[] = [];

    constructor(
        private client: ModelHostClient,
        private permission: PermissionModeController,
    ) {
        this.host = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.host.command = 'swirlock-agent.preloadModel';
        this.host.tooltip = 'Swirlock model host. Click to preload.';
        this.host.text = '$(sync~spin) swirlock';
        this.host.show();

        this.mode = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
        this.mode.command = 'swirlock-agent.togglePermissionMode';
        this.mode.tooltip = 'Toggle permission mode (normal ↔ bypass)';
        this.show();
        this.mode.show();

        this.subs.push(this.permission.onChange(() => this.show()));
    }

    /** Begin polling the host status. Safe to call repeatedly. */
    start(): void {
        if (this.timer) {
            return;
        }
        const tick = () => void this.refresh();
        tick();
        this.timer = setInterval(tick, 15_000);
    }

    setHostClient(client: ModelHostClient): void {
        this.client = client;
        void this.refresh();
    }

    async refresh(): Promise<void> {
        const cts = new vscode.CancellationTokenSource();
        const timeout = setTimeout(() => cts.cancel(), 2_000);
        try {
            const status = await this.client.modelStatus(cts.token);
            const ready = status.data.ready;
            const loaded = status.data.loaded;
            if (ready && loaded) {
                this.host.text = `$(check) swirlock: ${status.data.modelId}`;
            } else if (loaded) {
                this.host.text = `$(loading~spin) swirlock: warming`;
            } else {
                this.host.text = `$(circle-outline) swirlock: not loaded`;
            }
            this.host.tooltip = `Model: ${status.data.modelId}\nReady: ${ready}\nLoaded: ${loaded}\nQueue: ${status.data.capacity.queueDepth}`;
        } catch (e) {
            this.host.text = '$(error) swirlock: unreachable';
            this.host.tooltip = `Cannot reach model host. ${(e as Error).message}`;
        } finally {
            clearTimeout(timeout);
            cts.dispose();
        }
    }

    private show(): void {
        const m = this.permission.mode;
        this.mode.text = m === 'normal' ? '$(shield) normal' : '$(zap) bypass';
        this.mode.backgroundColor =
            m === 'bypass'
                ? new vscode.ThemeColor('statusBarItem.warningBackground')
                : undefined;
    }

    dispose(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.host.dispose();
        this.mode.dispose();
        this.subs.forEach((s) => s.dispose());
    }
}
