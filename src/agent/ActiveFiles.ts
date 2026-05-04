import { estimateTokens } from '../context/tokens';
import { truncate } from '../tools/Tool';

export type FileStatus = 'read' | 'edited' | 'written';

export interface ActiveFile {
    path: string;
    content: string;
    status: FileStatus;
    /** Iteration in which this entry was last touched. Used for LRU eviction. */
    lastTouchedIter: number;
    lastTouchedAt: number;
}

/**
 * The set of files the agent is currently working on. Replaces "tool results
 * for read_file" in the rolling transcript: when the model reads a file, the
 * content goes here instead of the conversation history. Subsequent reads of
 * the same path overwrite the entry, so the model always sees the *current*
 * version without the budget paying for stale copies.
 */
export class ActiveFiles {
    private files = new Map<string, ActiveFile>();

    /** Record a read: add or refresh the file with new content. */
    markRead(path: string, content: string, iter: number): ActiveFile {
        return this.upsert(path, content, 'read', iter);
    }

    /** Record an edit_file: refresh the file with new content. */
    markEdited(path: string, content: string, iter: number): ActiveFile {
        return this.upsert(path, content, 'edited', iter);
    }

    /** Record a write_file: refresh the file with new content. */
    markWritten(path: string, content: string, iter: number): ActiveFile {
        return this.upsert(path, content, 'written', iter);
    }

    has(path: string): boolean {
        return this.files.has(path);
    }

    drop(path: string): void {
        this.files.delete(path);
    }

    clear(): void {
        this.files.clear();
    }

    list(): ActiveFile[] {
        return [...this.files.values()];
    }

    /**
     * Render the active set for prompt injection within a token budget.
     * Newest-touched files are kept first; oldest are dropped if needed.
     */
    render(maxTokens: number): string {
        if (this.files.size === 0) {
            return '';
        }
        const sorted = [...this.files.values()].sort(
            (a, b) => b.lastTouchedIter - a.lastTouchedIter,
        );
        const sections: string[] = ['# Active files'];
        let used = estimateTokens(sections[0]);
        let dropped = 0;
        for (const f of sorted) {
            const header = `\n=== FILE ${f.path} (${f.status} at iter ${f.lastTouchedIter}) ===\n`;
            const headerCost = estimateTokens(header);
            const remaining = maxTokens - used - headerCost;
            if (remaining < 200) {
                dropped += sorted.length - sections.length + 1;
                break;
            }
            // Per-file cap: at most a third of the remaining budget so a single
            // big file can't crowd out the others.
            const perFileCap = Math.max(800, Math.floor(remaining / 3));
            const t = truncate(f.content, perFileCap * 4);
            const block = header + t.text;
            const blockCost = estimateTokens(block);
            if (used + blockCost > maxTokens) {
                dropped += sorted.length - (sections.length - 1);
                break;
            }
            sections.push(block);
            used += blockCost;
        }
        if (dropped > 0) {
            sections.push(`\n[…${dropped} additional file(s) omitted to fit ${maxTokens}-token budget…]`);
        }
        return sections.join('');
    }

    private upsert(path: string, content: string, status: FileStatus, iter: number): ActiveFile {
        const entry: ActiveFile = {
            path,
            content,
            status,
            lastTouchedIter: iter,
            lastTouchedAt: Date.now(),
        };
        this.files.set(path, entry);
        return entry;
    }
}
