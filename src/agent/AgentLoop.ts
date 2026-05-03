import * as vscode from 'vscode';
import * as os from 'os';
import { ModelHostClient } from '../transport/ModelHostClient';
import { ContextManager } from '../context/ContextManager';
import { PromptAssembler } from '../prompt/PromptAssembler';
import { Plan } from './Plan';
import { Action, parseActions } from './actions';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolContext } from '../tools/Tool';
import { PathJail } from '../safety/pathJail';
import { CommandPolicy } from '../safety/commandPolicy';
import { PermissionModeController } from '../safety/permissionMode';
import { RunLogger } from '../ui/RunLogger';
import { SwirlockConfig } from '../config/Config';
import { CancelledError, throwIfCancelled } from '../util/cancellation';
import { uuidv7 } from '../util/uuid';
import { ModelHostError, StreamEvent } from '../transport/contracts';
import { log } from '../util/logger';

export interface AgentLoopDeps {
    client: ModelHostClient;
    registry: ToolRegistry;
    pathJail: PathJail;
    commandPolicy: CommandPolicy;
    permission: PermissionModeController;
    config: SwirlockConfig;
    workspaceRoot: string;
}

export interface AgentRunOptions {
    task: string;
    correlationId?: string;
    response: vscode.ChatResponseStream;
    token: vscode.CancellationToken;
    runLog: RunLogger;
}

export type AgentOutcome =
    | { kind: 'finished'; summary: string; iterations: number }
    | { kind: 'cancelled'; iterations: number }
    | { kind: 'maxIterations'; iterations: number }
    | { kind: 'error'; iterations: number; message: string };

/**
 * Receives a task, drives the model→action→tool loop until finish, max
 * iterations, cancellation, or fatal error. Streams output to the chat
 * response stream as it goes.
 */
export class AgentLoop {
    constructor(private readonly deps: AgentLoopDeps) {}

    async run(opts: AgentRunOptions): Promise<AgentOutcome> {
        const { task, response, token, runLog } = opts;
        const correlationId = opts.correlationId ?? uuidv7();

        const context = new ContextManager();
        const plan = new Plan();
        const assembler = new PromptAssembler(context);

        context.add({
            type: 'task',
            content: task,
            priority: 3,
            pinned: true,
            source: 'user',
        });

        const toolCtx = (innerToken: vscode.CancellationToken): ToolContext => ({
            workspaceRoot: this.deps.workspaceRoot,
            pathJail: this.deps.pathJail,
            commandPolicy: this.deps.commandPolicy,
            permission: this.deps.permission,
            shell: this.deps.config.shell,
            token: innerToken,
        });

        await runLog.event('task_started', {
            correlationId,
            task,
            permissionMode: this.deps.permission.mode,
            maxIterations: this.deps.config.maxIterations,
        });

        let iterations = 0;
        try {
            while (iterations < this.deps.config.maxIterations) {
                throwIfCancelled(token);
                iterations++;

                const request = assembler.assemble({
                    callerService: this.deps.config.host.callerService,
                    priority: this.deps.config.host.priority,
                    budgetTokens: this.deps.config.maxContextTokens,
                    showThinking: this.deps.config.streaming.showThinking,
                    plan,
                    system: {
                        workspaceRoot: this.deps.workspaceRoot,
                        osPlatform: `${os.platform()} ${os.release()}`,
                        shell: this.deps.config.shell,
                        permissionMode: this.deps.permission.mode,
                    },
                });

                await runLog.event('iteration_started', {
                    iteration: iterations,
                    contextTokens: context.totalTokens(),
                    requestPartCount: request.input.parts.length,
                });

                response.progress(`Iteration ${iterations}…`);

                let modelText = '';
                let queuedShown = false;
                let assistantHeadingShown = false;

                try {
                    for await (const ev of this.deps.client.stream(request, token, correlationId)) {
                        throwIfCancelled(token);
                        this.handleStreamEvent(ev, response, {
                            onChunk: (text) => {
                                if (!assistantHeadingShown) {
                                    assistantHeadingShown = true;
                                }
                                modelText += text;
                                response.markdown(text);
                            },
                            onQueued: (info) => {
                                if (!queuedShown) {
                                    queuedShown = true;
                                }
                                response.progress(
                                    `Queued at position ${info.position} (${info.requestsAhead} ahead)…`,
                                );
                            },
                            onThinking: (text) => {
                                if (this.deps.config.streaming.showThinking) {
                                    response.markdown(`\n> _${escapeMd(text)}_\n`);
                                }
                            },
                            onStarted: () => {
                                response.progress('Generating…');
                            },
                            onError: (err) => {
                                throw err;
                            },
                        });
                    }
                } catch (e) {
                    if (e instanceof CancelledError) {
                        throw e;
                    }
                    if (e instanceof ModelHostError) {
                        await runLog.event('iteration_error', {
                            iteration: iterations,
                            code: e.code,
                            message: e.message,
                        });
                        response.markdown(`\n\n**Model host error:** \`${e.code}\` — ${e.message}\n`);
                        return { kind: 'error', iterations, message: `${e.code}: ${e.message}` };
                    }
                    throw e;
                }

                await runLog.event('iteration_response', {
                    iteration: iterations,
                    chars: modelText.length,
                });

                context.add({
                    type: 'assistant',
                    content: modelText,
                    priority: 1,
                    source: `iter ${iterations}`,
                });

                const parsed = parseActions(modelText);

                if (parsed.errors.length > 0) {
                    const summary = parsed.errors
                        .map((e) => `Action #${e.index}: ${e.message}\nRaw:\n${e.raw}`)
                        .join('\n---\n');
                    response.markdown(
                        `\n\n_${parsed.errors.length} action block${parsed.errors.length === 1 ? '' : 's'} failed validation; the model will retry._\n`,
                    );
                    context.add({
                        type: 'error',
                        priority: 3,
                        content:
                            `One or more action blocks in your previous reply failed validation. ` +
                            `Re-emit them in valid form. Errors:\n${summary}`,
                        source: `iter ${iterations}`,
                    });
                    await runLog.event('action_parse_errors', {
                        iteration: iterations,
                        errors: parsed.errors,
                    });
                }

                if (parsed.actions.length === 0 && parsed.errors.length === 0) {
                    context.add({
                        type: 'system',
                        priority: 3,
                        content:
                            'Your previous reply contained no action blocks. Either emit at least one ' +
                            '`action` block or a `finish` action. Plain prose without an action is not ' +
                            'progress.',
                    });
                    response.markdown(
                        `\n\n_No actions emitted this turn; prompting the model to act._\n`,
                    );
                    continue;
                }

                let sawFinish: { summary: string } | null = null;
                for (const action of parsed.actions) {
                    throwIfCancelled(token);
                    if (action.type === 'finish') {
                        sawFinish = { summary: action.summary };
                        await runLog.event('finish', { summary: action.summary });
                        break;
                    }
                    if (action.type === 'update_plan') {
                        plan.set(action.plan);
                        response.markdown(`\n\n**Plan updated.**\n\n${action.plan}\n`);
                        await runLog.event('plan_update', { plan: action.plan });
                        continue;
                    }
                    response.markdown(`\n\n${actionHeader(action)}\n`);
                    const result = await this.deps.registry.execute(action, toolCtx(token));
                    response.markdown(
                        result.error
                            ? `> ❌ ${escapeMd(result.summary)}\n`
                            : `> ✓ ${escapeMd(result.summary)}\n`,
                    );
                    await runLog.event('tool_result', {
                        iteration: iterations,
                        action,
                        summary: result.summary,
                        truncated: result.truncated ?? false,
                        error: result.error ?? false,
                    });
                    context.add({
                        type: 'tool_result',
                        priority: result.error ? 3 : 2,
                        content: result.output,
                        source: action.type,
                    });
                }

                if (sawFinish) {
                    response.markdown(`\n\n**Done.** ${sawFinish.summary}\n`);
                    await runLog.event('task_finished', { iterations, summary: sawFinish.summary });
                    return { kind: 'finished', iterations, summary: sawFinish.summary };
                }
            }

            response.markdown(
                `\n\n**Hit max iterations (${this.deps.config.maxIterations}).** Stopping. Increase ` +
                    '`swirlock-agent.maxIterations` if the task needs more turns.\n',
            );
            await runLog.event('task_max_iterations', { iterations });
            return { kind: 'maxIterations', iterations };
        } catch (e) {
            if (e instanceof CancelledError || (e as Error).name === 'CancelledError') {
                response.markdown(`\n\n**Cancelled.**\n`);
                await runLog.event('task_cancelled', { iterations });
                return { kind: 'cancelled', iterations };
            }
            const message = e instanceof Error ? e.message : String(e);
            log().error(`Agent loop crashed: ${message}`);
            response.markdown(`\n\n**Agent error:** ${escapeMd(message)}\n`);
            await runLog.event('task_error', { iterations, message });
            return { kind: 'error', iterations, message };
        }
    }

    private handleStreamEvent(
        ev: StreamEvent,
        _response: vscode.ChatResponseStream,
        h: {
            onChunk: (text: string) => void;
            onQueued: (info: import('../transport/contracts').QueueWaitInfo) => void;
            onThinking: (text: string) => void;
            onStarted: () => void;
            onError: (err: Error) => void;
        },
    ): void {
        switch (ev.type) {
            case 'accepted':
                return;
            case 'queued':
                h.onQueued(ev.data);
                return;
            case 'started':
                h.onStarted();
                return;
            case 'thinking':
                h.onThinking(ev.data.text);
                return;
            case 'chunk':
                h.onChunk(ev.data.text);
                return;
            case 'done':
                return;
            case 'error':
                h.onError(
                    new ModelHostError(
                        ev.error.code,
                        ev.error.message,
                        ev.error.retryable,
                        ev.error.details,
                        ev.meta.correlationId,
                    ),
                );
                return;
        }
    }
}

function actionHeader(a: Action): string {
    switch (a.type) {
        case 'read_file':
            return `🔍 read \`${a.path}\``;
        case 'write_file':
            return `✏️ write \`${a.path}\``;
        case 'edit_file':
            return `✏️ edit \`${a.path}\``;
        case 'list_dir':
            return `📂 list \`${a.path}\``;
        case 'search':
            return `🔎 search \`${a.query}\`${a.glob ? ` in \`${a.glob}\`` : ''}`;
        case 'run_command':
            return `🖥 run \`${a.command}\``;
        case 'git':
            return `🔧 git \`${a.args.join(' ')}\``;
        default:
            return `• ${a.type}`;
    }
}

function escapeMd(s: string): string {
    return s.replace(/\*/g, '\\*').replace(/_/g, '\\_').replace(/`/g, '\\`');
}
