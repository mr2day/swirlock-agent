import { ContextEntry, EntryType, Priority } from './types';
import { estimateTokens } from './tokens';
import { uuidv7 } from '../util/uuid';

export interface AddEntryInput {
    type: EntryType;
    content: string;
    priority: Priority;
    source?: string;
    pinned?: boolean;
}

/**
 * Holds the conversation/working set for a single agent task. Sorts and
 * trims entries to fit a token budget when asked, but never mutates the
 * stored set silently.
 */
export class ContextManager {
    private entries: ContextEntry[] = [];

    add(input: AddEntryInput): ContextEntry {
        const entry: ContextEntry = {
            id: uuidv7(),
            type: input.type,
            content: input.content,
            priority: input.priority,
            source: input.source,
            createdAt: Date.now(),
            tokenEstimate: estimateTokens(input.content),
            pinned: input.pinned ?? false,
        };
        this.entries.push(entry);
        return entry;
    }

    replaceByType(type: EntryType, input: AddEntryInput): ContextEntry {
        this.entries = this.entries.filter((e) => e.type !== type);
        return this.add(input);
    }

    all(): readonly ContextEntry[] {
        return this.entries;
    }

    clear(): void {
        this.entries = [];
    }

    /**
     * Return entries fitting within `budget` tokens, ordered for prompt
     * assembly: system first, then plan, then task, then everything else
     * in chronological order. Pinned entries and the highest-priority bands
     * are kept; lower priorities are dropped first, then oldest non-pinned
     * entries.
     */
    selectForBudget(budget: number): ContextEntry[] {
        // Step 1: bucket by priority. Always keep pinned + priority 3.
        const sorted = [...this.entries];
        // Drop until under budget.
        const totalTokens = (xs: ContextEntry[]) => xs.reduce((a, b) => a + b.tokenEstimate, 0);

        const pinned = sorted.filter((e) => e.pinned || e.priority === 3);
        const candidates = sorted.filter((e) => !(e.pinned || e.priority === 3));
        // Sort candidates: highest priority first, newest first within priority.
        candidates.sort((a, b) => {
            if (a.priority !== b.priority) {
                return b.priority - a.priority;
            }
            return b.createdAt - a.createdAt;
        });

        let used = totalTokens(pinned);
        const kept: ContextEntry[] = [];
        for (const e of candidates) {
            if (used + e.tokenEstimate > budget) {
                continue;
            }
            kept.push(e);
            used += e.tokenEstimate;
        }

        const final = [...pinned, ...kept];
        // Render order: system → plan → task → others by createdAt asc.
        const orderRank = (t: EntryType): number => {
            switch (t) {
                case 'system':
                    return 0;
                case 'plan':
                    return 1;
                case 'task':
                    return 2;
                default:
                    return 3;
            }
        };
        final.sort((a, b) => {
            const ra = orderRank(a.type);
            const rb = orderRank(b.type);
            if (ra !== rb) {
                return ra - rb;
            }
            return a.createdAt - b.createdAt;
        });
        return final;
    }

    totalTokens(): number {
        return this.entries.reduce((a, b) => a + b.tokenEstimate, 0);
    }

    snapshot(): ContextEntry[] {
        return this.entries.map((e) => ({ ...e }));
    }
}
