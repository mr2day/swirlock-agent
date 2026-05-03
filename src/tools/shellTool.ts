import * as vscode from 'vscode';
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

        if (action.background) {
            return this.runInTerminal(action, cwd);
        }

        const shell = pickShell(ctx.shell);
        const invocation = buildInvocation(shell, action.command);
        // 10 minutes default for foreground commands; long enough for builds and
        // test suites without holding the loop forever. Use background:true for
        // anything that genuinely runs indefinitely.
        const timeout = action.timeoutMs ?? 600_000;

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
                      ? `killed (timeout ${timeout}ms — use background:true for long-running commands)`
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

    private async runInTerminal(action: RunCommandAction, cwd: string): Promise<ToolResult> {
        const name = `Swirlock: ${action.command.slice(0, 30)}${action.command.length > 30 ? '…' : ''}`;
        const terminal = vscode.window.createTerminal({ name, cwd });
        terminal.show(true);
        terminal.sendText(action.command, true);
        const summary = `started in terminal "${name}" (background)`;
        const output =
            `$ ${action.command}\n` +
            `cwd: ${cwd}\n` +
            `mode: background\n` +
            `Process started in a VS Code terminal. The user can see its output ` +
            `in the terminal panel. Subsequent run_command actions can run while ` +
            `this process keeps running.`;
        return { summary, output };
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
