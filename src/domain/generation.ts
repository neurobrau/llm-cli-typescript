/**
 * Provider-independent generation contracts. These are internal types, not the
 * persisted JSON schema, and contain no SDK objects.
 */
import type { ProviderError } from "./errors.js";

export type ProviderId = "openai" | "ollama";

/** Where a resolved setting came from. */
export type ValueSource = "cli" | "saved" | "builtin";

export type Role = "user" | "assistant";

/** Reasoning never becomes answer text or a history message. */
export interface Message {
  readonly role: Role;
  readonly content: string;
}

/**
 * Token counts exactly as reported. An absent field means "not reported";
 * `0n` means reported zero. Missing counts are never inferred. Counts are
 * non-negative bigints so storage is not forced into lossy JS numbers.
 * Cached-input and cache-write counts are parts of the input count; reasoning
 * tokens are part of the output count.
 */
export interface TokenUsage {
  readonly inputTokens?: bigint;
  readonly outputTokens?: bigint;
  readonly totalTokens?: bigint;
  readonly cachedInputTokens?: bigint;
  readonly cacheWriteTokens?: bigint;
  readonly reasoningTokens?: bigint;
}

/**
 * The resolved reasoning choice for one request, in the provider's vocabulary.
 *
 * - `effort` absent: the parameter is omitted. With `explicit: true` the user
 *   chose "model default"; with `explicit: false` nothing was chosen.
 * - `effort` present, `explicit: false`: a built-in default (e.g. `none`) that
 *   a future adapter may retry without the parameter if the API rejects it.
 * - `effort` present, `explicit: true`: a user choice that must be reported if
 *   rejected, never silently dropped.
 */
export interface ReasoningChoice {
  readonly effort?: string;
  readonly explicit: boolean;
  readonly source: ValueSource;
}

/** An immutable snapshot of everything a provider needs for one request. */
export interface GenerationRequest {
  readonly model: string;
  /** Oldest first; excludes instructions. */
  readonly messages: readonly Message[];
  readonly reasoning: ReasoningChoice;
  /** Positive safe integer; absent: the model's default. */
  readonly maxOutputTokens?: number;
  /** System/developer instruction for this request only; not a history message. */
  readonly instructions?: string;
}

export interface GenerationResult {
  readonly text: string;
  readonly usage?: TokenUsage;
  /** Separate from `text`. */
  readonly reasoning?: string;
  /** Present-but-empty ("") is a reported empty tier, distinct from absent. */
  readonly serviceTier?: string;
}

/** Generation that stopped early (e.g. the token limit). Not a provider failure. */
export interface IncompleteGeneration {
  readonly reason: string;
  /** Only what arrived; must not be presented as a complete answer. */
  readonly partialText: string;
  readonly usage?: TokenUsage;
  readonly serviceTier?: string;
}

/** Non-streaming outcome. A provider failure rejects with ProviderError instead. */
export type GenerationOutcome =
  | { readonly kind: "completed"; readonly result: GenerationResult }
  | ({ readonly kind: "incomplete" } & IncompleteGeneration);

export interface StreamTiming {
  readonly totalSeconds?: number;
  readonly loadSeconds?: number;
  readonly promptEvalSeconds?: number;
  readonly evalSeconds?: number;
}

export interface StreamMetadata {
  readonly model?: string;
  readonly responseId?: string;
  readonly doneReason?: string;
  readonly timing?: StreamTiming;
}

/**
 * Stream lifecycle: full consumption yields any number of text/reasoning
 * deltas and then exactly one terminal event (completed, incomplete or
 * failed), and nothing after it. Early consumer return (iterator `return()`)
 * releases resources and need not deliver a terminal event. Cancellation is
 * not an event: the iterator throws an AbortError, with no invented usage.
 */
export type StreamEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "completed"; readonly result: GenerationResult; readonly metadata?: StreamMetadata }
  | ({ readonly kind: "incomplete"; readonly metadata?: StreamMetadata } & IncompleteGeneration)
  | {
      readonly kind: "failed";
      readonly error: ProviderError;
      readonly partialText: string;
      readonly metadata?: StreamMetadata;
    };

export type TerminalStreamEvent = Extract<StreamEvent, { kind: "completed" | "incomplete" | "failed" }>;

export function isTerminalEvent(event: StreamEvent): event is TerminalStreamEvent {
  return event.kind === "completed" || event.kind === "incomplete" || event.kind === "failed";
}

/** Deep, frozen copy so later mutation of caller-owned data cannot change a request. */
export function snapshotRequest(request: GenerationRequest): GenerationRequest {
  const { reasoning, messages, ...rest } = request;
  return Object.freeze({
    ...rest,
    messages: Object.freeze(messages.map((message) => Object.freeze({ ...message }))),
    reasoning: Object.freeze({ ...reasoning }),
  });
}
