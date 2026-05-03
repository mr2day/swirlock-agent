import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLogger(): vscode.LogOutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('Swirlock Agent', { log: true });
    }
    return channel;
}

export function log(): vscode.LogOutputChannel {
    if (!channel) {
        return initLogger();
    }
    return channel;
}
