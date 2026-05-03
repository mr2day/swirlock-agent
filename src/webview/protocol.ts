/**
 * Wire protocol between the extension host and the agent webview.
 * Imported by both sides; do not import VS Code or DOM types here.
 */

import type { Action } from '../agent/actions';
import type { QueueWaitInfo } from '../transport/contracts';

export type PermissionMode = 'normal' | 'bypass';

export type HostState =
    | { state: 'unknown' }
    | { state: 'unreachable'; message: string }
    | { state: 'ok'; modelId: string; ready: boolean; loaded: boolean; queueDepth: number };

// ----- extension → webview ------------------------------------------------

export type ExtensionMessage =
    | { type: 'init'; payload: InitPayload }
    | { type: 'host_status'; payload: HostState }
    | { type: 'permission_mode'; payload: PermissionMode }
    | { type: 'task_started'; payload: { taskId: string; prompt: string; correlationId: string } }
    | { type: 'progress'; payload: { taskId: string; text: string } }
    | { type: 'queued'; payload: { taskId: string; info: QueueWaitInfo } }
    | { type: 'assistant_chunk'; payload: { taskId: string; text: string } }
    | { type: 'assistant_thinking'; payload: { taskId: string; text: string } }
    | { type: 'plan_update'; payload: { taskId: string; plan: string } }
    | { type: 'action_started'; payload: { taskId: string; action: Action } }
    | { type: 'action_finished'; payload: { taskId: string; summary: string; error: boolean } }
    | { type: 'task_finished'; payload: { taskId: string; outcome: TaskOutcome } }
    | { type: 'system_message'; payload: { taskId?: string; markdown: string; tone?: 'info' | 'warn' | 'error' } };

export interface InitPayload {
    permissionMode: PermissionMode;
    hostStatus: HostState;
    runLogPath?: string;
}

export type TaskOutcome =
    | { kind: 'finished'; summary: string; iterations: number }
    | { kind: 'cancelled'; iterations: number }
    | { kind: 'maxIterations'; iterations: number }
    | { kind: 'error'; iterations: number; message: string };

// ----- webview → extension ------------------------------------------------

export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'submit'; payload: { prompt: string } }
    | { type: 'stop' }
    | { type: 'toggle_permission_mode' }
    | { type: 'preload_model' }
    | { type: 'show_status' }
    | { type: 'open_run_log' }
    | { type: 'clear_conversation' }
    | { type: 'refresh_host' };
