import * as vscode from 'vscode';

export class CancelledError extends Error {
    constructor() {
        super('Operation cancelled');
        this.name = 'CancelledError';
    }
}

export function throwIfCancelled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new CancelledError();
    }
}

/**
 * Combine multiple cancellation tokens into one. The composed token is
 * cancelled when any source is cancelled.
 */
export function composeTokens(...tokens: vscode.CancellationToken[]): vscode.CancellationToken {
    const source = new vscode.CancellationTokenSource();
    for (const t of tokens) {
        if (t.isCancellationRequested) {
            source.cancel();
            break;
        }
        t.onCancellationRequested(() => source.cancel());
    }
    return source.token;
}
