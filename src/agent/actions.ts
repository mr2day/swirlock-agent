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
            case 'finish':
                return { ok: true, action: { type: t, summary: reqString('summary') } };
            default:
                return { ok: false, error: `Unknown action type "${t}".` };
        }
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}
