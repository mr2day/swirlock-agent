import * as vscode from 'vscode';
import * as os from 'os';
import { ModelHostClient } from '../transport/ModelHostClient';
import { ContextManager } from '../context/ContextManager';
import { PromptAssembler } from '../prompt/PromptAssembler';
import { Plan } from './Plan';
import { parseActions } from './actions';
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
import { AgentSink } from './AgentSink';

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
    sink: AgentSink;
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
 * iterations, cancellation, or fatal error. Writes events to an AgentSink
 * which the UI layer renders however it wants.
 */
export class AgentLoop {
    constructor(private readonly deps: AgentLoopDeps) {}

    updateConfig(config: SwirlockConfig): void {
        (this.deps as { config: SwirlockConfig }).config = config;
    }

    async run(opts: AgentRunOptions): Promise<AgentOutcome> {
        const { task, sink, token, runLog } = opts;
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

                const promptText = request.input.parts
                    .map((p) => (p.type === 'text' ? p.text : `[${p.type}]`))
                    .join('\n');
                await runLog.event('iteration_started', {
                    iteration: iterations,
                    contextTokens: context.totalTokens(),
                    promptChars: promptText.length,
                    prompt: promptText,
                });

                sink.progress(`Iteration ${iterations}…`);

                let modelText = '';

                try {
                    for await (const ev of this.deps.client.stream(request, token, correlationId)) {
                        throwIfCancelled(token);
                        this.handleStreamEvent(ev, sink, (text) => {
                            modelText += text;
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
                        sink.message(`**Model host error:** \`${e.code}\` — ${e.message}`, 'error');
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
                    sink.message(
                        `${parsed.errors.length} action block${parsed.errors.length === 1 ? '' : 's'} failed validation; the model will retry.`,
                        'warn',
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
                    // Model replied with prose only — treat the whole reply as the
                    // final answer. Questions like "are you working?" or "summarise
                    // the codebase" get answered in one iteration without the loop
                    // re-prompting and re-running the model.
                    const summary = stripActionBlocksAndTrim(modelText);
                    await runLog.event('finish_implicit', { summary });
                    return { kind: 'finished', iterations, summary };
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
                        sink.planUpdate(action.plan);
                        await runLog.event('plan_update', { plan: action.plan });
                        continue;
                    }
                    sink.actionStarted(action);
                    const result = await this.deps.registry.execute(action, toolCtx(token));
                    sink.actionFinished(result.summary, result.error ?? false);
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
                    await runLog.event('task_finished', { iterations, summary: sawFinish.summary });
                    return { kind: 'finished', iterations, summary: sawFinish.summary };
                }
            }

            sink.message(
                `Hit max iterations (${this.deps.config.maxIterations}). Stopping. Increase ` +
                    '`swirlock-agent.maxIterations` if the task needs more turns.',
                'warn',
            );
            await runLog.event('task_max_iterations', { iterations });
            return { kind: 'maxIterations', iterations };
        } catch (e) {
            if (e instanceof CancelledError || (e as Error).name === 'CancelledError') {
                await runLog.event('task_cancelled', { iterations });
                return { kind: 'cancelled', iterations };
            }
            const message = e instanceof Error ? e.message : String(e);
            log().error(`Agent loop crashed: ${message}`);
            sink.message(`Agent error: ${message}`, 'error');
            await runLog.event('task_error', { iterations, message });
            return { kind: 'error', iterations, message };
        }
    }

    private handleStreamEvent(ev: StreamEvent, sink: AgentSink, onChunkText: (text: string) => void): void {
        switch (ev.type) {
            case 'accepted':
                return;
            case 'queued':
                sink.queued(ev.data);
                return;
            case 'started':
                sink.started();
                return;
            case 'thinking':
                sink.assistantThinking(ev.data.text);
                return;
            case 'chunk':
                onChunkText(ev.data.text);
                sink.assistantChunk(ev.data.text);
                return;
            case 'done':
                return;
            case 'error':
                throw new ModelHostError(
                    ev.error.code,
                    ev.error.message,
                    ev.error.retryable,
                    ev.error.details,
                    ev.meta.correlationId,
                );
        }
    }
}

function stripActionBlocksAndTrim(text: string): string {
    return text
        .replace(/```action\s*\n[\s\S]*?\n```/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
