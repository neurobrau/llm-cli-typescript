/**
 * Dated project compatibility table, copied from the Python reference
 * (providers/openai_provider.py KNOWN_MODELS; identical in the Go edition).
 * It is not a claim about current account availability or a model catalog:
 * the Models API does not report capabilities, so only listed models get
 * confirmed reasoning choices and unknown IDs stay "unknown".
 */
import type { ModelCapabilities, ReasoningSupport } from "../../domain/settings.js";

export const API_KEY_ENV_VAR = "OPENAI_API_KEY";
export const DEFAULT_MODEL = "gpt-6-luna";

interface KnownModel {
  /** Empty: known not to accept the reasoning parameter. */
  readonly efforts: readonly string[];
  /** Known output-token limit; absent: unknown. */
  readonly maxOutputTokens?: number;
}

const KNOWN_MODELS: Readonly<Record<string, KnownModel>> = {
  "gpt-6-luna": { efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
  "gpt-5.2": { efforts: ["none", "low", "medium", "high", "xhigh"], maxOutputTokens: 128_000 },
  "gpt-5.1": { efforts: ["none", "low", "medium", "high"], maxOutputTokens: 128_000 },
  "gpt-5": { efforts: ["minimal", "low", "medium", "high"], maxOutputTokens: 128_000 },
  "gpt-5-mini": { efforts: ["minimal", "low", "medium", "high"], maxOutputTokens: 128_000 },
  "gpt-5-nano": { efforts: ["minimal", "low", "medium", "high"], maxOutputTokens: 128_000 },
  o3: { efforts: ["low", "medium", "high"], maxOutputTokens: 100_000 },
  "o3-mini": { efforts: ["low", "medium", "high"], maxOutputTokens: 100_000 },
  "o4-mini": { efforts: ["low", "medium", "high"], maxOutputTokens: 100_000 },
  "gpt-4.1": { efforts: [], maxOutputTokens: 32_768 },
  "gpt-4.1-mini": { efforts: [], maxOutputTokens: 32_768 },
  "gpt-4.1-nano": { efforts: [], maxOutputTokens: 32_768 },
  "gpt-4o": { efforts: [], maxOutputTokens: 16_384 },
  "gpt-4o-mini": { efforts: [], maxOutputTokens: 16_384 },
};

/** The model's own default effort when no parameter is sent, where documented. Display metadata only. */
const MODEL_DEFAULT_EFFORTS: Readonly<Record<string, string>> = { "gpt-6-luna": "medium" };

const SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

function baseModel(model: string): string {
  return model.replace(SNAPSHOT_SUFFIX, "");
}

function lookup(model: string): KnownModel | undefined {
  // Object.hasOwn avoids prototype keys such as "constructor" matching.
  const exact = Object.hasOwn(KNOWN_MODELS, model) ? KNOWN_MODELS[model] : undefined;
  if (exact !== undefined) {
    return exact;
  }
  const base = baseModel(model);
  return Object.hasOwn(KNOWN_MODELS, base) ? KNOWN_MODELS[base] : undefined;
}

/**
 * Capabilities from the table. `rejectedBuiltInReasoning` marks a model that
 * rejected the built-in reasoning default in this provider instance: it is
 * then known to accept no reasoning value.
 */
export function capabilitiesFor(model: string, rejectedBuiltInReasoning: boolean): ModelCapabilities {
  const entry = lookup(model);
  const limit = entry?.maxOutputTokens;
  const limitField = limit === undefined ? {} : { maxOutputTokensLimit: limit };
  if (rejectedBuiltInReasoning) {
    return { reasoning: { known: true, values: [], allowsModelDefault: true }, ...limitField };
  }
  if (entry === undefined) {
    return { reasoning: { known: false, values: [], allowsModelDefault: true } };
  }
  const modelDefault = MODEL_DEFAULT_EFFORTS[model] ?? MODEL_DEFAULT_EFFORTS[baseModel(model)];
  const reasoning: ReasoningSupport = {
    known: true,
    values: entry.efforts,
    allowsModelDefault: true,
    ...(entry.efforts.includes("none") ? { defaultValue: "none" } : {}),
    ...(modelDefault === undefined ? {} : { modelDefault }),
  };
  return { reasoning, ...limitField };
}

/** Obvious non-text models hidden from discovery (heuristic, as in the references). */
const NON_TEXT_MARKERS = [
  "embedding",
  "tts",
  "whisper",
  "dall-e",
  "moderation",
  "transcribe",
  "realtime",
  "audio",
  "image",
];

export function isTextModel(id: string): boolean {
  return !NON_TEXT_MARKERS.some((marker) => id.includes(marker));
}
