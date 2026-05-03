import { PermissionMode } from '../config/Config';

export class CommandPolicyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CommandPolicyError';
    }
}

/**
 * Allow/deny lists for shell commands.
 *
 * - Deny list is enforced unconditionally (kill list). It blocks even in
 *   bypass mode.
 * - Allow list is enforced in normal mode. In bypass mode it is ignored.
 */
export class CommandPolicy {
    private allow: RegExp[] = [];
    private deny: RegExp[] = [];

    update(allow: string[], deny: string[]): void {
        this.allow = allow.map((p) => safeRegex(p));
        this.deny = deny.map((p) => safeRegex(p));
    }

    check(command: string, mode: PermissionMode): void {
        const trimmed = command.trim();
        for (const re of this.deny) {
            if (re.test(trimmed)) {
                throw new CommandPolicyError(
                    `Command blocked by deny list (pattern ${re.source}): ${trimmed}`,
                );
            }
        }
        if (mode === 'bypass') {
            return;
        }
        if (this.allow.length === 0) {
            return;
        }
        const allowed = this.allow.some((re) => re.test(trimmed));
        if (!allowed) {
            throw new CommandPolicyError(
                `Command not in allow list (normal mode). Switch to bypass mode or add a pattern. Command: ${trimmed}`,
            );
        }
    }
}

function safeRegex(pattern: string): RegExp {
    try {
        return new RegExp(pattern);
    } catch {
        // Fall back to literal-prefix match if the pattern is malformed.
        return new RegExp('^' + escapeRegex(pattern));
    }
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
