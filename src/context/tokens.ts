/**
 * Heuristic token estimation. Without a Gemma tokenizer in-process we use
 * a chars/4 approximation. Conservative enough for budgeting.
 */
export function estimateTokens(text: string): number {
    if (!text) {
        return 0;
    }
    return Math.ceil(text.length / 4);
}
