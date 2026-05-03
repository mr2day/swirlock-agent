import * as path from 'path';
import * as fs from 'fs/promises';

export class PathJailError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PathJailError';
    }
}

/**
 * Workspace boundary enforcement. Resolves a (possibly user-supplied,
 * possibly model-supplied) path against the workspace root and rejects:
 *   - absolute paths outside the root
 *   - relative paths that climb above the root via ..
 *   - symlinks that escape the root (checked on real fs lookups)
 */
export class PathJail {
    constructor(private readonly root: string) {}

    /** Pure-text resolution. Throws on traversal escape. */
    resolve(relOrAbs: string): string {
        if (!relOrAbs || typeof relOrAbs !== 'string') {
            throw new PathJailError('Path must be a non-empty string.');
        }
        const abs = path.isAbsolute(relOrAbs)
            ? path.normalize(relOrAbs)
            : path.normalize(path.join(this.root, relOrAbs));
        if (!this.isInside(abs)) {
            throw new PathJailError(`Path escapes the workspace root: ${relOrAbs}`);
        }
        return abs;
    }

    /** Resolve and resolve symlinks. Use before reads/writes. */
    async realResolve(relOrAbs: string): Promise<string> {
        const abs = this.resolve(relOrAbs);
        try {
            const real = await fs.realpath(abs);
            if (!this.isInside(real)) {
                throw new PathJailError(`Symlink escapes the workspace root: ${relOrAbs}`);
            }
            return real;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                // For not-yet-existing paths (writes), check the parent dir.
                const parent = path.dirname(abs);
                try {
                    const realParent = await fs.realpath(parent);
                    if (!this.isInside(realParent)) {
                        throw new PathJailError(`Parent symlink escapes the workspace root: ${relOrAbs}`);
                    }
                } catch (inner) {
                    if ((inner as NodeJS.ErrnoException).code !== 'ENOENT') {
                        throw inner;
                    }
                    // Parent does not exist either — caller will deal with it.
                }
                return abs;
            }
            throw e;
        }
    }

    private isInside(abs: string): boolean {
        const rel = path.relative(this.root, abs);
        if (rel === '') {
            return true;
        }
        if (rel.startsWith('..')) {
            return false;
        }
        if (path.isAbsolute(rel)) {
            return false;
        }
        return true;
    }
}
