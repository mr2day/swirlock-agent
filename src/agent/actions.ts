/**
 * Single source of truth for the action protocol the model emits.
 *
 * Keep types, validators, and the human-readable schema doc in sync — they
 * are referenced by the system prompt, the parser, and the agent loop.
 */

export interface ReadFileAction {
    type: 'read_file';
    path: string;
}
export interface WriteFileAction {
    type: 'write_file';
    path: string;
    content: string;
}
export interface EditFileAction {
    type: 'edit_file';
    path: string;
    oldString: string;
    newString: string;
}
export interface ListDirAction {
    type: 'list_dir';
    path: string;
}
export interface SearchAction {
    type: 'search';
    query: string;
    glob?: string;
}
export interface RunCommandAction {
    type: 'run_command';
    command: string;
    cwd?: string;
    timeoutMs?: number;
    /**
     * Run the command in a detached VS Code terminal window. Returns
     * immediately. Use for long-running processes such as dev servers
     * (`ng serve`, `vite`, `next dev`) that should outlive the agent turn.
     */
    background?: boolean;
}
export interface GitAction {
    type: 'git';
    args: string[];
}
export interface UpdatePlanAction {
    type: 'update_plan';
    plan: string;
}
export interface TodoUpdateItem {
    id?: string;
    text: string;
    status?: 'pending' | 'in_progress' | 'completed';
}
export interface UpdateTodosAction {
    type: 'update_todos';
    todos: TodoUpdateItem[];
}
export interface DelegateAction {
    type: 'delegate';
    /** Self-contained instruction the child agent runs to completion. */
    task: string;
    /** Optional scope hint (e.g. paths, modules) appended to the child's task. */
    scope?: string;
}
export interface FinishAction {
    type: 'finish';
    summary: string;
}

export type Action =
    | ReadFileAction
    | WriteFileAction
    | EditFileAction
    | ListDirAction
    | SearchAction
    | RunCommandAction
    | GitAction
    | UpdatePlanAction
    | UpdateTodosAction
    | DelegateAction
    | FinishAction;

export type ActionType = Action['type'];

/** Embedded in the system prompt. Must match the validators below. */
export const ACTION_SCHEMA_DOC = `
- read_file       { "type": "read_file", "path": "<workspace-relative path>" }
- write_file      { "type": "write_file", "path": "<workspace-relative path>", "content": "<full file contents>" }
- edit_file       { "type": "edit_file", "path": "<workspace-relative path>", "oldString": "<exact substring>", "newString": "<replacement>" }
- list_dir        { "type": "list_dir", "path": "<workspace-relative path or '.'>" }
- search          { "type": "search", "query": "<regex>", "glob": "<optional file glob>" }
- run_command     { "type": "run_command", "command": "<shell command>", "cwd": "<optional>", "timeoutMs": <optional number>, "background": <optional boolean> }
                  Set "background": true for long-running processes like dev servers (ng serve, vite, next dev).
                  Background commands open a VS Code terminal the user can see and return immediately.
- git             { "type": "git", "args": ["status"] }
- update_plan     { "type": "update_plan", "plan": "<markdown plan>" }
- update_todos    { "type": "update_todos", "todos": [{ "id": "<optional, echo to keep>", "text": "<…>", "status": "pending|in_progress|completed" }, …] }
                  Overwrites the entire TODO list. Echo existing ids to preserve them across edits.
- delegate        { "type": "delegate", "task": "<self-contained instruction>", "scope": "<optional hint>" }
                  Spawn a child agent with isolated context. Useful for big read-heavy work
                  ("search the repo for X", "audit all auth tests"). Returns the child's
                  finish summary as a tool result; the child's intermediate steps don't
                  pollute the parent's context.
- finish          { "type": "finish", "summary": "<one-paragraph result>" }
`.trim();

export interface ParseError {
    index: number;
    raw: string;
    message: string;
}

export interface ParseResult {
    actions: Action[];
    errors: ParseError[];
}

const FENCE_RE = /```action\s*\n([\s\S]*?)\n```/g;

/**
 * Extract every fenced ` ```action ` block from a free-form model reply,
 * parse the JSON, and validate against the action schema.
 *
 * Validation failures are returned in `errors` so the agent loop can feed
 * them back to the model for self-correction.
 */
export function parseActions(text: string): ParseResult {
    const actions: Action[] = [];
    const errors: ParseError[] = [];
    let match: RegExpExecArray | null;
    let i = 0;
    FENCE_RE.lastIndex = 0;
    while ((match = FENCE_RE.exec(text)) !== null) {
        const raw = match[1];
        i++;
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            errors.push({ index: i, raw, message: `Invalid JSON: ${(e as Error).message}` });
            continue;
        }
        const validated = validate(parsed);
        if (!validated.ok) {
            errors.push({ index: i, raw, message: validated.error });
            continue;
        }
        actions.push(validated.action);
    }
    return { actions, errors };
}

type Validation = { ok: true; action: Action } | { ok: false; error: string };

function validate(v: unknown): Validation {
    if (!v || typeof v !== 'object') {
        return { ok: false, error: 'Action must be a JSON object.' };
    }
    const obj = v as Record<string, unknown>;
    const t = obj.type;
    if (typeof t !== 'string') {
        return { ok: false, error: 'Missing string field "type".' };
    }
    const reqString = (k: string): string => {
        const x = obj[k];
        if (typeof x !== 'string') {
            throw new Error(`Field "${k}" must be a string.`);
        }
        return x;
    };
    const optString = (k: string): string | undefined => {
        const x = obj[k];
        if (x === undefined || x === null) {
            return undefined;
        }
        if (typeof x !== 'string') {
            throw new Error(`Field "${k}" must be a string when present.`);
        }
        return x;
    };
    const optNumber = (k: string): number | undefined => {
        const x = obj[k];
        if (x === undefined || x === null) {
            return undefined;
        }
        if (typeof x !== 'number' || !Number.isFinite(x)) {
            throw new Error(`Field "${k}" must be a finite number when present.`);
        }
        return x;
    };
    const optBool = (k: string): boolean | undefined => {
        const x = obj[k];
        if (x === undefined || x === null) {
            return undefined;
        }
        if (typeof x !== 'boolean') {
            throw new Error(`Field "${k}" must be a boolean when present.`);
        }
        return x;
    };
    try {
        switch (t) {
            case 'read_file':
                return { ok: true, action: { type: t, path: reqString('path') } };
            case 'write_file':
                return { ok: true, action: { type: t, path: reqString('path'), content: reqString('content') } };
            case 'edit_file':
                return {
                    ok: true,
                    action: {
                        type: t,
                        path: reqString('path'),
                        oldString: reqString('oldString'),
                        newString: reqString('newString'),
                    },
                };
            case 'list_dir':
                return { ok: true, action: { type: t, path: reqString('path') } };
            case 'search':
                return { ok: true, action: { type: t, query: reqString('query'), glob: optString('glob') } };
            case 'run_command':
                return {
                    ok: true,
                    action: {
                        type: t,
                        command: reqString('command'),
                        cwd: optString('cwd'),
                        timeoutMs: optNumber('timeoutMs'),
                        background: optBool('background'),
                    },
                };
            case 'git': {
                const args = obj.args;
                if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
                    return { ok: false, error: 'Field "args" must be an array of strings.' };
                }
                return { ok: true, action: { type: t, args: args as string[] } };
            }
            case 'update_plan':
                return { ok: true, action: { type: t, plan: reqString('plan') } };
            case 'update_todos': {
                const arr = obj.todos;
                if (!Array.isArray(arr)) {
                    return { ok: false, error: 'Field "todos" must be an array.' };
                }
                const todos: TodoUpdateItem[] = [];
                for (let idx = 0; idx < arr.length; idx++) {
                    const item = arr[idx];
                    if (!item || typeof item !== 'object') {
                        return { ok: false, error: `todos[${idx}] must be an object.` };
                    }
                    const it = item as Record<string, unknown>;
                    if (typeof it.text !== 'string') {
                        return { ok: false, error: `todos[${idx}].text must be a string.` };
                    }
                    if (it.id !== undefined && typeof it.id !== 'string') {
                        return { ok: false, error: `todos[${idx}].id must be a string when present.` };
                    }
                    if (
                        it.status !== undefined &&
                        it.status !== 'pending' &&
                        it.status !== 'in_progress' &&
                        it.status !== 'completed'
                    ) {
                        return {
                            ok: false,
                            error: `todos[${idx}].status must be pending|in_progress|completed when present.`,
                        };
                    }
                    todos.push({
                        id: it.id as string | undefined,
                        text: it.text,
                        status: it.status as TodoUpdateItem['status'],
                    });
                }
                return { ok: true, action: { type: t, todos } };
            }
            case 'delegate':
                return {
                    ok: true,
                    action: { type: t, task: reqString('task'), scope: optString('scope') },
                };
            case 'finish':
                return { ok: true, action: { type: t, summary: reqString('summary') } };
            default:
                return { ok: false, error: `Unknown action type "${t}".` };
        }
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}
