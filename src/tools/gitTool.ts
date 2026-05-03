import { spawn } from 'child_process';
import { GitAction } from '../agent/actions';
import { Tool, ToolContext, ToolResult, truncate } from './Tool';

const DENY_ARGS = new Set(['push', 'reset', 'clean']);

export class GitTool implements Tool<GitAction> {
    readonly type = 'git' as const;

    async execute(action: GitAction, ctx: ToolContext): Promise<ToolResult> {
        if (!Array.isArray(action.args) || action.args.length === 0) {
            return errorResult('git: args must be a non-empty array of strings.');
        }
        const sub = action.args[0];
        if (ctx.permission.mode === 'normal' && DENY_ARGS.has(sub)) {
            return errorResult(
                `git: subcommand "${sub}" requires bypass mode. Toggle the permission mode to allow it.`,
            );
        }
        return new Promise<ToolResult>((resolve) => {
            const child = spawn('git', action.args, {
                cwd: ctx.workspaceRoot,
                env: process.env,
                windowsHide: true,
            });
            let stdout = '';
            let stderr = '';
            let killed = false;
            const cancelSub = ctx.token.onCancellationRequested(() => {
                killed = true;
                try {
                    child.kill('SIGKILL');
                } catch {
                    /* ignore */
                }
            });
            child.stdout.on('data', (b: Buffer) => {
                stdout += b.toString('utf8');
            });
            child.stderr.on('data', (b: Buffer) => {
                stderr += b.toString('utf8');
            });
            child.on('error', (err) => {
                cancelSub.dispose();
                resolve(errorResult(`git spawn error: ${err.message}`));
            });
            child.on('close', (code) => {
                cancelSub.dispose();
                const t = truncate((stdout || '') + (stderr ? `\n--- stderr ---\n${stderr}` : ''));
                resolve({
                    summary: `git ${action.args.join(' ')} (${killed ? 'killed' : `exit ${code}`})`,
                    output: t.text,
                    truncated: t.truncated,
                    error: code !== 0 || killed,
                });
            });
        });
    }
}

function errorResult(message: string): ToolResult {
    return { summary: message, output: message, error: true };
}
