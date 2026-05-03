import * as vscode from 'vscode';

export type PermissionMode = 'normal' | 'bypass';
export type ShellPreference = 'auto' | 'pwsh' | 'powershell' | 'bash' | 'sh';

export interface SwirlockConfig {
    host: {
        baseUrl: string;
        modelId: string;
        callerService: string;
        priority: number;
    };
    permissionMode: PermissionMode;
    command: {
        allowList: string[];
        denyList: string[];
    };
    maxIterations: number;
    maxContextTokens: number;
    shell: ShellPreference;
    runLog: {
        enabled: boolean;
    };
    streaming: {
        showThinking: boolean;
    };
}

const SECTION = 'swirlock-agent';

export function readConfig(): SwirlockConfig {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    return {
        host: {
            baseUrl: cfg.get<string>('host.baseUrl', 'http://localhost:3000'),
            modelId: cfg.get<string>('host.modelId', ''),
            callerService: cfg.get<string>('host.callerService', 'swirlock-agent'),
            priority: cfg.get<number>('host.priority', 1),
        },
        permissionMode: cfg.get<PermissionMode>('permissionMode', 'normal'),
        command: {
            allowList: cfg.get<string[]>('command.allowList', []),
            denyList: cfg.get<string[]>('command.denyList', []),
        },
        maxIterations: cfg.get<number>('maxIterations', 50),
        maxContextTokens: cfg.get<number>('maxContextTokens', 8000),
        shell: cfg.get<ShellPreference>('shell', 'auto'),
        runLog: {
            enabled: cfg.get<boolean>('runLog.enabled', true),
        },
        streaming: {
            showThinking: cfg.get<boolean>('streaming.showThinking', true),
        },
    };
}

export async function setPermissionMode(mode: PermissionMode): Promise<void> {
    await vscode.workspace
        .getConfiguration(SECTION)
        .update('permissionMode', mode, vscode.ConfigurationTarget.Workspace);
}

export function onConfigChange(handler: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) {
            handler();
        }
    });
}
