export { decodeActiveSelection, encodeActiveSelection } from "./active.js";
export { decodeConversation, encodeConversation, isValidConversationId } from "./conversation.js";
export { StorageCodecError } from "./errors.js";
export type { StorageCodecErrorKind } from "./errors.js";
export { decodeSettings, emptySettings, encodeSettings } from "./settings.js";
export { SCHEMA_VERSION } from "./types.js";
export type {
  ActiveSelection,
  DecodedSettings,
  StoredConversation,
  StoredModelPreferences,
  StoredProviders,
  StoredSettings,
  StoredUsageRecord,
  UsageStatus,
} from "./types.js";

/** Largest count Go's signed 64-bit integers can read; larger stored counts are Python-only. */
export const GO_MAX_COUNT = 9_223_372_036_854_775_807n;
export { matchesSelection } from "./matching.js";
export type { SelectionFilter } from "./matching.js";
