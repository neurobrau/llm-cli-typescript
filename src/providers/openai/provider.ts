import { ProviderError, createAbortError, ensureNotAborted } from "../../domain/errors.js";
import { snapshotRequest } from "../../domain/generation.js";
import type { GenerationOutcome, GenerationRequest, ProviderId, StreamEvent } from "../../domain/generation.js";
import type { Availability, ModelInfo, Provider } from "../../domain/provider.js";
import type { ModelCapabilities } from "../../domain/settings.js";
import { DEFAULT_MODEL, capabilitiesFor, isTextModel } from "./capabilities.js";
import { buildParams, convertResponse } from "./convert.js";
import { apiError, missingApiKeyError, providerErrorFor, rejectsReasoning } from "./errors.js";
import type { SdkFailure } from "./errors.js";
import { createOpenAiApi, describeSdkError } from "./sdk.js";
import type { OpenAiApi, RequestControl } from "./sdk.js";

export const GENERATION_TIMEOUT_MS = 60_000;
export const MODEL_LIST_TIMEOUT_MS = 5_000;

export interface OpenAIProviderOptions {
  /**
   * Returns the raw API key, or undefined. Called on every operation that
   * needs the network, never at construction. Production composition passes a
   * reader of OPENAI_API_KEY; tests pass a synthetic key.
   */
  readonly getApiKey: () => string | undefined;
  /** Builds the SDK boundary for a trimmed key. Default: the real SDK client (lazily, no I/O). */
  readonly createApi?: (apiKey: string) => OpenAiApi;
  readonly generationTimeoutMs?: number;
  readonly modelListTimeoutMs?: number;
}

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: SdkFailure };

interface Deadline {
  readonly control: RequestControl;
  timedOut(): boolean;
  dispose(): void;
}

/**
 * Combines the caller's signal with a deadline that also covers reading the
 * response body. The adapter owns the listener and timer and removes both in
 * `dispose`.
 */
function startDeadline(signal: AbortSignal, timeoutMs: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => {
    controller.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    control: { signal: controller.signal, timeoutMs },
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

/** OpenAI Responses API provider (non-streaming). */
export class OpenAIProvider implements Provider {
  readonly id: ProviderId = "openai";
  readonly label = "OpenAI";

  private readonly generationTimeoutMs: number;
  private readonly modelListTimeoutMs: number;
  private readonly createApi: (apiKey: string) => OpenAiApi;
  private client: { readonly key: string; readonly api: OpenAiApi } | undefined;
  private models: readonly ModelInfo[] | undefined;
  /** Models that rejected the built-in reasoning default in this instance. */
  private readonly rejectedReasoning = new Set<string>();

  constructor(private readonly options: OpenAIProviderOptions) {
    this.generationTimeoutMs = options.generationTimeoutMs ?? GENERATION_TIMEOUT_MS;
    this.modelListTimeoutMs = options.modelListTimeoutMs ?? MODEL_LIST_TIMEOUT_MS;
    this.createApi = options.createApi ?? ((apiKey) => createOpenAiApi({ apiKey }));
  }

  async generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationOutcome> {
    const snapshot = snapshotRequest(request); // before the first await
    ensureNotAborted(signal);
    const { key, api } = this.connection();
    const choice = snapshot.reasoning;
    const rejected = this.rejectedReasoning.has(snapshot.model);
    const effort = choice.effort !== undefined && !choice.explicit && rejected ? undefined : choice.effort;

    let attempt = await this.send(api, key, snapshot, effort, signal);
    if (!attempt.ok && effort !== undefined && rejectsReasoning(attempt.failure)) {
      if (choice.explicit) {
        const detail = providerErrorFor(attempt.failure, [key]).message;
        throw apiError(
          `${snapshot.model} does not accept reasoning effort '${effort}' (${detail}). Choose another value with --reasoning-effort.`,
        );
      }
      // A built-in default the model rejects: remember it and retry once without it.
      ensureNotAborted(signal);
      this.rejectedReasoning.add(snapshot.model);
      attempt = await this.send(api, key, snapshot, undefined, signal);
    }
    if (!attempt.ok) {
      throw providerErrorFor(attempt.failure, [key]);
    }
    return attempt.value;
  }

  /**
   * Streaming is not implemented in this task. Lazily yields one normalized
   * failed event, with no key access or network; cancellation throws AbortError.
   */
  async *stream(_request: GenerationRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    ensureNotAborted(signal);
    await Promise.resolve();
    ensureNotAborted(signal);
    yield {
      kind: "failed",
      error: apiError("OpenAI streaming is not implemented yet."),
      partialText: "",
    };
    ensureNotAborted(signal);
  }

  async listModels(signal: AbortSignal): Promise<readonly ModelInfo[]> {
    ensureNotAborted(signal);
    if (this.models !== undefined) {
      await Promise.resolve();
      ensureNotAborted(signal);
      return this.models;
    }
    const { key, api } = this.connection();
    const attempt = await this.guarded(signal, this.modelListTimeoutMs, async (control) => api.listModels(control));
    if (!attempt.ok) {
      throw providerErrorFor(attempt.failure, [key]);
    }
    const models = parseModels(attempt.value);
    ensureNotAborted(signal); // before the cache write
    this.models = models;
    return models;
  }

  async checkAvailability(signal: AbortSignal): Promise<Availability> {
    try {
      await this.listModels(signal);
    } catch (error: unknown) {
      if (error instanceof ProviderError) {
        return { available: false, message: error.message };
      }
      throw error;
    }
    return { available: true, message: "" };
  }

  async defaultModel(signal: AbortSignal): Promise<string> {
    ensureNotAborted(signal);
    await Promise.resolve();
    ensureNotAborted(signal);
    return DEFAULT_MODEL;
  }

  async getCapabilities(model: string, signal: AbortSignal): Promise<ModelCapabilities> {
    ensureNotAborted(signal);
    await Promise.resolve();
    ensureNotAborted(signal);
    return capabilitiesFor(model, this.rejectedReasoning.has(model));
  }

  private async send(
    api: OpenAiApi,
    key: string,
    request: GenerationRequest,
    effort: string | undefined,
    signal: AbortSignal,
  ): Promise<Attempt<GenerationOutcome>> {
    const params = buildParams(request, effort);
    const attempt = await this.guarded(signal, this.generationTimeoutMs, async (control) =>
      api.createResponse(params, control),
    );
    if (!attempt.ok) {
      return attempt;
    }
    return { ok: true, value: convertResponse(attempt.value, [key]) };
  }

  /** Runs one SDK call under the deadline; abort wins over every other classification. */
  private async guarded<T>(
    signal: AbortSignal,
    timeoutMs: number,
    run: (control: RequestControl) => Promise<T>,
  ): Promise<Attempt<T>> {
    ensureNotAborted(signal);
    const deadline = startDeadline(signal, timeoutMs);
    try {
      const value = await run(deadline.control);
      ensureNotAborted(signal);
      return { ok: true, value };
    } catch (error: unknown) {
      if (signal.aborted) {
        throw createAbortError();
      }
      if (error instanceof ProviderError) {
        throw error;
      }
      return { ok: false, failure: deadline.timedOut() ? { kind: "timeout" } : describeSdkError(error) };
    } finally {
      deadline.dispose();
    }
  }

  /** The API boundary for the current key; created lazily. Throws missing_api_key. */
  private connection(): { readonly key: string; readonly api: OpenAiApi } {
    const key = this.options.getApiKey()?.trim() ?? "";
    if (key === "") {
      throw missingApiKeyError();
    }
    if (this.client?.key !== key) {
      this.client = { key, api: this.createApi(key) };
    }
    return this.client;
  }
}

/** Text-capable IDs from a raw Models API body: validated, deduplicated, sorted. */
function parseModels(raw: unknown): readonly ModelInfo[] {
  const data: unknown = typeof raw === "object" && raw !== null && "data" in raw ? raw.data : undefined;
  if (!Array.isArray(data)) {
    throw apiError("Invalid response from OpenAI: model list is malformed.");
  }
  const ids = new Set<string>();
  for (const item of data as unknown[]) {
    const id: unknown = typeof item === "object" && item !== null && "id" in item ? item.id : undefined;
    if (typeof id === "string" && id !== "" && isTextModel(id)) {
      ids.add(id);
    }
  }
  return Object.freeze([...ids].sort().map((id) => Object.freeze({ id, remote: false })));
}
