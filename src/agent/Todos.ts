import { uuidv7 } from '../util/uuid';
import { estimateTokens } from '../context/tokens';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
    id: string;
    text: string;
    status: TodoStatus;
    createdAt: number;
    completedAt?: number;
}

export interface TodoUpdate {
    id?: string;
    text: string;
    status?: TodoStatus;
}

/**
 * First-class TODO list, held outside the rolling transcript.
 *
 * The model overwrites the entire list per turn via the `update_todos`
 * action — same shape as Claude Code's TodoWrite. Items keep their ids
 * across overwrites when the model echoes them back, so completed status
 * survives unrelated edits.
 */
export class Todos {
    private items: Todo[] = [];

    /** Replace the list. Items keep their ids if echoed back; new items get fresh ids. */
    replace(updates: TodoUpdate[]): Todo[] {
        const byId = new Map(this.items.map((t) => [t.id, t]));
        const next: Todo[] = [];
        for (const u of updates) {
            const text = (u.text ?? '').trim();
            if (!text) {
                continue;
            }
            const status = u.status ?? 'pending';
            const existing = u.id ? byId.get(u.id) : undefined;
            if (existing) {
                let completedAt: number | undefined;
                if (status === 'completed') {
                    completedAt = existing.completedAt ?? Date.now();
                } else {
                    completedAt = undefined;
                }
                next.push({ ...existing, text, status, completedAt });
            } else {
                next.push({
                    id: uuidv7(),
                    text,
                    status,
                    createdAt: Date.now(),
                    completedAt: status === 'completed' ? Date.now() : undefined,
                });
            }
        }
        this.items = next;
        return [...next];
    }

    list(): readonly Todo[] {
        return this.items;
    }

    isEmpty(): boolean {
        return this.items.length === 0;
    }

    clear(): void {
        this.items = [];
    }

    /** Render for prompt injection, capped at maxTokens. */
    render(maxTokens: number): string {
        if (this.items.length === 0) {
            return '';
        }
        const lines: string[] = ['# TODOs'];
        let used = estimateTokens(lines[0]);
        let truncated = false;
        for (const t of this.items) {
            const marker =
                t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
            const line = `${marker} ${t.id.slice(0, 8)} ${t.text}`;
            const cost = estimateTokens(line);
            if (used + cost > maxTokens) {
                truncated = true;
                break;
            }
            lines.push(line);
            used += cost;
        }
        if (truncated) {
            lines.push('[…todo list truncated…]');
        }
        return lines.join('\n');
    }
}
