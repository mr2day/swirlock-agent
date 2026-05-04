import { ContextManager } from '../context/ContextManager';
import { ContextEntry } from '../context/types';
import { WorkingState } from '../agent/WorkingState';
import { buildSystemPrompt, SystemPromptInput } from './systemPrompt';
import { InferRequest, InferenceInput, InputPart, RequestContext } from '../transport/contracts';
import { estimateTokens } from '../context/tokens';
import { SwirlockConfig } from '../config/Config';

export interface StaticContext {
    /** Contents of .swirlock/AGENT.md if present, else null. */
    projectMemory: string | null;
    /** Compact directory listing of source files. */
    repoMap: string;
}

export interface AssembleOptions {
    callerService: string;
    priority: number;
    showThinking: boolean;
    system: SystemPromptInput;
    working: WorkingState;
    static: StaticContext;
    budgets: SwirlockConfig['budgets'];
    /** Total budget across all tiers. */
    totalBudget: number;
}

/**
 * Renders the three-tier context into one InferRequest.
 *
 * Tier 1 — static, rebuilt every turn: system prompt, project memory, repo map.
 * Tier 2 — working state, owned by the panel session: plan, todos, active files.
 * Tier 3 — rolling transcript: user/assistant/tool_result/error/summary entries.
 *
 * Tier 1+2 totals are reserved up front; the remainder is the transcript budget.
 */
export class PromptAssembler {
    constructor(private context: ContextManager) {}

    assemble(opts: AssembleOptions): InferRequest {
        const sections: string[] = [];

        // ---- Tier 1: static -----------------------------------------------
        const systemText = buildSystemPrompt(opts.system);
        sections.push('=== SYSTEM ===');
        sections.push(systemText);

        if (opts.static.projectMemory) {
            sections.push('=== PROJECT MEMORY ===');
            sections.push(opts.static.projectMemory);
        }
        if (opts.static.repoMap.trim().length > 0) {
            sections.push('=== REPO MAP ===');
            sections.push(opts.static.repoMap);
        }

        // ---- Tier 2: working state ----------------------------------------
        const planText = opts.working.plan.text();
        if (planText.trim().length > 0) {
            sections.push('=== PLAN ===');
            sections.push(this.cap(planText, opts.budgets.planTokens));
        }
        const todosText = opts.working.todos.render(opts.budgets.todosTokens);
        if (todosText.trim().length > 0) {
            sections.push('=== TODOS ===');
            sections.push(todosText);
        }
        const activeFilesText = opts.working.activeFiles.render(opts.budgets.activeFilesTokens);
        if (activeFilesText.trim().length > 0) {
            sections.push('=== ACTIVE FILES ===');
            sections.push(activeFilesText);
        }

        // ---- Tier 3: rolling transcript ----------------------------------
        const transcriptBudget = this.transcriptBudget(opts);
        const selected = this.context.selectForBudget(transcriptBudget);
        // Drop the system header injected by selectForBudget — Tier 1 already
        // renders the system prompt above. We only want the conversation here.
        const transcript = selected.filter((e) => e.type !== 'system');
        if (transcript.length > 0) {
            sections.push('=== TRANSCRIPT ===');
            for (const entry of transcript) {
                sections.push(this.headerFor(entry));
                sections.push(entry.content);
            }
        }

        sections.push('=== YOUR TURN ===');
        sections.push(
            'Reply now. Use action blocks for tool work, prose for direct answers, ' +
                'or a `finish` action when verified complete. Plain prose with no ' +
                'action will be treated as a finish.',
        );

        const text = sections.join('\n\n');

        const part: InputPart = { type: 'text', text };
        const input: InferenceInput = { parts: [part] };
        const requestContext: RequestContext = {
            callerService: opts.callerService,
            priority: opts.priority,
            requestedAt: new Date().toISOString(),
        };
        return {
            requestContext,
            input,
            options: {
                responseFormat: 'text',
                thinking: opts.showThinking,
            },
        };
    }

    /**
     * Compute how much of the total budget is left for the rolling transcript
     * after Tier 1 and Tier 2 caps are reserved.
     */
    transcriptBudget(opts: AssembleOptions): number {
        const reserved =
            estimateTokens(buildSystemPrompt(opts.system)) +
            (opts.static.projectMemory ? opts.budgets.projectMemoryTokens : 0) +
            opts.budgets.repoMapTokens +
            opts.budgets.planTokens +
            opts.budgets.todosTokens +
            opts.budgets.activeFilesTokens +
            512; // headers + "your turn" footer
        return Math.max(2000, opts.totalBudget - reserved);
    }

    private cap(text: string, maxTokens: number): string {
        if (estimateTokens(text) <= maxTokens) {
            return text;
        }
        return text.slice(0, maxTokens * 4) + `\n\n[…truncated at ${maxTokens} tokens…]`;
    }

    private headerFor(entry: ContextEntry): string {
        const src = entry.source ? ` (${entry.source})` : '';
        switch (entry.type) {
            case 'task':
                return `=== USER ===`;
            case 'file':
                return `=== FILE${src} ===`;
            case 'tool_result':
                return `=== TOOL RESULT${src} ===`;
            case 'assistant':
                return `=== ASSISTANT ===`;
            case 'error':
                return `=== ERROR${src} ===`;
            case 'summary':
                return `=== HISTORY SUMMARY ===`;
            case 'plan':
                return `=== PLAN (historical) ===`;
            case 'system':
                return `=== SYSTEM (additional) ===`;
            default:
                return `=== ${String(entry.type).toUpperCase()} ===`;
        }
    }
}
