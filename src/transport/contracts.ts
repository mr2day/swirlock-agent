/**
 * Type definitions mirroring docs/versions/v2/openapi/model-host.openapi.yaml
 * from swirlock-chatbot-contracts. Caller-side only.
 */

export interface ApiMeta {
    requestId: string;
    correlationId: string;
    apiVersion: 'v2';
    servedAt: string;
}

export interface ErrorBody {
    code:
        | 'bad_request'
        | 'validation_failed'
        | 'upstream_unavailable'
        | 'model_unavailable'
        | 'limit_exceeded'
        | 'internal_error'
        | string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
}

export interface ErrorEnvelope {
    meta: ApiMeta;
    error: ErrorBody;
}

export interface RequestContext {
    callerService: string;
    priority?: number;
    requestedAt: string;
    debug?: boolean;
}

export interface TextInputPart {
    type: 'text';
    text: string;
}

export interface ImageInputPart {
    type: 'image';
    imageBase64?: string;
    imageUrl?: string;
    mimeType?: string;
}

export type InputPart = TextInputPart | ImageInputPart;

export interface InferenceInput {
    parts: InputPart[];
}

export interface InferenceOptions {
    responseFormat?: 'text' | 'json';
    thinking?: boolean;
    ollama?: Record<string, unknown>;
}

export interface InferRequest {
    requestContext: RequestContext;
    input: InferenceInput;
    options?: InferenceOptions;
}

export interface InferResponseData {
    modelId: string;
    output: { text: string };
    finishReason: 'stop' | 'length' | 'error';
    generatedAt: string;
    appliedOptions?: InferenceOptions;
}

export interface InferResponse {
    meta: ApiMeta;
    data: InferResponseData;
}

export interface QueueWaitInfo {
    position: number;
    requestsAhead: number;
    queueDepth: number;
    defaultPriority: boolean;
    priority?: number;
    averageRequestDurationMs?: number;
    estimatedWaitMs?: number;
    estimatedStartAt?: string;
}

export interface StreamAcceptedEvent {
    type: 'accepted';
    meta: ApiMeta;
}
export interface StreamQueuedEvent {
    type: 'queued';
    meta: ApiMeta;
    data: QueueWaitInfo;
}
export interface StreamStartedEvent {
    type: 'started';
    meta: ApiMeta;
}
export interface StreamThinkingEvent {
    type: 'thinking';
    meta: ApiMeta;
    data: { text: string };
}
export interface StreamChunkEvent {
    type: 'chunk';
    meta: ApiMeta;
    data: { text: string };
}
export interface StreamDoneEvent {
    type: 'done';
    meta: ApiMeta;
    data: { finishReason: 'stop' | 'length' | 'error'; appliedOptions?: InferenceOptions };
}
export interface StreamErrorEvent {
    type: 'error';
    meta: ApiMeta;
    error: ErrorBody;
}

export type StreamEvent =
    | StreamAcceptedEvent
    | StreamQueuedEvent
    | StreamStartedEvent
    | StreamThinkingEvent
    | StreamChunkEvent
    | StreamDoneEvent
    | StreamErrorEvent;

export interface StreamInferMessage {
    type: 'infer';
    correlationId: string;
    request: InferRequest;
}

export interface ModelCapabilities {
    textInput: boolean;
    imageInput: boolean;
    textOutput: boolean;
    imageOutput: boolean;
}

export interface ModelCapacity {
    activeRequests: number;
    modelSlots: number;
    queueDepth: number;
    averageRequestDurationMs?: number;
}

export interface HealthResponseData {
    status: 'ok' | 'degraded' | 'unavailable';
    ready: boolean;
}

export interface HealthResponse {
    meta: ApiMeta;
    data: HealthResponseData;
}

export interface ModelStatusResponseData {
    modelId: string;
    availableModels: string[];
    ready: boolean;
    loaded: boolean;
    keepAlive: string;
    capabilities: ModelCapabilities;
    capacity: ModelCapacity;
    runtime?: Record<string, unknown>;
}

export interface ModelStatusResponse {
    meta: ApiMeta;
    data: ModelStatusResponseData;
}

export interface ModelLifecycleRequest {
    requestContext: RequestContext;
}

export interface ModelLifecycleResponseData {
    accepted: boolean;
    modelId: string;
    status?: 'loading' | 'loaded' | 'unloading' | 'unloaded' | 'unsupported';
}

export interface ModelLifecycleResponse {
    meta: ApiMeta;
    data: ModelLifecycleResponseData;
}

export class ModelHostError extends Error {
    constructor(
        public readonly code: string,
        message: string,
        public readonly retryable: boolean,
        public readonly details?: Record<string, unknown>,
        public readonly correlationId?: string,
    ) {
        super(message);
        this.name = 'ModelHostError';
    }

    static fromEnvelope(env: ErrorEnvelope): ModelHostError {
        return new ModelHostError(
            env.error.code,
            env.error.message,
            env.error.retryable,
            env.error.details,
            env.meta.correlationId,
        );
    }
}
