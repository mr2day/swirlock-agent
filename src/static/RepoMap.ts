import * as vscode from 'vscode';
import * as path from 'path';
import { estimateTokens } from '../context/tokens';

const SOURCE_GLOB =
    '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,swift,rb,php,cs,cpp,c,h,hpp,scala,sh,ps1,sql,md,yaml,yml,toml,json}';

const EXCLUDE_GLOB =
    '**/{node_modules,.git,dist,out,build,.next,.nuxt,.svelte-kit,.cache,.turbo,target,bin,obj,__pycache__,.venv,venv,.tox,coverage,.swirlock}/**';

interface RepoEntry {
    relPath: string;
    sizeBytes: number;
    lines: number;
}

/**
 * Generates a compact directory listing of source files for Tier 1 context.
 *
 * Heuristic version: no symbol extraction, no PageRank — just a flat
 * structural view that gives the model awareness of "these files exist."
 * Replaceable with a tree-sitter-based symbol map later without changing
 * the public shape.
 */
export async function generateRepoMap(
    workspaceRoot: string,
    maxTokens: number,
    token: vscode.CancellationToken,
): Promise<string> {
    const include = new vscode.RelativePattern(workspaceRoot, SOURCE_GLOB);
    let uris: vscode.Uri[];
    try {
        uris = await vscode.workspace.findFiles(include, EXCLUDE_GLOB, 5000, token);
    } catch {
        return '(repo map unavailable — could not scan workspace)';
    }
    if (token.isCancellationRequested) {
        return '(repo map cancelled)';
    }

    const entries: RepoEntry[] = [];
    for (const uri of uris) {
        if (token.isCancellationRequested) {
            break;
        }
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            const rel = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
            entries.push({
                relPath: rel,
                sizeBytes: stat.size,
                lines: estimateLines(stat.size),
            });
        } catch {
            // skip unreadable
        }
    }

    entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

    // Build output progressively, stop when budget is hit. Prefer to keep
    // shorter paths (root-level files) and earlier entries to maintain a
    // coherent prefix.
    const lines: string[] = [`# Workspace map (${entries.length} files)`];
    let usedTokens = estimateTokens(lines[0]);
    let truncated = false;
    for (const e of entries) {
        const line = `  ${e.relPath} (~${e.lines} lines)`;
        const t = estimateTokens(line);
        if (usedTokens + t > maxTokens) {
            truncated = true;
            break;
        }
        lines.push(line);
        usedTokens += t;
    }
    if (truncated) {
        lines.push(`  […more files omitted to fit ${maxTokens}-token budget…]`);
    }
    return lines.join('\n');
}

function estimateLines(sizeBytes: number): number {
    // Rough heuristic: ~40 bytes per line of code on average.
    return Math.max(1, Math.round(sizeBytes / 40));
}
