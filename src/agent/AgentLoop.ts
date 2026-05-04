import * as vscode from 'vscode';
import * as os from 'os';
import { ModelHostClient } from '../transport/ModelHostClient';
import { ContextManager } from '../context/ContextManager';
import { PromptAssembler, StaticContext } from '../prompt/PromptAssembler';
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
import { AgentSink, NullSink } from './AgentSink';
import { WorkingState } from './WorkingState';
import { Compactor } from './Compactor';
import { loadProjectMemory } from '../static/ProjectMemory';
import { generateRepoMap } from '../static/RepoMap';

const TEXT_DECODER = new TextDecoder('utf-8');

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
    /** Long-lived rolling transcript. Caller owns it across turns. */
    context: ContextManager;
    /** Long-lived working state (plan, todos, active files). */
    workingState: WorkingState;
    correlationId?: string;
    sink: AgentSink;
    token: vscode.CancellationToken;
    runLog: RunLogger;
    /** Set when this run is itself a child of another run (delegate action). */
    isDelegate?: boolean;
}

export type AgentOutcome =
    | { kind: 'finished'; summary: string; iterations: number }
    | { kind: 'cancelled'; iterations: number }
    | { kind: 'maxIterations'; iterations: number }
    | { kind: 'error'; iterations: number; message: string };

/**
 * The agent loop. Stateless wrt session — caller passes in the
 * ContextManager and WorkingState that should persist across turns.
 *
 * Each iteration:
 *   1. Assemble a three-tier prompt (static + working + transcript)
 *   2. Stream model output, collect chunks, surface via sink
 *   3. Parse fenced action blocks
 *   4. Execute non-finish actions; route file results to ActiveFiles,
 *      dedupe other tool results, mark stale on edits
 *   5. After execution, run the Compactor if the transcript is over budget
 *
 * Auto-finish: an iteration that produces no actions and no parse errors
 * is treated as a finish with the model's reply as the summary.
 */
export class AgentLoop {
    private compactor: Compactor;

    constructor(private readonly deps: AgentLoopDeps) {
        this.compactor = new Compactor(deps.client, {
            callerService: deps.config.host.callerService,
            priority: 0,
        });
    }

    updateConfig(config: SwirlockConfig): void {
        (this.deps as { config: SwirlockConfig }).config = config;
        this.compactor = new Compactor(this.deps.client, {
            callerService: config.host.callerService,
            priority: 0,
        });
    }

    async run(opts: AgentRunOptions): Promise<AgentOutcome> {
        const { task, context, workingState, sink, token, runLog } = opts;
        const correlationId = opts.correlationId ?? uuidv7();
        const assembler = new PromptAssembler(context);

        // Demote the previous user task so the new one occupies the pinned slot.
        context.demoteOldTasks();
        context.add({
            type: 'task',
            content: task,
            priority: 3,
            pinned: true,
            source: opts.isDelegate ? 'delegate' : 'user',
        });

        await runLog.event('task_started', {
            correlationId,
            task,
            isDelegate: opts.isDelegate ?? false,
            permissionMode: this.deps.permission.mode,
            maxIterations: this.deps.config.maxIterations,
        });

        // Tier 1: rebuilt every turn so manual edits to AGENT.md and new files
        // appear immediately. Cancellation-safe.
        const buildStatic = async (): Promise<StaticContext> => ({
            projectMemory: await loadProjectMemory(
                this.deps.workspaceRoot,
                this.deps.config.budgets.projectMemoryTokens,
            ),
            repoMap: await generateRepoMap(
                this.deps.workspaceRoot,
                this.deps.config.budgets.repoMapTokens,
                token,
            ),
        });

        const toolCtx = (innerToken: vscode.CancellationToken): ToolContext => ({
            workspaceRoot: this.deps.workspaceRoot,
            pathJail: this.deps.pathJail,
            commandPolicy: this.deps.commandPolicy,
            permission: this.deps.permission,
            shell: this.deps.config.shell,
            token: innerToken,
        });

        let iterations = 0;
        try {
            while (iterations < this.deps.config.maxIterations) {
                throwIfCancelled(token);
                iterations++;

                const staticCtx = await buildStatic();
                const request = assembler.assemble({
                    callerService: this.deps.config.host.callerService,
                    priority: this.deps.config.host.priority,
                    showThinking: this.deps.config.streaming.showThinking,
                    working: workingState,
                    static: staticCtx,
                    budgets: this.deps.config.budgets,
                    totalBudget: this.deps.config.maxContextTokens,
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
                        workingState.plan.set(action.plan);
                        sink.planUpdate(action.plan);
                        await runLog.event('plan_update', { plan: action.plan });
                        continue;
                    }
                    if (action.type === 'update_todos') {
                        const next = workingState.todos.replace(action.todos);
                        sink.message(
                            `TODOs updated (${next.length} item${next.length === 1 ? '' : 's'}).`,
                            'info',
                        );
                        await runLog.event('todos_update', { todos: next });
                        continue;
                    }
                    if (action.type === 'delegate') {
                        sink.actionStarted(action);
                        const result = await this.runDelegate(action, sink, token, runLog);
                        sink.actionFinished(result.summary, result.error);
                        await runLog.event('delegate_result', {
                            iteration: iterations,
                            task: action.task,
                            scope: action.scope,
                            summary: result.summary,
                            error: result.error,
                        });
                        context.add({
                            type: 'tool_result',
                            priority: 2,
                            content: `Delegate task: ${action.task}${
                                action.scope ? `\nScope: ${action.scope}` : ''
                            }\n---\n${result.summary}`,
                            source: 'delegate',
                        });
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

                    // Route results to the appropriate tier and apply
                    // deterministic compaction (dedup / staleness markers).
                    await this.fileToolResult(action, result.output, result.error ?? false, iterations, context, workingState);
                }

                if (sawFinish) {
                    await runLog.event('task_finished', { iterations, summary: sawFinish.summary });
                    return { kind: 'finished', iterations, summary: sawFinish.summary };
                }

                // Run LLM-based compaction if the rolling transcript is over
                // its sub-budget. Best-effort; deterministic compaction has
                // already done most of the work.
                const transcriptBudget = assembler.transcriptBudget({
                    callerService: this.deps.config.host.callerService,
                    priority: this.deps.config.host.priority,
                    showThinking: this.deps.config.streaming.showThinking,
                    working: workingState,
                    static: staticCtx,
                    budgets: this.deps.config.budgets,
                    totalBudget: this.deps.config.maxContextTokens,
                    system: {
                        workspaceRoot: this.deps.workspaceRoot,
                        osPlatform: `${os.platform()} ${os.release()}`,
                        shell: this.deps.config.shell,
                        permissionMode: this.deps.permission.mode,
                    },
                });
                const compacted = await this.compactor.maybeCompact(
                    context,
                    transcriptBudget,
                    this.deps.config.budgets.compactionThreshold,
                    this.deps.config.budgets.keepRecentTurns,
                    token,
                );
                if (compacted) {
                    sink.message('History compacted to fit budget.', 'info');
                    await runLog.event('compaction', { contextTokens: context.totalTokens() });
                }
                context.purgeObsolete();
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

    /**
     * Move tool results into the right tier:
     *   - read_file → ActiveFiles (Tier 2)
     *   - write_file / edit_file → ActiveFiles + mark prior reads stale
     *   - list_dir / search / git → transcript with dedup key
     *   - run_command → transcript (no dedup; same command can have new output)
     */
    private async fileToolResult(
        action: Action,
        output: string,
        error: boolean,
        iter: number,
        context: ContextManager,
        ws: WorkingState,
    ): Promise<void> {
        switch (action.type) {
            case 'read_file': {
                if (!error) {
                    const content = await this.readFileFresh(action.path);
                    if (content !== null) {
                        ws.activeFiles.markRead(action.path, content, iter);
                    }
                }
                // Don't add to transcript — Tier 2 carries the content.
                return;
            }
            case 'write_file': {
                if (!error) {
                    ws.activeFiles.markWritten(action.path, action.content, iter);
                    context.markStale(
                        (e) =>
                            e.dedupKey === `read_file:${action.path}` ||
                            e.dedupKey === `edit_file:${action.path}`,
                        `${action.path} was written at iter ${iter}`,
                    );
                }
                context.add({
                    type: 'tool_result',
                    priority: 2,
                    content: `write_file ${action.path}: ${error ? 'FAILED' : 'ok'} (${action.content.length} chars)`,
                    source: 'write_file',
                    dedupKey: `write_file:${action.path}`,
                });
                return;
            }
            case 'edit_file': {
                if (!error) {
                    const content = await this.readFileFresh(action.path);
                    if (content !== null) {
                        ws.activeFiles.markEdited(action.path, content, iter);
                    }
                    context.markStale(
                        (e) => e.dedupKey === `read_file:${action.path}`,
                        `${action.path} was edited at iter ${iter}`,
                    );
                }
                context.add({
                    type: 'tool_result',
                    priority: 2,
                    content: `edit_file ${action.path}: ${error ? 'FAILED' : 'ok'}`,
                    source: 'edit_file',
                    dedupKey: `edit_file:${action.path}`,
                });
                return;
            }
            case 'list_dir':
                context.add({
                    type: 'tool_result',
                    priority: 2,
                    content: output,
                    source: 'list_dir',
                    dedupKey: `list_dir:${action.path}`,
                });
                return;
            case 'search':
                context.add({
                    type: 'tool_result',
                    priority: 2,
                    content: output,
                    source: 'search',
                    dedupKey: `search:${action.query}|${action.glob ?? '*'}`,
                });
                return;
            case 'git':
                context.add({
                    type: 'tool_result',
                    priority: 2,
                    content: output,
                    source: 'git',
                    dedupKey: `git:${action.args.join(' ')}`,
                });
                return;
            case 'run_command':
                context.add({
                    type: 'tool_result',
                    priority: error ? 3 : 2,
                    content: output,
                    source: 'run_command',
                });
                return;
            default:
                // Other actions (update_plan, update_todos, delegate, finish) are
                // handled directly in the loop and don't produce tool results here.
                return;
        }
    }

    /**
     * Spawn a child AgentLoop with isolated context for big subtasks. Only the
     * child's finish summary is returned; intermediate steps don't pollute the
     * parent's context.
     */
    private async runDelegate(
        action: { task: string; scope?: string },
        parentSink: AgentSink,
        token: vscode.CancellationToken,
        runLog: RunLogger,
    ): Promise<{ summary: string; error: boolean }> {
        const childContext = new ContextManager();
        const childWorkingState = new WorkingState();
        const childTask = action.scope
            ? `${action.task}\n\nScope: ${action.scope}`
            : action.task;
        const childCorrelationId = uuidv7();
        parentSink.message(`Delegating: ${action.task.slice(0, 120)}…`, 'info');
        const outcome = await this.run({
            task: childTask,
            context: childContext,
            workingState: childWorkingState,
            sink: new NullSink(),
            token,
            runLog,
            correlationId: childCorrelationId,
            isDelegate: true,
        });
        switch (outcome.kind) {
            case 'finished':
                return { summary: outcome.summary, error: false };
            case 'cancelled':
                return { summary: '[delegate cancelled]', error: true };
            case 'maxIterations':
                return { summary: `[delegate hit max iterations after ${outcome.iterations} turns]`, error: true };
            case 'error':
                return { summary: `[delegate error: ${outcome.message}]`, error: true };
        }
    }

    private async readFileFresh(relPath: string): Promise<string | null> {
        try {
            const abs = await this.deps.pathJail.realResolve(relPath);
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
            return TEXT_DECODER.decode(bytes);
        } catch {
            return null;
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
