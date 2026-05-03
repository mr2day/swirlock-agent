import * as vscode from 'vscode';
import * as path from 'path';

const TEXT_ENCODER = new TextEncoder();

export interface RunLoggerOptions {
    enabled: boolean;
    workspaceRoot: string;
    correlationId: string;
}

/**
 * Append-only JSONL log of one agent task. One line per event.
 * File path: <workspaceRoot>/.swirlock/runs/<isoDate>-<correlationId>.jsonl
 */
export class RunLogger {
    private readonly uri: vscode.Uri | null;
    private existing = '';
    private writes = Promise.resolve();

    constructor(opts: RunLoggerOptions) {
        if (!opts.enabled) {
            this.uri = null;
            return;
        }
        const stamp = new Date().toISOString().replace(/[:]/g, '-');
        const dir = path.join(opts.workspaceRoot, '.swirlock', 'runs');
        this.uri = vscode.Uri.file(path.join(dir, `${stamp}-${opts.correlationId}.jsonl`));
    }

    get path(): string | undefined {
        return this.uri?.fsPath;
    }

    async event(event: string, payload: Record<string, unknown>): Promise<void> {
        if (!this.uri) {
            return;
        }
        const line = JSON.stringify({ at: new Date().toISOString(), event, ...payload }) + '\n';
        // Serialise writes to avoid interleaving.
        this.writes = this.writes.then(async () => {
            try {
                this.existing += line;
                await vscode.workspace.fs.createDirectory(
                    vscode.Uri.file(path.dirname(this.uri!.fsPath)),
                );
                await vscode.workspace.fs.writeFile(this.uri!, TEXT_ENCODER.encode(this.existing));
            } catch {
                // Logging must never crash the agent.
            }
        });
        return this.writes;
    }
}

let lastLog: RunLogger | undefined;

export function trackLog(log: RunLogger): void {
    if (log.path) {
        lastLog = log;
    }
}

export function latestLogPath(): string | undefined {
    return lastLog?.path;
}
