import * as vscode from 'vscode';
import WebSocket from 'ws';
import {
    ErrorEnvelope,
    HealthResponse,
    InferRequest,
    InferResponse,
    ModelHostError,
    ModelLifecycleResponse,
    ModelStatusResponse,
    StreamEvent,
    StreamInferMessage,
} from './contracts';
import { CancelledError } from '../util/cancellation';
import { uuidv7 } from '../util/uuid';
import { log } from '../util/logger';

export interface ModelHostClientOptions {
    baseUrl: string;
    callerService: string;
}

/**
 * Caller-side client for the swirlock-llm-host v2 Model Host API.
 *
 * Owns: HTTP transport, WebSocket transport, correlation IDs, envelope
 * unwrapping, error mapping, cancellation propagation.
 *
 * Knows nothing about prompts, agents, or VS Code chat.
 */
export class ModelHostClient {
    constructor(private opts: ModelHostClientOptions) {}

    update(opts: Partial<ModelHostClientOptions>): void {
        this.opts = { ...this.opts, ...opts };
    }

    get baseUrl(): string {
        return this.opts.baseUrl.replace(/\/+$/, '');
    }

    // ----- single-shot inference -----------------------------------------

    async infer(req: InferRequest, token: vscode.CancellationToken, correlationId?: string): Promise<InferResponse> {
        const cid = correlationId ?? uuidv7();
        const url = `${this.baseUrl}/v2/infer`;
        const ctrl = new AbortController();
        const sub = token.onCancellationRequested(() => ctrl.abort());
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-correlation-id': cid,
                },
                body: JSON.stringify(req),
                signal: ctrl.signal,
            });
            const text = await res.text();
            const json = this.parseJson(text);
            if (!res.ok || (json && typeof json === 'object' && 'error' in (json as object))) {
                throw ModelHostError.fromEnvelope(json as ErrorEnvelope);
            }
            return json as InferResponse;
        } catch (e) {
            if ((e as Error).name === 'AbortError') {
                throw new CancelledError();
            }
            throw this.normaliseError(e, cid);
        } finally {
            sub.dispose();
        }
    }

    // ----- streaming inference -------------------------------------------

    /**
     * Stream inference over WebSocket. Yields StreamEvents in order.
     * Closes the socket on any terminal event (`done`, `error`) or on cancellation.
     */
    async *stream(
        req: InferRequest,
        token: vscode.CancellationToken,
        correlationId?: string,
    ): AsyncGenerator<StreamEvent, void, void> {
        const cid = correlationId ?? uuidv7();
        const url = this.toWsUrl(`${this.baseUrl}/v2/infer/stream`);

        const ws = new WebSocket(url, {
            headers: { 'x-correlation-id': cid },
        });

        const queue: StreamEvent[] = [];
        let resolveNext: (() => void) | null = null;
        let socketErr: Error | null = null;
        let closed = false;

        const wake = () => {
            if (resolveNext) {
                const fn = resolveNext;
                resolveNext = null;
                fn();
            }
        };

        ws.on('open', () => {
            const msg: StreamInferMessage = { type: 'infer', correlationId: cid, request: req };
            ws.send(JSON.stringify(msg));
        });
        ws.on('message', (data: WebSocket.RawData) => {
            const text = typeof data === 'string' ? data : data.toString('utf8');
            try {
                const ev = JSON.parse(text) as StreamEvent;
                queue.push(ev);
                wake();
            } catch (e) {
                socketErr = new Error(`Malformed stream event: ${(e as Error).message}`);
                wake();
            }
        });
        ws.on('error', (err: Error) => {
            socketErr = err;
            wake();
        });
        ws.on('close', () => {
            closed = true;
            wake();
        });

        const cancelSub = token.onCancellationRequested(() => {
            try {
                ws.close(1000, 'cancelled');
            } catch {
                /* ignore */
            }
            wake();
        });

        try {
            while (true) {
                if (token.isCancellationRequested) {
                    throw new CancelledError();
                }
                if (queue.length === 0) {
                    if (socketErr) {
                        throw this.normaliseError(socketErr, cid);
                    }
                    if (closed) {
                        return;
                    }
                    await new Promise<void>((res) => {
                        resolveNext = res;
                    });
                    continue;
                }
                const ev = queue.shift()!;
                yield ev;
                if (ev.type === 'done' || ev.type === 'error') {
                    try {
                        ws.close(1000, ev.type);
                    } catch {
                        /* ignore */
                    }
                    return;
                }
            }
        } finally {
            cancelSub.dispose();
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                try {
                    ws.close();
                } catch {
                    /* ignore */
                }
            }
        }
    }

    // ----- lifecycle / health --------------------------------------------

    async health(token: vscode.CancellationToken): Promise<HealthResponse> {
        return this.getJson<HealthResponse>('/v2/health', token);
    }

    async modelStatus(token: vscode.CancellationToken): Promise<ModelStatusResponse> {
        return this.getJson<ModelStatusResponse>('/v2/model/status', token);
    }

    async preload(token: vscode.CancellationToken): Promise<ModelLifecycleResponse> {
        return this.postJson<ModelLifecycleResponse>('/v2/model/preload', this.lifecycleBody(), token);
    }

    async unload(token: vscode.CancellationToken): Promise<ModelLifecycleResponse> {
        return this.postJson<ModelLifecycleResponse>('/v2/model/unload', this.lifecycleBody(), token);
    }

    private lifecycleBody() {
        return {
            requestContext: {
                callerService: this.opts.callerService,
                requestedAt: new Date().toISOString(),
            },
        };
    }

    private async getJson<T>(path: string, token: vscode.CancellationToken): Promise<T> {
        const cid = uuidv7();
        const ctrl = new AbortController();
        const sub = token.onCancellationRequested(() => ctrl.abort());
        try {
            const res = await fetch(`${this.baseUrl}${path}`, {
                headers: { 'x-correlation-id': cid },
                signal: ctrl.signal,
            });
            const text = await res.text();
            const json = this.parseJson(text);
            if (!res.ok || (json && typeof json === 'object' && 'error' in (json as object))) {
                throw ModelHostError.fromEnvelope(json as ErrorEnvelope);
            }
            return json as T;
        } catch (e) {
            if ((e as Error).name === 'AbortError') {
                throw new CancelledError();
            }
            throw this.normaliseError(e, cid);
        } finally {
            sub.dispose();
        }
    }

    private async postJson<T>(path: string, body: unknown, token: vscode.CancellationToken): Promise<T> {
        const cid = uuidv7();
        const ctrl = new AbortController();
        const sub = token.onCancellationRequested(() => ctrl.abort());
        try {
            const res = await fetch(`${this.baseUrl}${path}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-correlation-id': cid,
                },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
            const text = await res.text();
            const json = this.parseJson(text);
            if (!res.ok || (json && typeof json === 'object' && 'error' in (json as object))) {
                throw ModelHostError.fromEnvelope(json as ErrorEnvelope);
            }
            return json as T;
        } catch (e) {
            if ((e as Error).name === 'AbortError') {
                throw new CancelledError();
            }
            throw this.normaliseError(e, cid);
        } finally {
            sub.dispose();
        }
    }

    private parseJson(text: string): unknown {
        if (!text) {
            return null;
        }
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    private normaliseError(e: unknown, cid: string): Error {
        if (e instanceof ModelHostError) {
            return e;
        }
        if (e instanceof CancelledError) {
            return e;
        }
        const msg = e instanceof Error ? e.message : String(e);
        log().warn(`Model host transport error (cid=${cid}): ${msg}`);
        return new ModelHostError('upstream_unavailable', msg, true, undefined, cid);
    }

    private toWsUrl(httpUrl: string): string {
        if (httpUrl.startsWith('https://')) {
            return 'wss://' + httpUrl.slice('https://'.length);
        }
        if (httpUrl.startsWith('http://')) {
            return 'ws://' + httpUrl.slice('http://'.length);
        }
        return httpUrl;
    }
}
