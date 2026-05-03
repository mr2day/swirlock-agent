/**
 * The agent's living plan. First-class state, separate from the rolling
 * context. Updated by `update_plan` actions and re-injected at the top of
 * every iteration.
 */
export class Plan {
    private current = '';

    text(): string {
        return this.current;
    }

    set(plan: string): void {
        this.current = plan.trim();
    }

    isEmpty(): boolean {
        return this.current.length === 0;
    }
}
