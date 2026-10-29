/**
 * Storage DTOs: what the shared JSON files hold. Independent of provider SDKs
 * and UI. Persisted provider/model values are plain strings (unknown ones
 * survive round trips); runtime adoption is a later layer's job.
 */
import type { Message, ProviderId } from "../domain/generation.js";
import type { TokenUsage } from "../domain/generation.js";
import type { AnswerStyle } from "../domain/settings.js";

export const SCHEMA_VERSION = 1;

export type UsageStatus = "completed" | "incomplete";

/**
 * Usage of one request, counts exactly as stored: an absent count was not
 * reported, `0n` is a reported zero, nothing is inferred (not even a total).
 */
export interface StoredUsageRecord {
  readonly at: Date;
  readonly provider: string;
  readonly model: string;
  readonly status: UsageStatus;
  /** Present-but-empty ("") is a stored empty tier, distinct from absent. */
  readonly serviceTier?: string;
  readonly usage: TokenUsage;
}

export interface StoredConversation {
  /** Canonical lowercase UUID (any version). */
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Absent: unknown (legacy files; they mean "openai" only when matching, never in the file). */
  readonly provider?: string;
  readonly model?: string;
  readonly messages: readonly Message[];
  readonly requests: readonly StoredUsageRecord[];
}

/** The startup selection; narrower than conversations: a supported provider and a model. */
export interface ActiveSelection {
  readonly provider: ProviderId;
  readonly model: string;
}

/**
 * Saved preferences for one provider/model, with storage-sized integers.
 * Absent field: not set. `maxOutputTokens: null`: explicitly the model
 * default (JSON null). A bigint: a positive limit of any size; converting to
 * the runtime's number-based preferences must check representability.
 */
export interface StoredModelPreferences {
  /** A non-empty provider value, or "default". */
  readonly reasoning?: string;
  readonly maxOutputTokens?: bigint | null;
}

/** provider -> model -> preferences. Maps keep arbitrary keys (`__proto__`, "1", "a/b:c") safe. */
export type StoredProviders = ReadonlyMap<string, ReadonlyMap<string, StoredModelPreferences>>;

export interface StoredSettings {
  readonly answerStyle: AnswerStyle;
  readonly providers: StoredProviders;
}

export interface DecodedSettings {
  readonly settings: StoredSettings;
  /** Recoverable problems, ordered by provider/model code points; callers decide how to show them. */
  readonly notices: readonly string[];
}
