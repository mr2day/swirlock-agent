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
    /** Total token budget for the assembled prompt. */
    maxContextTokens: number;
    /**
     * Sub-budgets for the layered context. Tier 1 + Tier 2 totals are reserved
     * up front; the remainder goes to Tier 3 (rolling transcript).
     */
    budgets: {
        projectMemoryTokens: number;
        repoMapTokens: number;
        activeFilesTokens: number;
        todosTokens: number;
        planTokens: number;
        /**
         * When transcript usage exceeds this fraction of its sub-budget,
         * trigger LLM-based compaction of middle entries.
         */
        compactionThreshold: number;
        /** Number of recent transcript turns kept verbatim across compaction. */
        keepRecentTurns: number;
    };
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
            baseUrl: cfg.get<string>('host.baseUrl', 'http://localhost:3213'),
            modelId: cfg.get<string>('host.modelId', ''),
            callerService: cfg.get<string>('host.callerService', 'swirlock-agent'),
            priority: cfg.get<number>('host.priority', 1),
        },
        permissionMode: cfg.get<PermissionMode>('permissionMode', 'bypass'),
        command: {
            allowList: cfg.get<string[]>('command.allowList', []),
            denyList: cfg.get<string[]>('command.denyList', []),
        },
        maxIterations: cfg.get<number>('maxIterations', 50),
        maxContextTokens: cfg.get<number>('maxContextTokens', 32000),
        budgets: {
            projectMemoryTokens: cfg.get<number>('budgets.projectMemoryTokens', 4000),
            repoMapTokens: cfg.get<number>('budgets.repoMapTokens', 1500),
            activeFilesTokens: cfg.get<number>('budgets.activeFilesTokens', 8000),
            todosTokens: cfg.get<number>('budgets.todosTokens', 500),
            planTokens: cfg.get<number>('budgets.planTokens', 1000),
            compactionThreshold: cfg.get<number>('budgets.compactionThreshold', 0.75),
            keepRecentTurns: cfg.get<number>('budgets.keepRecentTurns', 6),
        },
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
