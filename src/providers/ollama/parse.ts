/**
 * Validation of Ollama's JSON replies. Parsed values are `unknown` until
 * checked; optional fields of an unexpected type are ignored, required ones
 * fail with a safe ProviderError.
 */
import { ProviderError } from "../../domain/errors.js";
import type { GenerationOutcome, TokenUsage } from "../../domain/generation.js";
import type { ModelInfo } from "../../domain/provider.js";
import { safeText } from "../redact.js";

export const INCOMPLETE_REASON = "the max output token limit was reached";

export function invalidResponse(reason: string): ProviderError {
  return new ProviderError(`Invalid response from Ollama: ${reason}.`, "api");
}

type JsonObject = Readonly<Record<string, unknown>>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isTruthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== "";
}

/** Cloud models use a `cloud` tag: `glm-4.7:cloud`, `gemma4:31b-cloud`. */
export function isCloudName(id: string): boolean {
  const tag = id.slice(id.lastIndexOf(":") + 1);
  return tag === "cloud" || tag.endsWith("-cloud");
}

// ----- /api/tags -----

export interface TagEntry {
  readonly info: ModelInfo;
  /** Changes when the installed model changes; used to drop stale metadata. */
  readonly fingerprint: string;
}

export function parseTags(data: unknown): readonly TagEntry[] {
  const models = asObject(data)?.models;
  if (!Array.isArray(models)) {
    throw invalidResponse("expected an object with a 'models' list");
  }
  return Object.freeze((models as unknown[]).map(parseTagEntry));
}

function parseTagEntry(raw: unknown): TagEntry {
  const entry = asObject(raw);
  if (entry === undefined) {
    throw invalidResponse("model entry is not an object");
  }
  const id = nonEmptyString(entry.model) ?? nonEmptyString(entry.name);
  if (id === undefined) {
    throw invalidResponse("model entry has no name");
  }
  const remote = isTruthy(entry.remote_host) || isTruthy(entry.remote_model) || isCloudName(id);
  const capabilities = Array.isArray(entry.capabilities)
    ? (entry.capabilities as unknown[]).filter((item): item is string => typeof item === "string")
    : undefined;
  const details = asObject(entry.details) ?? {};
  const summary = [details.parameter_size, details.quantization_level]
    .filter((item): item is string => typeof item === "string" && item !== "")
    .join(" ");
  const context = details.context_length;
  const contextLength = typeof context === "number" && Number.isSafeInteger(context) && context > 0 ? context : undefined;
  const info: ModelInfo = Object.freeze({
    id,
    remote,
    ...(capabilities === undefined ? {} : { capabilities: Object.freeze(capabilities) }),
    ...(summary === "" ? {} : { details: summary }),
    ...(contextLength === undefined ? {} : { contextLength }),
  });
  const fingerprint = JSON.stringify([id, entry.digest, entry.modified_at, capabilities, contextLength, remote]);
  return { info, fingerprint };
}

/** Local models that can chat. Unknown capabilities (older Ollama) get the benefit of the doubt. */
export function isSelectable(model: ModelInfo): boolean {
  return !model.remote && (model.capabilities === undefined || model.capabilities.includes("completion"));
}

// ----- /api/show -----

export interface ShowInfo {
  /** Absent: not reported. */
  readonly capabilities?: readonly string[];
  /** `thinking.values`: false/true as off/on, strings as named levels; deduplicated, in order. */
  readonly thinkingValues: readonly string[];
  /** `thinking.default` in the same vocabulary. Display metadata only. */
  readonly thinkingDefault?: string;
}

function thinkingValue(value: unknown): string | undefined {
  if (value === false) {
    return "off";
  }
  if (value === true) {
    return "on";
  }
  return nonEmptyString(value);
}

export function parseShow(data: unknown): ShowInfo {
  const show = asObject(data);
  if (show === undefined) {
    throw invalidResponse("expected a JSON object from /api/show");
  }
  const capabilities = Array.isArray(show.capabilities)
    ? (show.capabilities as unknown[]).filter((item): item is string => typeof item === "string")
    : undefined;
  const thinking = asObject(show.thinking);
  const reported = Array.isArray(thinking?.values) ? (thinking.values as unknown[]) : [];
  const values = [...new Set(reported.flatMap((value) => thinkingValue(value) ?? []))];
  const modelDefault = thinkingValue(thinking?.default);
  return {
    ...(capabilities === undefined ? {} : { capabilities }),
    thinkingValues: values,
    ...(modelDefault === undefined ? {} : { thinkingDefault: modelDefault }),
  };
}

// ----- /api/chat -----

/** A count only when it is an exact non-negative safe integer; never rounded. */
function toCount(value: unknown): bigint | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
}

/**
 * prompt_eval_count/eval_count as input/output tokens. The total is the exact
 * sum only when both were reported (derived, not an estimate).
 */
function parseUsage(reply: JsonObject): TokenUsage | undefined {
  const inputTokens = toCount(reply.prompt_eval_count);
  const outputTokens = toCount(reply.eval_count);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens !== undefined && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}),
  };
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

interface Split {
  readonly text: string;
  readonly reasoning?: string;
  /** A leading think block that never closed: its content is reasoning, not an answer. */
  readonly unterminated: boolean;
}

/** Separates reasoning: the `thinking` field, or a complete leading `<think>` block. Later tags stay in the answer. */
function splitReasoning(content: string, thinking: unknown): Split {
  const field = typeof thinking === "string" && thinking.trim() !== "" ? thinking : undefined;
  const trimmed = content.trimStart();
  if (!trimmed.startsWith(THINK_OPEN)) {
    return { text: content, ...(field === undefined ? {} : { reasoning: field }), unterminated: false };
  }
  const afterOpen = trimmed.slice(THINK_OPEN.length);
  const end = afterOpen.indexOf(THINK_CLOSE);
  const inner = (end < 0 ? afterOpen : afterOpen.slice(0, end)).trim();
  const reasoning = field ?? (inner === "" ? undefined : inner);
  const text = end < 0 ? "" : afterOpen.slice(end + THINK_CLOSE.length).trimStart();
  return { text, ...(reasoning === undefined ? {} : { reasoning }), unterminated: end < 0 };
}

export function parseChatResponse(data: unknown): GenerationOutcome {
  const reply = asObject(data);
  if (reply === undefined) {
    throw invalidResponse("expected a JSON object");
  }
  if ("error" in reply && reply.error !== null && reply.error !== undefined) {
    const detail = typeof reply.error === "string" ? safeText(reply.error) : "unspecified error";
    throw new ProviderError(`Ollama error: ${detail}`, "api");
  }
  const message = asObject(reply.message);
  if (typeof message?.content !== "string") {
    throw invalidResponse("missing 'message.content'");
  }
  if (reply.done !== true) {
    throw invalidResponse("the reply is not marked complete (done is not true)");
  }
  const usage = parseUsage(reply);
  const split = splitReasoning(message.content, message.thinking);
  if (reply.done_reason === "length") {
    return {
      kind: "incomplete",
      reason: INCOMPLETE_REASON,
      partialText: split.text,
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (split.unterminated) {
    throw invalidResponse("the model's reasoning block never ended, so there is no answer");
  }
  return {
    kind: "completed",
    result: {
      text: split.text,
      ...(usage === undefined ? {} : { usage }),
      ...(split.reasoning === undefined ? {} : { reasoning: split.reasoning }),
    },
  };
}
