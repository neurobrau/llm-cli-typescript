import { StorageCodecError } from "./errors.js";
import { CanonicalObject, asObject, asString, isPresent, isWellFormed, nonNegativeInteger } from "./json.js";
import type { Canonical, JsonValue } from "./json.js";
import { formatTimestamp, parseTimestamp } from "./timestamps.js";
import type { StoredUsageRecord } from "./types.js";

/** Count fields in file order; the property is the domain name. */
const COUNT_FIELDS = [
  ["input_tokens", "inputTokens"],
  ["output_tokens", "outputTokens"],
  ["total_tokens", "totalTokens"],
  ["cached_input_tokens", "cachedInputTokens"],
  ["cache_write_tokens", "cacheWriteTokens"],
  ["reasoning_tokens", "reasoningTokens"],
] as const;

/** One stored record, or `undefined` if it is malformed (the caller skips it, as the references do). */
export function decodeUsageRecord(value: JsonValue): StoredUsageRecord | undefined {
  const record = asObject(value);
  if (record === undefined) {
    return undefined;
  }
  const atText = asString(record.fields.get("at"));
  const at = atText === undefined ? undefined : parseTimestamp(atText);
  const provider = asString(record.fields.get("provider"));
  const model = asString(record.fields.get("model"));
  // An absent status is "completed"; a present null or non-string is invalid.
  const status = record.fields.has("status") ? asString(record.fields.get("status")) : "completed";
  if (at === undefined || provider === undefined || model === undefined || !isWellFormed(provider) || !isWellFormed(model)) {
    return undefined;
  }
  if (status !== "completed" && status !== "incomplete") {
    return undefined;
  }
  let serviceTier: string | undefined;
  if (isPresent(record, "service_tier")) {
    serviceTier = asString(record.fields.get("service_tier"));
    if (serviceTier === undefined || !isWellFormed(serviceTier)) {
      return undefined;
    }
  }
  const counts: Record<string, bigint> = {};
  for (const [field, property] of COUNT_FIELDS) {
    if (isPresent(record, field)) {
      const count = nonNegativeInteger(record.fields.get(field));
      if (count === undefined) {
        return undefined; // one bad recognized count invalidates the record
      }
      counts[property] = count;
    }
  }
  return Object.freeze({
    at,
    provider,
    model,
    status,
    ...(serviceTier === undefined ? {} : { serviceTier }),
    usage: Object.freeze(counts),
  });
}

export function encodeUsageRecord(record: StoredUsageRecord, index: number): Canonical {
  const label = `requests[${String(index)}]`;
  requireText(record.provider, `${label}.provider`);
  requireText(record.model, `${label}.model`);
  const status: unknown = record.status; // callers can bypass the type
  if (status !== "completed" && status !== "incomplete") {
    throw new StorageCodecError("value", `${label}.status must be completed or incomplete`);
  }
  const entries: (readonly [string, Canonical])[] = [
    ["at", formatTimestamp(record.at, `${label}.at`)],
    ["provider", record.provider],
    ["model", record.model],
    ["status", record.status],
  ];
  if (record.serviceTier !== undefined) {
    requireText(record.serviceTier, `${label}.service_tier`);
    entries.push(["service_tier", record.serviceTier]);
  }
  for (const [field, property] of COUNT_FIELDS) {
    const count: unknown = record.usage[property];
    if (count === undefined) {
      continue;
    }
    if (typeof count !== "bigint" || count < 0n) {
      throw new StorageCodecError("value", `${label}.${field} must be a non-negative bigint`);
    }
    entries.push([field, count]);
  }
  return new CanonicalObject(entries);
}

export function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !isWellFormed(value)) {
    throw new StorageCodecError("value", `'${field}' must be a string without unpaired surrogates`);
  }
}
