import { ActiveFiles } from './ActiveFiles';
import { Plan } from './Plan';
import { Todos } from './Todos';

/**
 * Tier 2 of the layered context — held outside the rolling transcript and
 * re-injected into the prompt every turn. Survives across user messages in
 * the same panel session; reset on clear or panel disposal.
 */
export class WorkingState {
    readonly plan = new Plan();
    readonly todos = new Todos();
    readonly activeFiles = new ActiveFiles();

    clear(): void {
        this.plan.set('');
        this.todos.clear();
        this.activeFiles.clear();
    }
}
