import * as vscode from 'vscode';
import { ContextManager } from '../context/ContextManager';
import { ModelHostClient } from '../transport/ModelHostClient';
import { InferRequest } from '../transport/contracts';
import { uuidv7 } from '../util/uuid';
import { log } from '../util/logger';

export interface CompactorOptions {
    callerService: string;
    /** Numeric host queue priority. Compaction is background work — keep it lower than user turns. */
    priority?: number;
}

/**
 * LLM-based escape hatch for when deterministic compaction (dedup, staleness,
 * sliding window) isn't enough. When the rolling transcript exceeds a
 * fraction of its sub-budget, asks the model to fold the eligible middle
 * entries into a single dense summary. The first user prompt and the most
 * recent K turns stay verbatim.
 */
export class Compactor {
    constructor(
        private readonly client: ModelHostClient,
        private readonly opts: CompactorOptions,
    ) {}

    /**
     * Run compaction if the transcript exceeds the threshold. Returns true
     * if a summary was produced and merged into the context.
     */
    async maybeCompact(
        context: ContextManager,
        transcriptBudget: number,
        threshold: number,
        keepRecent: number,
        token: vscode.CancellationToken,
    ): Promise<boolean> {
        const used = context.totalTokens();
        if (used < transcriptBudget * threshold) {
            return false;
        }
        const range = context.middleRange(keepRecent);
        if (range.entries.length === 0) {
            return false;
        }
        const original = range.entries
            .map((e) => `--- ${e.type.toUpperCase()}${e.source ? ' (' + e.source + ')' : ''} ---\n${e.content}`)
            .join('\n\n');
        try {
            const summary = await this.summarise(original, token);
            context.replaceRange(range.start, range.end, summary);
            log().info(
                `Compactor: folded ${range.entries.length} entries into a summary (${summary.length} chars).`,
            );
            return true;
        } catch (e) {
            log().warn(`Compactor failed; leaving transcript intact: ${(e as Error).message}`);
            return false;
        }
    }

    private async summarise(transcript: string, token: vscode.CancellationToken): Promise<string> {
        const prompt = `You are compacting an autonomous coding agent's conversation history.

Read the transcript below and produce a dense single-block summary that preserves:
- the user's overall goal and any constraints they stated
- files touched (with paths) and how they were changed
- decisions taken and rejected approaches with reason
- errors encountered and how they were resolved
- the current state of the work

Drop:
- chit-chat
- verbose tool output
- intermediate reasoning the agent has already acted on

Format: 2–4 short paragraphs of prose. No headers, no bullet lists, no code fences.

=== TRANSCRIPT START ===
${transcript}
=== TRANSCRIPT END ===

Write the summary now.`;

        const req: InferRequest = {
            requestContext: {
                callerService: `${this.opts.callerService}/compactor`,
                requestedAt: new Date().toISOString(),
                priority: this.opts.priority ?? 0,
            },
            input: { parts: [{ type: 'text', text: prompt }] },
            options: { responseFormat: 'text', thinking: false },
        };
        const cid = uuidv7();
        const res = await this.client.infer(req, token, cid);
        return `[history summary @ ${new Date().toISOString()}]\n${res.data.output.text.trim()}`;
    }
}
