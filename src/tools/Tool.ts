import * as vscode from 'vscode';
import { Action } from '../agent/actions';
import { PathJail } from '../safety/pathJail';
import { CommandPolicy } from '../safety/commandPolicy';
import { PermissionModeController } from '../safety/permissionMode';
import { ShellPreference } from '../config/Config';

export interface ToolContext {
    workspaceRoot: string;
    pathJail: PathJail;
    commandPolicy: CommandPolicy;
    permission: PermissionModeController;
    shell: ShellPreference;
    token: vscode.CancellationToken;
}

export interface ToolResult {
    /** Short single-line summary suitable for UI rendering. */
    summary: string;
    /** Detailed payload for context (truncated upstream if needed). */
    output: string;
    /** Soft size cap. Tool implementations apply their own truncation. */
    truncated?: boolean;
    /** Set to true on a structured tool failure that should not retry. */
    error?: boolean;
}

export interface Tool<A extends Action = Action> {
    readonly type: A['type'];
    execute(action: A, ctx: ToolContext): Promise<ToolResult>;
}

/** Soft cap for any single tool output written into context. */
export const TOOL_OUTPUT_SOFT_LIMIT = 16_000; // characters

export function truncate(s: string, limit = TOOL_OUTPUT_SOFT_LIMIT): { text: string; truncated: boolean } {
    if (s.length <= limit) {
        return { text: s, truncated: false };
    }
    const head = s.slice(0, Math.floor(limit * 0.7));
    const tail = s.slice(s.length - Math.floor(limit * 0.2));
    const dropped = s.length - head.length - tail.length;
    return {
        text: `${head}\n\n[… ${dropped} characters truncated …]\n\n${tail}`,
        truncated: true,
    };
}
