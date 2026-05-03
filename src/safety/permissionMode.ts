import * as vscode from 'vscode';
import { PermissionMode, readConfig, setPermissionMode } from '../config/Config';

/**
 * Holds the current permission mode and emits an event when it changes.
 * Source of truth is the workspace setting; this class is a cached view + toggle.
 */
export class PermissionModeController {
    private _mode: PermissionMode;
    private readonly _onChange = new vscode.EventEmitter<PermissionMode>();
    readonly onChange = this._onChange.event;

    constructor() {
        this._mode = readConfig().permissionMode;
    }

    get mode(): PermissionMode {
        return this._mode;
    }

    refresh(): void {
        const next = readConfig().permissionMode;
        if (next !== this._mode) {
            this._mode = next;
            this._onChange.fire(next);
        }
    }

    async toggle(): Promise<PermissionMode> {
        const next: PermissionMode = this._mode === 'normal' ? 'bypass' : 'normal';
        await setPermissionMode(next);
        this._mode = next;
        this._onChange.fire(next);
        return next;
    }

    dispose(): void {
        this._onChange.dispose();
    }
}
