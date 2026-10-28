/**
 * Request construction and response conversion. Responses are validated as
 * `unknown`; nothing from the wire is cast to a trusted type.
 */
import type {
  GenerationOutcome,
  GenerationRequest,
  GenerationResult,
  TokenUsage,
} from "../../domain/generation.js";
import { apiError } from "./errors.js";
import { safeText } from "../redact.js";

/** Plain Responses API request body for a text-only, one-shot call. */
export interface ResponseParams {
  readonly model: string;
  readonly input: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly instructions?: string;
  readonly reasoning?: { readonly effort: string };
  readonly store: false;
  readonly max_output_tokens?: number;
}

/**
 * Maps a request snapshot to API parameters. `effort` is passed separately so
 * the caller decides whether to omit it (fallback); provenance and other
 * internal fields are never serialized.
 */
export function buildParams(request: GenerationRequest, effort: string | undefined): ResponseParams {
  return {
    model: request.model,
    input: request.messages.map(({ role, content }) => ({ role, content })),
    store: false,
    ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
    ...(effort === undefined ? {} : { reasoning: { effort } }),
    ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
  };
}

type Record_ = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Converts a raw (JSON-decoded) Responses API body; throws a normalized ProviderError on failure. */
export function convertResponse(raw: unknown, secrets: readonly string[]): GenerationOutcome {
  if (!isRecord(raw)) {
    throw apiError("Invalid response from OpenAI: empty reply.");
  }
  const { status } = raw;
  if (status === "failed") {
    const message = isRecord(raw.error) && typeof raw.error.message === "string" ? safeText(raw.error.message, secrets) : "";
    throw apiError(`OpenAI response failed: ${message === "" ? "no details" : message}`);
  }
  if (status !== "completed" && status !== "incomplete") {
    const shown = typeof status === "string" ? safeText(status, secrets) : "missing";
    throw apiError(`OpenAI response did not complete (status '${shown}').`);
  }
  if (!Array.isArray(raw.output)) {
    throw apiError("Invalid response from OpenAI: no output.");
  }
  const { text, refusal } = outputText(raw.output);
  const usage = convertUsage(raw.usage);
  const serviceTier = typeof raw.service_tier === "string" ? raw.service_tier : undefined;
  const extras = {
    ...(usage === undefined ? {} : { usage }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };

  if (status === "incomplete") {
    const details = raw.incomplete_details;
    const reason = isRecord(details) && typeof details.reason === "string" ? details.reason : "";
    return { kind: "incomplete", reason: incompleteReason(reason, secrets), partialText: text, ...extras };
  }
  if (text === "") {
    throw apiError(
      refusal === ""
        ? "OpenAI returned a completed response with no answer text."
        : `OpenAI refused the request: ${safeText(refusal, secrets)}`,
    );
  }
  const result: GenerationResult = { text, ...extras };
  return { kind: "completed", result };
}

/**
 * Joins `output_text` parts of message items in order. Refusals are collected
 * separately; reasoning, tool and other items are never answer text.
 */
function outputText(output: readonly unknown[]): { text: string; refusal: string } {
  let text = "";
  let refusal = "";
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message") {
      continue;
    }
    const content: unknown = item.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content as unknown[]) {
      if (!isRecord(part)) {
        continue;
      }
      if (part.type === "output_text" && typeof part.text === "string") {
        text += part.text;
      } else if (part.type === "refusal" && typeof part.refusal === "string") {
        refusal += part.refusal;
      }
    }
  }
  return { text, refusal };
}

function incompleteReason(reason: string, secrets: readonly string[]): string {
  switch (reason) {
    case "max_output_tokens":
      return "the max output token limit was reached";
    case "content_filter":
      return "the content filter stopped the response";
    case "":
      return "unknown reason";
    default: {
      const shown = safeText(reason, secrets);
      return shown === "" ? "unknown reason" : shown;
    }
  }
}

/**
 * A reported count becomes a bigint only if it is a non-negative safe integer.
 * Anything else (missing, null, negative, fractional, non-numeric, or beyond
 * 2^53-1, where JSON decoding has already rounded) is treated as not
 * reported: BigInt(number) cannot recover digits the decoder lost.
 */
function toCount(value: unknown): bigint | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
}

export function convertUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const inputs = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {};
  const outputs = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {};
  const fields: readonly (readonly [keyof TokenUsage, bigint | undefined])[] = [
    ["inputTokens", toCount(raw.input_tokens)],
    ["outputTokens", toCount(raw.output_tokens)],
    ["totalTokens", toCount(raw.total_tokens)],
    ["cachedInputTokens", toCount(inputs.cached_tokens)],
    ["cacheWriteTokens", toCount(inputs.cache_write_tokens)],
    ["reasoningTokens", toCount(outputs.reasoning_tokens)],
  ];
  const usage: { -readonly [K in keyof TokenUsage]: TokenUsage[K] } = {};
  for (const [key, value] of fields) {
    if (value !== undefined) {
      usage[key] = value;
    }
  }
  return usage;
}

