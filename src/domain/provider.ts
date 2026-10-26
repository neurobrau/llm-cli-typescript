import type { GenerationOutcome, GenerationRequest, ProviderId, StreamEvent } from "./generation.js";
import type { ModelCapabilities } from "./settings.js";

/** A model reported by a provider's discovery API. */
export interface ModelInfo {
  readonly id: string;
  /** Runs on a remote service although listed locally. */
  readonly remote: boolean;
  /** Reported capability tags. Absent: not reported; `[]`: confirmed none. */
  readonly capabilities?: readonly string[];
  readonly details?: string;
  /** Context window size; a separate fact from the output-token limit. */
  readonly contextLength?: number;
}

export interface Availability {
  readonly available: boolean;
  readonly message: string;
}

/**
 * What the application needs from an LLM provider. Every asynchronous method
 * takes an AbortSignal; cancellation rejects (or the stream throws) with an
 * AbortError, never a ProviderError. Failures reject with ProviderError.
 */
export interface Provider {
  /** CLI value, e.g. "ollama". */
  readonly id: ProviderId;
  /** Display name, e.g. "Ollama". */
  readonly label: string;

  generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationOutcome>;
  stream(request: GenerationRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;

  listModels(signal: AbortSignal): Promise<readonly ModelInfo[]>;
  checkAvailability(signal: AbortSignal): Promise<Availability>;
  /** Model used when none is chosen. Rejects with ProviderError if none can be determined. */
  defaultModel(signal: AbortSignal): Promise<string>;
  getCapabilities(model: string, signal: AbortSignal): Promise<ModelCapabilities>;
}
