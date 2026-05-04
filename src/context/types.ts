export type EntryType =
    | 'system'
    | 'task'
    | 'plan'
    | 'file'
    | 'tool_result'
    | 'assistant'
    | 'error'
    | 'summary';

/**
 * Priority bands. Lower numbers are dropped first when the budget is tight.
 *   0  - bulk/old (stale file contents, old assistant chatter)
 *   1  - normal (general tool results)
 *   2  - important (recent tool results, recent files)
 *   3  - critical (system, current task, plan, latest error)
 */
export type Priority = 0 | 1 | 2 | 3;

export interface ContextEntry {
    id: string;
    type: EntryType;
    content: string;
    priority: Priority;
    source?: string;
    createdAt: number;
    tokenEstimate: number;
    /** Marks an entry that must always be kept (system, current task). */
    pinned?: boolean;
    /**
     * Deduplication key. When a new entry is added with the same dedupKey,
     * older entries with that key are rewritten to a "[superseded]" stub.
     */
    dedupKey?: string;
    /**
     * Set when an earlier entry has been deterministically obsoleted by a
     * later one (file edited, tool result superseded, summarised by the
     * compactor). The full content has been replaced with a short marker.
     */
    obsoleted?: boolean;
}
