import { spawn } from 'child_process';
import * as os from 'os';
import { RunCommandAction } from '../agent/actions';
import { Tool, ToolContext, ToolResult, truncate } from './Tool';
import { ShellPreference } from '../config/Config';

interface ShellInvocation {
    file: string;
    args: string[];
}

export class ShellTool implements Tool<RunCommandAction> {
    readonly type = 'run_command' as const;

    async execute(action: RunCommandAction, ctx: ToolContext): Promise<ToolResult> {
        try {
            ctx.commandPolicy.check(action.command, ctx.permission.mode);
        } catch (e) {
            return { summary: (e as Error).message, output: (e as Error).message, error: true };
        }

        const cwd = action.cwd ? ctx.pathJail.resolve(action.cwd) : ctx.workspaceRoot;
        const shell = pickShell(ctx.shell);
        const invocation = buildInvocation(shell, action.command);
        const timeout = action.timeoutMs ?? 120_000;

        return new Promise<ToolResult>((resolve) => {
            const child = spawn(invocation.file, invocation.args, {
                cwd,
                env: process.env,
                windowsHide: true,
            });
            let stdout = '';
            let stderr = '';
            let killed = false;
            let timedOut = false;

            const timer = setTimeout(() => {
                timedOut = true;
                try {
                    child.kill('SIGKILL');
                } catch {
                    /* ignore */
                }
            }, timeout);

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
                clearTimeout(timer);
                cancelSub.dispose();
                resolve({
                    summary: `run_command spawn error: ${err.message}`,
                    output: err.message,
                    error: true,
                });
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                cancelSub.dispose();
                const stdoutT = truncate(stdout);
                const stderrT = truncate(stderr);
                const status = killed
                    ? 'killed (cancelled)'
                    : timedOut
                      ? `killed (timeout ${timeout}ms)`
                      : signal
                        ? `signal ${signal}`
                        : `exit ${code}`;
                const body =
                    `$ ${action.command}\n` +
                    `cwd: ${cwd}\n` +
                    `status: ${status}\n` +
                    (stdoutT.text ? `--- stdout ---\n${stdoutT.text}\n` : '') +
                    (stderrT.text ? `--- stderr ---\n${stderrT.text}\n` : '');
                resolve({
                    summary: `run_command (${status})`,
                    output: body,
                    truncated: stdoutT.truncated || stderrT.truncated,
                    error: code !== 0 || killed || timedOut,
                });
            });
        });
    }
}

function pickShell(pref: ShellPreference): 'pwsh' | 'powershell' | 'bash' | 'sh' {
    if (pref !== 'auto') {
        return pref;
    }
    if (os.platform() === 'win32') {
        return 'pwsh';
    }
    return process.env.SHELL?.endsWith('/bash') ? 'bash' : 'sh';
}

function buildInvocation(shell: ReturnType<typeof pickShell>, command: string): ShellInvocation {
    switch (shell) {
        case 'pwsh':
            return {
                file: 'pwsh',
                args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
            };
        case 'powershell':
            return {
                file: 'powershell.exe',
                args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
            };
        case 'bash':
            return { file: 'bash', args: ['-lc', command] };
        case 'sh':
            return { file: 'sh', args: ['-c', command] };
    }
}
