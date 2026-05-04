import * as vscode from 'vscode';
import * as path from 'path';
import { estimateTokens } from '../context/tokens';

const TEXT_DECODER = new TextDecoder('utf-8');

const CANDIDATE_PATHS = [
    '.swirlock/AGENT.md',
    'AGENT.md',
    '.swirlock/MEMORY.md',
];

/**
 * Loads the project memory file (CLAUDE.md analog) if present. Owned by the
 * user; the agent may also propose edits via write_file. Re-loaded each turn
 * so manual edits take effect immediately.
 */
export async function loadProjectMemory(workspaceRoot: string, maxTokens: number): Promise<string | null> {
    for (const rel of CANDIDATE_PATHS) {
        const abs = path.join(workspaceRoot, rel);
        try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(abs));
            let text = TEXT_DECODER.decode(bytes).trim();
            if (!text) {
                continue;
            }
            const tokens = estimateTokens(text);
            if (tokens > maxTokens) {
                const charCap = maxTokens * 4;
                text = text.slice(0, charCap) + `\n\n[… project memory truncated at ${maxTokens} tokens …]`;
            }
            return `<!-- source: ${rel} -->\n${text}`;
        } catch {
            // not present at this path — try next
        }
    }
    return null;
}
