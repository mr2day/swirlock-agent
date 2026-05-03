import * as vscode from 'vscode';
import * as path from 'path';
import {
    EditFileAction,
    ListDirAction,
    ReadFileAction,
    SearchAction,
    WriteFileAction,
} from '../agent/actions';
import { Tool, ToolContext, ToolResult, truncate } from './Tool';

const TEXT_DECODER = new TextDecoder('utf-8');
const TEXT_ENCODER = new TextEncoder();

export class ReadFileTool implements Tool<ReadFileAction> {
    readonly type = 'read_file' as const;
    async execute(action: ReadFileAction, ctx: ToolContext): Promise<ToolResult> {
        const abs = await ctx.pathJail.realResolve(action.path);
        const uri = vscode.Uri.file(abs);
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = TEXT_DECODER.decode(bytes);
            const t = truncate(text);
            return {
                summary: `read ${action.path} (${bytes.byteLength} bytes${t.truncated ? ', truncated' : ''})`,
                output: t.text,
                truncated: t.truncated,
            };
        } catch (e) {
            return errorResult(`read_file failed: ${(e as Error).message}`);
        }
    }
}

export class WriteFileTool implements Tool<WriteFileAction> {
    readonly type = 'write_file' as const;
    async execute(action: WriteFileAction, ctx: ToolContext): Promise<ToolResult> {
        const mode = ctx.permission.mode;
        if (mode === 'normal') {
            await ctx.pathJail.realResolve(action.path);
        }
        const abs = ctx.pathJail.resolve(action.path);
        const uri = vscode.Uri.file(abs);
        try {
            await ensureDir(path.dirname(abs));
            const bytes = TEXT_ENCODER.encode(action.content);
            await vscode.workspace.fs.writeFile(uri, bytes);
            return {
                summary: `wrote ${action.path} (${bytes.byteLength} bytes)`,
                output: `Wrote ${bytes.byteLength} bytes to ${action.path}.`,
            };
        } catch (e) {
            return errorResult(`write_file failed: ${(e as Error).message}`);
        }
    }
}

export class EditFileTool implements Tool<EditFileAction> {
    readonly type = 'edit_file' as const;
    async execute(action: EditFileAction, ctx: ToolContext): Promise<ToolResult> {
        const abs = await ctx.pathJail.realResolve(action.path);
        const uri = vscode.Uri.file(abs);
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const original = TEXT_DECODER.decode(bytes);
            if (!original.includes(action.oldString)) {
                return errorResult(`edit_file: oldString not found in ${action.path}`);
            }
            const occurrences = original.split(action.oldString).length - 1;
            if (occurrences > 1) {
                return errorResult(
                    `edit_file: oldString appears ${occurrences} times in ${action.path}; provide more context to make it unique.`,
                );
            }
            const updated = original.replace(action.oldString, action.newString);
            await vscode.workspace.fs.writeFile(uri, TEXT_ENCODER.encode(updated));
            return {
                summary: `edited ${action.path} (${original.length} → ${updated.length} bytes)`,
                output: `Replaced one occurrence in ${action.path}.`,
            };
        } catch (e) {
            return errorResult(`edit_file failed: ${(e as Error).message}`);
        }
    }
}

export class ListDirTool implements Tool<ListDirAction> {
    readonly type = 'list_dir' as const;
    async execute(action: ListDirAction, ctx: ToolContext): Promise<ToolResult> {
        const target = action.path === '' || action.path === '.' ? '.' : action.path;
        const abs = await ctx.pathJail.realResolve(target);
        const uri = vscode.Uri.file(abs);
        try {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            const lines = entries
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([name, kind]) => {
                    const tag =
                        kind === vscode.FileType.Directory
                            ? 'dir '
                            : kind === vscode.FileType.SymbolicLink
                              ? 'link'
                              : 'file';
                    return `  ${tag}  ${name}`;
                });
            const text = `${target}\n${lines.join('\n')}`;
            const t = truncate(text);
            return {
                summary: `listed ${target} (${entries.length} entries)`,
                output: t.text,
                truncated: t.truncated,
            };
        } catch (e) {
            return errorResult(`list_dir failed: ${(e as Error).message}`);
        }
    }
}

export class SearchTool implements Tool<SearchAction> {
    readonly type = 'search' as const;
    async execute(action: SearchAction, ctx: ToolContext): Promise<ToolResult> {
        try {
            const include = action.glob
                ? new vscode.RelativePattern(ctx.workspaceRoot, action.glob)
                : new vscode.RelativePattern(ctx.workspaceRoot, '**/*');
            const exclude = '**/{node_modules,.git,dist,out,build,.svelte-kit,.next}/**';
            const files = await vscode.workspace.findFiles(include, exclude, 5000, ctx.token);

            let re: RegExp;
            try {
                re = new RegExp(action.query, 'm');
            } catch (e) {
                return errorResult(`search: invalid regex: ${(e as Error).message}`);
            }

            const matches: string[] = [];
            let scanned = 0;
            for (const uri of files) {
                if (ctx.token.isCancellationRequested) {
                    break;
                }
                try {
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    const text = TEXT_DECODER.decode(bytes);
                    const lines = text.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        if (re.test(lines[i])) {
                            const rel = path.relative(ctx.workspaceRoot, uri.fsPath);
                            matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                            if (matches.length >= 200) {
                                break;
                            }
                        }
                    }
                } catch {
                    // skip unreadable files (binaries, permission errors)
                }
                scanned++;
                if (matches.length >= 200) {
                    break;
                }
            }
            const t = truncate(matches.join('\n'));
            return {
                summary: `search "${action.query}" → ${matches.length} matches in ${scanned} files`,
                output: matches.length === 0 ? '(no matches)' : t.text,
                truncated: t.truncated,
            };
        } catch (e) {
            return errorResult(`search failed: ${(e as Error).message}`);
        }
    }
}

async function ensureDir(absDir: string): Promise<void> {
    try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(absDir));
    } catch {
        // createDirectory is recursive and idempotent in vscode.fs; ignore failures
        // — the subsequent write will surface a real error if needed.
    }
}

function errorResult(message: string): ToolResult {
    return { summary: message, output: message, error: true };
}
