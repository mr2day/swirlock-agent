import { ContextManager } from '../context/ContextManager';
import { ContextEntry } from '../context/types';
import { Plan } from '../agent/Plan';
import { buildSystemPrompt, SystemPromptInput } from './systemPrompt';
import { InferRequest, InferenceInput, InputPart, RequestContext } from '../transport/contracts';
import { estimateTokens } from '../context/tokens';

export interface AssembleOptions {
    callerService: string;
    priority: number;
    budgetTokens: number;
    showThinking: boolean;
    system: SystemPromptInput;
    plan: Plan;
}

/**
 * Renders the prioritised context into a single InferRequest payload.
 *
 * The model host accepts InferenceInput.parts[]; it has no chat/role concept,
 * so we flatten the entire conversation into one large text part with section
 * headers. This keeps the host fully agnostic.
 */
export class PromptAssembler {
    constructor(private context: ContextManager) {}

    assemble(opts: AssembleOptions): InferRequest {
        // Re-inject system prompt and plan at the top of every turn.
        const systemText = buildSystemPrompt(opts.system);
        const planText = opts.plan.text();

        // Reserve budget for system + plan headers. Both are pinned-equivalent.
        const reserved = estimateTokens(systemText) + estimateTokens(planText) + 64;
        const remaining = Math.max(512, opts.budgetTokens - reserved);
        const selected = this.context.selectForBudget(remaining);

        const sections: string[] = [];
        sections.push('=== SYSTEM ===');
        sections.push(systemText);
        if (planText.trim().length > 0) {
            sections.push('=== PLAN (latest) ===');
            sections.push(planText);
        }
        for (const entry of selected) {
            sections.push(this.headerFor(entry));
            sections.push(entry.content);
        }
        sections.push('=== YOUR TURN ===');
        sections.push('Reply now. Emit action blocks as needed. End with a `finish` action when the task is verified complete.');

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

    private headerFor(entry: ContextEntry): string {
        const src = entry.source ? ` (${entry.source})` : '';
        switch (entry.type) {
            case 'task':
                return `=== USER TASK ===`;
            case 'file':
                return `=== FILE${src} ===`;
            case 'tool_result':
                return `=== TOOL RESULT${src} ===`;
            case 'assistant':
                return `=== ASSISTANT (previous turn) ===`;
            case 'error':
                return `=== ERROR${src} ===`;
            case 'plan':
                return `=== PLAN (historical) ===`;
            case 'system':
                return `=== SYSTEM (additional) ===`;
            default:
                return `=== ${String(entry.type).toUpperCase()} ===`;
        }
    }
}
