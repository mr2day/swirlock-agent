import * as vscode from 'vscode';
import { AgentLoop } from '../agent/AgentLoop';
import { RunLogger, trackLog } from './RunLogger';
import { uuidv7 } from '../util/uuid';
import { readConfig } from '../config/Config';

export interface ChatParticipantDeps {
    loop: AgentLoop;
    workspaceRoot: string;
    /** Provides the active task's cancellation source so /stop can hit it. */
    setActiveCancellation(source: vscode.CancellationTokenSource | null): void;
}

export function registerChatParticipant(deps: ChatParticipantDeps): vscode.Disposable {
    const handler: vscode.ChatRequestHandler = async (request, _ctx, response, token) => {
        const task = request.prompt.trim();
        if (!task) {
            response.markdown(
                '_Type a task after `@swirlock`. For example: `@swirlock add tests for src/utils/uuid.ts`._',
            );
            return {};
        }

        const config = readConfig();
        const correlationId = uuidv7();
        const runLog = new RunLogger({
            enabled: config.runLog.enabled,
            workspaceRoot: deps.workspaceRoot,
            correlationId,
        });
        trackLog(runLog);

        // Composite cancellation source: chat token + manual stop command.
        const stopSource = new vscode.CancellationTokenSource();
        deps.setActiveCancellation(stopSource);
        const tokenSub = token.onCancellationRequested(() => stopSource.cancel());

        response.progress(`Starting task (correlation ${correlationId.slice(0, 8)}…)`);

        try {
            const outcome = await deps.loop.run({
                task,
                correlationId,
                response,
                token: stopSource.token,
                runLog,
            });
            return {
                metadata: {
                    correlationId,
                    outcome: outcome.kind,
                    iterations: outcome.iterations,
                },
            };
        } finally {
            tokenSub.dispose();
            deps.setActiveCancellation(null);
            stopSource.dispose();
        }
    };

    const participant = vscode.chat.createChatParticipant('swirlock-agent.chat', handler);
    participant.iconPath = new vscode.ThemeIcon('rocket');
    participant.followupProvider = {
        provideFollowups(result) {
            const meta = result.metadata as Record<string, unknown> | undefined;
            const outcome = meta?.outcome;
            if (outcome === 'maxIterations') {
                return [
                    {
                        label: 'Continue from where it stopped',
                        prompt: 'Continue the previous task. The plan is preserved in your workspace .swirlock/runs log.',
                    },
                ];
            }
            if (outcome === 'error') {
                return [
                    {
                        label: 'Show model status',
                        prompt: 'Show the swirlock model host status',
                        command: 'swirlock-agent.showStatus',
                    },
                ];
            }
            return [];
        },
    };

    return participant;
}
