/* Webview-side controller for the Swirlock agent panel.
 *
 * Runs in the VS Code webview sandbox (browser-like). Renders messages,
 * streams assistant chunks, shows tool actions, and posts user input back
 * to the extension host. Markdown is rendered with `marked`.
 */

import { marked } from 'marked';
import type { Action } from '../agent/actions';
import type {
    ExtensionMessage,
    HostState,
    InitPayload,
    PermissionMode,
    TaskOutcome,
    WebviewMessage,
} from './protocol';

declare function acquireVsCodeApi(): {
    postMessage(msg: WebviewMessage): void;
    setState(state: unknown): void;
    getState(): unknown;
};

const vscode = acquireVsCodeApi();

marked.setOptions({ gfm: true, breaks: false });

// ---------- DOM refs ------------------------------------------------------

const $ = <T extends HTMLElement>(sel: string): T => {
    const el = document.querySelector<T>(sel);
    if (!el) {
        throw new Error(`Missing element ${sel}`);
    }
    return el;
};

const messagesEl = $<HTMLElement>('#messages');
const inputEl = $<HTMLTextAreaElement>('#input');
const sendBtn = $<HTMLButtonElement>('#send-btn');
const stopBtn = $<HTMLButtonElement>('#stop-btn');
const hostPill = $<HTMLElement>('#host-status');
const modePill = $<HTMLElement>('#mode-badge');
const planBar = $<HTMLElement>('#plan-bar');
const planContent = $<HTMLElement>('#plan-content');
const preloadBtn = $<HTMLButtonElement>('#preload-btn');
const statusBtn = $<HTMLButtonElement>('#status-btn');
const logBtn = $<HTMLButtonElement>('#log-btn');
const clearBtn = $<HTMLButtonElement>('#clear-btn');
const modeBtn = $<HTMLButtonElement>('#mode-btn');

// ---------- task state ----------------------------------------------------

interface ActiveTask {
    id: string;
    raw: string;
    bodyEl: HTMLElement;
    actionsEl: HTMLElement;
    pendingActionsByKey: Map<string, HTMLElement>;
}

let activeTask: ActiveTask | null = null;

// ---------- helpers -------------------------------------------------------

function post(msg: WebviewMessage): void {
    vscode.postMessage(msg);
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function renderMarkdown(md: string): string {
    try {
        const result = marked.parse(md);
        return typeof result === 'string' ? result : '';
    } catch {
        return `<pre>${escapeHtml(md)}</pre>`;
    }
}

function scrollToBottom(): void {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearEmptyState(): void {
    const empty = messagesEl.querySelector('.empty');
    if (empty) {
        empty.remove();
    }
}

function showEmptyState(): void {
    messagesEl.innerHTML =
        '<div class="empty">' +
        'Ask Swirlock to do something in your workspace.<br/>' +
        'Press <kbd>Enter</kbd> to send, <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline.' +
        '</div>';
}

function appendUserMessage(text: string): void {
    clearEmptyState();
    const msg = document.createElement('div');
    msg.className = 'msg msg-user';
    msg.innerHTML = `<div class="msg-header">You</div><div class="msg-body">${renderMarkdown(text)}</div>`;
    messagesEl.appendChild(msg);
    scrollToBottom();
}

function appendSystemMessage(markdown: string, tone: 'info' | 'warn' | 'error' = 'info'): void {
    clearEmptyState();
    const msg = document.createElement('div');
    msg.className = `msg msg-system tone-${tone}`;
    msg.innerHTML = `<div class="msg-header">Swirlock</div><div class="msg-body">${renderMarkdown(markdown)}</div>`;
    messagesEl.appendChild(msg);
    scrollToBottom();
}

function startAssistantBubble(taskId: string): void {
    clearEmptyState();
    const msg = document.createElement('div');
    msg.className = 'msg msg-assistant';
    msg.dataset.taskId = taskId;
    msg.innerHTML =
        '<div class="msg-header">Swirlock</div>' +
        '<div class="msg-body"></div>' +
        '<div class="actions"></div>';
    messagesEl.appendChild(msg);
    activeTask = {
        id: taskId,
        raw: '',
        bodyEl: msg.querySelector('.msg-body') as HTMLElement,
        actionsEl: msg.querySelector('.actions') as HTMLElement,
        pendingActionsByKey: new Map(),
    };
    scrollToBottom();
}

function appendAssistantChunk(taskId: string, text: string): void {
    if (!activeTask || activeTask.id !== taskId) {
        startAssistantBubble(taskId);
    }
    activeTask!.raw += text;
    activeTask!.bodyEl.innerHTML = renderMarkdown(stripActionBlocks(activeTask!.raw));
    scrollToBottom();
}

function appendThinking(taskId: string, text: string): void {
    if (!activeTask || activeTask.id !== taskId) {
        return;
    }
    const node = document.createElement('div');
    node.className = 'thinking';
    node.textContent = text;
    activeTask.bodyEl.appendChild(node);
    scrollToBottom();
}

function appendQueued(taskId: string, position: number, requestsAhead: number, eta?: number): void {
    if (!activeTask || activeTask.id !== taskId) {
        return;
    }
    const node = document.createElement('div');
    node.className = 'queued';
    const etaText = eta ? ` ~${Math.round(eta / 1000)}s` : '';
    node.textContent = `Queued at position ${position} (${requestsAhead} ahead)${etaText}`;
    activeTask.bodyEl.appendChild(node);
    scrollToBottom();
}

function appendActionStarted(taskId: string, action: Action): void {
    if (!activeTask || activeTask.id !== taskId) {
        startAssistantBubble(taskId);
    }
    const key = `${action.type}:${actionLabel(action)}`;
    const node = document.createElement('div');
    node.className = 'action pending';
    node.innerHTML = `
      <span class="icon">${actionIcon(action)}</span>
      <span class="label">${escapeHtml(actionLabel(action))}</span>
      <span class="status">running…</span>
    `;
    activeTask!.actionsEl.appendChild(node);
    activeTask!.pendingActionsByKey.set(key, node);
    scrollToBottom();
}

function appendActionFinished(taskId: string, summary: string, error: boolean): void {
    if (!activeTask || activeTask.id !== taskId) {
        return;
    }
    // Find the most recent still-pending action node and resolve it.
    const pending = activeTask.actionsEl.querySelector('.action.pending');
    if (pending) {
        pending.classList.remove('pending');
        pending.classList.add(error ? 'fail' : 'ok');
        const status = pending.querySelector('.status');
        if (status) {
            status.textContent = error ? 'failed' : 'done';
            status.setAttribute('title', summary);
        }
        const labelEl = pending.querySelector('.label');
        if (labelEl) {
            labelEl.textContent = summary;
        }
    } else {
        const node = document.createElement('div');
        node.className = `action ${error ? 'fail' : 'ok'}`;
        node.innerHTML = `<span class="icon">${error ? '✗' : '✓'}</span><span class="label">${escapeHtml(summary)}</span>`;
        activeTask.actionsEl.appendChild(node);
    }
    scrollToBottom();
}

function showPlan(plan: string): void {
    if (!plan.trim()) {
        planBar.classList.add('hidden');
        return;
    }
    planContent.innerHTML = renderMarkdown(plan);
    planBar.classList.remove('hidden');
    const details = planBar.querySelector('details');
    if (details) {
        details.open = true;
    }
}

function showOutcome(taskId: string, outcome: TaskOutcome): void {
    activeTask = null;
    setRunning(false);
    let tone: 'info' | 'warn' | 'error' = 'info';
    let text = '';
    switch (outcome.kind) {
        case 'finished':
            text = `**Done** in ${outcome.iterations} iteration${outcome.iterations === 1 ? '' : 's'}. ${outcome.summary}`;
            tone = 'info';
            break;
        case 'cancelled':
            text = `**Cancelled** after ${outcome.iterations} iteration${outcome.iterations === 1 ? '' : 's'}.`;
            tone = 'warn';
            break;
        case 'maxIterations':
            text = `**Stopped at max iterations (${outcome.iterations}).** Increase \`swirlock-agent.maxIterations\` if needed.`;
            tone = 'warn';
            break;
        case 'error':
            text = `**Error** after ${outcome.iterations} iteration${outcome.iterations === 1 ? '' : 's'}: ${outcome.message}`;
            tone = 'error';
            break;
    }
    appendSystemMessage(text, tone);
    void taskId;
}

function setRunning(running: boolean): void {
    sendBtn.disabled = running;
    inputEl.disabled = running;
    stopBtn.classList.toggle('hidden', !running);
    if (!running) {
        inputEl.focus();
    }
}

function setHostStatus(state: HostState): void {
    hostPill.classList.remove('warn', 'error');
    if (state.state === 'unknown') {
        hostPill.textContent = '○ checking…';
    } else if (state.state === 'unreachable') {
        hostPill.textContent = '○ unreachable';
        hostPill.classList.add('error');
        hostPill.title = state.message;
    } else {
        hostPill.textContent = state.loaded && state.ready
            ? `● ${state.modelId}`
            : state.loaded
              ? `◐ warming ${state.modelId}`
              : `◯ not loaded`;
        hostPill.title = `Model ${state.modelId}\nready=${state.ready} loaded=${state.loaded}\nqueue=${state.queueDepth}`;
        if (!state.loaded || !state.ready) {
            hostPill.classList.add('warn');
        }
    }
}

function setMode(mode: PermissionMode): void {
    modePill.classList.remove('warn');
    if (mode === 'normal') {
        modePill.textContent = '🛡 normal';
    } else {
        modePill.textContent = '⚡ bypass';
        modePill.classList.add('warn');
    }
}

function clearConversation(): void {
    showEmptyState();
    activeTask = null;
    planBar.classList.add('hidden');
    planContent.innerHTML = '';
}

// ---------- action labels -------------------------------------------------

function actionLabel(a: Action): string {
    switch (a.type) {
        case 'read_file':   return `read ${a.path}`;
        case 'write_file':  return `write ${a.path}`;
        case 'edit_file':   return `edit ${a.path}`;
        case 'list_dir':    return `list ${a.path || '.'}`;
        case 'search':      return `search ${a.query}${a.glob ? ' in ' + a.glob : ''}`;
        case 'run_command': return a.command;
        case 'git':         return `git ${a.args.join(' ')}`;
        default:            return (a as { type: string }).type;
    }
}

function actionIcon(a: Action): string {
    switch (a.type) {
        case 'read_file':   return '🔍';
        case 'write_file':  return '✏️';
        case 'edit_file':   return '✏️';
        case 'list_dir':    return '📂';
        case 'search':      return '🔎';
        case 'run_command': return '🖥';
        case 'git':         return '🔧';
        default:            return '•';
    }
}

/**
 * Hide ` ```action ` blocks from the rendered prose; they're shown in the
 * actions strip below the bubble.
 */
function stripActionBlocks(md: string): string {
    return md.replace(/```action\s*\n[\s\S]*?\n```/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- input ---------------------------------------------------------

function submit(): void {
    const text = inputEl.value.trim();
    if (!text) {
        return;
    }
    inputEl.value = '';
    autosizeInput();
    appendUserMessage(text);
    setRunning(true);
    post({ type: 'submit', payload: { prompt: text } });
}

function autosizeInput(): void {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

inputEl.addEventListener('input', autosizeInput);
inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
    }
});

sendBtn.addEventListener('click', submit);
stopBtn.addEventListener('click', () => post({ type: 'stop' }));
modeBtn.addEventListener('click', () => post({ type: 'toggle_permission_mode' }));
preloadBtn.addEventListener('click', () => post({ type: 'preload_model' }));
statusBtn.addEventListener('click', () => post({ type: 'show_status' }));
logBtn.addEventListener('click', () => post({ type: 'open_run_log' }));
clearBtn.addEventListener('click', () => {
    clearConversation();
    post({ type: 'clear_conversation' });
});

// ---------- inbound messages ---------------------------------------------

window.addEventListener('message', (ev: MessageEvent<ExtensionMessage>) => {
    const msg = ev.data;
    switch (msg.type) {
        case 'init':
            handleInit(msg.payload);
            return;
        case 'host_status':
            setHostStatus(msg.payload);
            return;
        case 'permission_mode':
            setMode(msg.payload);
            return;
        case 'task_started':
            startAssistantBubble(msg.payload.taskId);
            return;
        case 'progress':
            // progress is shown implicitly by streaming; ignore for now
            return;
        case 'queued':
            appendQueued(
                msg.payload.taskId,
                msg.payload.info.position,
                msg.payload.info.requestsAhead,
                msg.payload.info.estimatedWaitMs,
            );
            return;
        case 'assistant_chunk':
            appendAssistantChunk(msg.payload.taskId, msg.payload.text);
            return;
        case 'assistant_thinking':
            appendThinking(msg.payload.taskId, msg.payload.text);
            return;
        case 'plan_update':
            showPlan(msg.payload.plan);
            return;
        case 'action_started':
            appendActionStarted(msg.payload.taskId, msg.payload.action);
            return;
        case 'action_finished':
            appendActionFinished(msg.payload.taskId, msg.payload.summary, msg.payload.error);
            return;
        case 'task_finished':
            showOutcome(msg.payload.taskId, msg.payload.outcome);
            return;
        case 'system_message':
            appendSystemMessage(msg.payload.markdown, msg.payload.tone ?? 'info');
            return;
    }
});

function handleInit(payload: InitPayload): void {
    setMode(payload.permissionMode);
    setHostStatus(payload.hostStatus);
    showEmptyState();
}

// ---------- bootstrap -----------------------------------------------------

showEmptyState();
post({ type: 'ready' });
inputEl.focus();
