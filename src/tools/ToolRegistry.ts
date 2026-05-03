import { Action } from '../agent/actions';
import { Tool, ToolContext, ToolResult } from './Tool';

export class ToolRegistry {
    private tools = new Map<string, Tool>();

    register<A extends Action>(tool: Tool<A>): void {
        this.tools.set(tool.type, tool as unknown as Tool);
    }

    has(type: string): boolean {
        return this.tools.has(type);
    }

    async execute(action: Action, ctx: ToolContext): Promise<ToolResult> {
        const tool = this.tools.get(action.type);
        if (!tool) {
            return {
                summary: `No tool registered for "${action.type}".`,
                output: `No tool registered for "${action.type}". The action was ignored.`,
                error: true,
            };
        }
        return tool.execute(action, ctx);
    }
}
