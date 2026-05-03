import { Action } from './actions';
import { QueueWaitInfo } from '../transport/contracts';

/**
 * Output surface for one agent task. AgentLoop writes events here; the UI
 * layer decides how to render them. Decouples the loop from VS Code's chat
 * stream so the same loop can drive a webview, a chat participant, or tests.
 */
export interface AgentSink {
    progress(text: string): void;
    queued(info: QueueWaitInfo): void;
    started(): void;
    assistantChunk(text: string): void;
    assistantThinking(text: string): void;
    planUpdate(plan: string): void;
    actionStarted(action: Action): void;
    actionFinished(summary: string, error: boolean): void;
    /**
     * Free-form markdown notice from the loop (validation errors, hit max
     * iterations, fatal errors). Use sparingly.
     */
    message(markdown: string, tone?: 'info' | 'warn' | 'error'): void;
}

/** No-op sink, useful for tests and non-UI callers. */
export class NullSink implements AgentSink {
    progress(): void {}
    queued(): void {}
    started(): void {}
    assistantChunk(): void {}
    assistantThinking(): void {}
    planUpdate(): void {}
    actionStarted(): void {}
    actionFinished(): void {}
    message(): void {}
}
