import { ContextEntry, EntryType, Priority } from './types';
import { estimateTokens } from './tokens';
import { uuidv7 } from '../util/uuid';

export interface AddEntryInput {
    type: EntryType;
    content: string;
    priority: Priority;
    source?: string;
    pinned?: boolean;
    dedupKey?: string;
}

/**
 * Tier 3 — the rolling conversation transcript.
 *
 * Holds tool results that are NOT files (those go to ActiveFiles), assistant
 * replies, user prompts, errors, and compaction summaries. Provides the
 * deterministic compaction primitives the agent loop calls every turn:
 *
 *   - dedupBy(key)            replace prior entries with same key by a stub
 *   - markObsolete(predicate) replace specific entries by a stub
 *   - middleRange(keepRecent) identify the eligible-for-summarisation range
 *   - replaceRange(...)       fold a range into a single summary entry
 */
export class ContextManager {
    private entries: ContextEntry[] = [];

    add(input: AddEntryInput): ContextEntry {
        if (input.dedupKey) {
            this.dedupBy(input.dedupKey);
        }
        const entry: ContextEntry = {
            id: uuidv7(),
            type: input.type,
            content: input.content,
            priority: input.priority,
            source: input.source,
            createdAt: Date.now(),
            tokenEstimate: estimateTokens(input.content),
            pinned: input.pinned ?? false,
            dedupKey: input.dedupKey,
        };
        this.entries.push(entry);
        return entry;
    }

    all(): readonly ContextEntry[] {
        return this.entries;
    }

    clear(): void {
        this.entries = [];
    }

    /**
     * When a new user task arrives, the previous "current task" entry should
     * stop being pinned at top priority — it becomes part of the rolling
     * conversation history. Called before adding the new task.
     */
    demoteOldTasks(): void {
        for (const e of this.entries) {
            if (e.type === 'task' && (e.pinned || e.priority > 1)) {
                e.pinned = false;
                e.priority = 1;
            }
        }
    }

    /**
     * Replace any prior entries that share the given dedup key with a short
     * "[superseded]" stub. Cheap, deterministic — same technique Cline uses
     * to free tokens without breaking message indices.
     */
    dedupBy(key: string): number {
        let n = 0;
        for (const e of this.entries) {
            if (e.dedupKey === key && !e.obsoleted) {
                e.content = `[superseded — see later entry]`;
                e.tokenEstimate = estimateTokens(e.content);
                e.obsoleted = true;
                e.priority = 0;
                e.pinned = false;
                n++;
            }
        }
        return n;
    }

    /**
     * Mark prior entries matching a predicate as stale. Used when an edit
     * invalidates an earlier read of the same file.
     */
    markStale(predicate: (e: ContextEntry) => boolean, marker: string): number {
        let n = 0;
        for (const e of this.entries) {
            if (!e.obsoleted && predicate(e)) {
                e.content = `[stale — ${marker}]`;
                e.tokenEstimate = estimateTokens(e.content);
                e.obsoleted = true;
                e.priority = 0;
                e.pinned = false;
                n++;
            }
        }
        return n;
    }

    /**
     * Drop entries already obsoleted whose stub content adds nothing useful.
     * Called periodically to compact the entry list itself.
     */
    purgeObsolete(): number {
        const before = this.entries.length;
        this.entries = this.entries.filter((e) => !e.obsoleted || e.pinned);
        return before - this.entries.length;
    }

    /**
     * Identify the range of entries eligible for LLM summarisation: skip
     * the first user task (anchor) and the last `keepRecent` non-system
     * entries (recent context). Returns the slice of entries between them.
     */
    middleRange(keepRecent: number): { start: number; end: number; entries: ContextEntry[] } {
        const indices: number[] = [];
        for (let i = 0; i < this.entries.length; i++) {
            const e = this.entries[i];
            if (e.type === 'system' || e.pinned || e.obsoleted) {
                continue;
            }
            indices.push(i);
        }
        if (indices.length <= keepRecent + 1) {
            return { start: -1, end: -1, entries: [] };
        }
        // Skip first eligible entry (anchor) and last `keepRecent` (recent).
        const middleIdx = indices.slice(1, indices.length - keepRecent);
        if (middleIdx.length === 0) {
            return { start: -1, end: -1, entries: [] };
        }
        const start = middleIdx[0];
        const end = middleIdx[middleIdx.length - 1];
        const entries = middleIdx.map((i) => this.entries[i]);
        return { start, end, entries };
    }

    /**
     * Replace a slice of entries with a single summary entry. Used by the
     * Compactor after an LLM summary is produced.
     */
    replaceRange(start: number, end: number, summary: string): void {
        const entry: ContextEntry = {
            id: uuidv7(),
            type: 'summary',
            content: summary,
            priority: 2,
            source: 'compactor',
            createdAt: Date.now(),
            tokenEstimate: estimateTokens(summary),
        };
        this.entries.splice(start, end - start + 1, entry);
    }

    /**
     * Return entries fitting within `budget` tokens for prompt rendering.
     * Pinned + priority-3 entries are kept regardless. Among the rest, the
     * newest are preferred. Render order: system → plan → everything else
     * by createdAt asc (chronological transcript).
     */
    selectForBudget(budget: number): ContextEntry[] {
        const sorted = [...this.entries];
        const totalTokens = (xs: ContextEntry[]) => xs.reduce((a, b) => a + b.tokenEstimate, 0);

        const pinned = sorted.filter((e) => e.pinned || e.priority === 3);
        const candidates = sorted.filter((e) => !(e.pinned || e.priority === 3));
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
        const orderRank = (t: EntryType): number => {
            switch (t) {
                case 'system':
                    return 0;
                case 'plan':
                    return 1;
                default:
                    return 2;
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
