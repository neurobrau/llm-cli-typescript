/**
 * The only module that imports the OpenAI SDK. It exposes a tiny SDK-free
 * interface so the rest of the adapter and its tests never touch SDK types.
 */
import OpenAI from "openai";
import type { ReasoningEffort } from "openai/resources/shared";

import type { ResponseParams } from "./convert.js";
import type { SdkFailure } from "./errors.js";

export interface RequestControl {
  readonly signal: AbortSignal;
  /** Milliseconds; also enforced by the adapter across the body read. */
  readonly timeoutMs: number;
}

/** What a streaming request exposes: raw decoded events, pulled one at a time. */
export interface RawEventStream {
  /**
   * The next raw event, or `done`. The SDK ends quietly (no throw) when the
   * request is aborted, so callers decide from their own signal why it ended.
   */
  next(): Promise<{ readonly done: boolean; readonly value?: unknown }>;
  /** Aborts the request and releases the SDK stream; safe while a `next()` is pending. */
  close(): Promise<void>;
}

export interface StreamControl {
  /** Aborting it cancels the request and ends a pending read. */
  readonly signal: AbortSignal;
  /** Connect-and-headers wait of the SDK (it does not bound the body). */
  readonly openTimeoutMs: number;
}

export interface OpenAiApi {
  /** Raw decoded response body; validated by the caller. */
  createResponse(params: ResponseParams, control: RequestControl): Promise<unknown>;
  /** Opens a streaming request (`stream: true`); resolves once the headers arrived. */
  streamResponse(params: ResponseParams, control: StreamControl): Promise<RawEventStream>;
  /** The Models API list (a single unpaginated page): `{ data }`, validated by the caller. */
  listModels(control: RequestControl): Promise<unknown>;
}

export interface OpenAiApiConfig {
  readonly apiKey: string;
  /** Programmatic test seam only; production uses the ordinary OpenAI endpoint. */
  readonly baseURL?: string;
  /** Programmatic test seam only. */
  readonly fetch?: typeof fetch;
}

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Headers the SDK itself sets; anything else (e.g. from OPENAI_CUSTOM_HEADERS) is dropped. */
const ALLOWED_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "authorization",
  "content-type",
  "content-length",
  "user-agent",
  "connection",
  "host",
]);

function isAllowedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_HEADERS.has(lower) || lower.startsWith("x-stainless-");
}

/**
 * The SDK reads OPENAI_CUSTOM_HEADERS from the ambient environment and offers
 * no option to disable it (checked in 7.45.0). Rebuilding request headers from
 * an allowlist keeps unrelated ambient settings out of the request.
 */
function sanitizingFetch(base: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const name of [...headers.keys()]) {
      if (!isAllowedHeader(name)) {
        headers.delete(name);
      }
    }
    return base(input, { ...init, headers });
  };
}

export function createOpenAiApi(config: OpenAiApiConfig): OpenAiApi {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? OPENAI_BASE_URL,
    // Do not inherit unrelated settings from the environment.
    organization: null,
    project: null,
    adminAPIKey: null,
    webhookSecret: null,
    logLevel: "off",
    maxRetries: 0,
    fetch: sanitizingFetch(config.fetch ?? globalThis.fetch),
  });
  const body = (params: ResponseParams) => ({
    model: params.model,
    input: params.input.map(({ role, content }) => ({ role, content })),
    store: false as const,
    ...(params.instructions === undefined ? {} : { instructions: params.instructions }),
    ...(params.reasoning === undefined ? {} : { reasoning: { effort: toSdkEffort(params.reasoning.effort) } }),
    ...(params.max_output_tokens === undefined ? {} : { max_output_tokens: params.max_output_tokens }),
  });
  return {
    async createResponse(params, control) {
      return client.responses.create(body(params), { signal: control.signal, timeout: control.timeoutMs, maxRetries: 0 });
    },
    async streamResponse(params, control) {
      const stream = await client.responses.create(
        { ...body(params), stream: true },
        { signal: control.signal, timeout: control.openTimeoutMs, maxRetries: 0 },
      );
      const iterator = stream[Symbol.asyncIterator]();
      return {
        next: async () => {
          const result = await iterator.next();
          return result.done === true ? { done: true } : { done: false, value: result.value };
        },
        close: async () => {
          // Abort first: a generator's return() would otherwise wait for a pending read.
          stream.controller.abort();
          try {
            await iterator.return?.();
          } catch {
            // Release failures never replace the stream's own outcome.
          }
        },
      };
    },
    async listModels(control) {
      // The endpoint is a single unpaginated list; `data` is the only field used.
      const page = await client.models.list({ signal: control.signal, timeout: control.timeoutMs, maxRetries: 0 });
      return { data: page.data };
    },
  };
}

/**
 * Efforts are the provider's vocabulary and unknown models pass explicit
 * values through for the API to judge, so the SDK's closed union is too narrow.
 * This is the single typing accommodation; the value is sent unchanged.
 */
function toSdkEffort(effort: string): ReasoningEffort {
  return effort as ReasoningEffort;
}

/** Describes an SDK error without exposing SDK types or raw text. */
export function describeSdkError(error: unknown): SdkFailure {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return { kind: "timeout" };
  }
  if (error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.APIUserAbortError) {
    return { kind: "connection" };
  }
  if (error instanceof OpenAI.APIError && error.status === undefined) {
    // An error event inside an otherwise successful stream.
    const body: unknown = error.error;
    const detail = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : undefined;
    return { kind: "stream", ...(detail === undefined ? {} : { detail }) };
  }
  if (error instanceof OpenAI.APIError && typeof error.status === "number") {
    const body: unknown = error.error;
    const detail = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : undefined;
    return {
      kind: "status",
      status: error.status,
      ...(typeof error.param === "string" ? { param: error.param } : {}),
      ...(detail === undefined ? {} : { detail }),
    };
  }
  return { kind: "other" };
}
