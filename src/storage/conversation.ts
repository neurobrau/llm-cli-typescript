import type { Message } from "../domain/generation.js";
import { StorageCodecError } from "./errors.js";
import { CanonicalObject, asArray, asObject, asString, isPresent, isSchemaVersion1, isWellFormed, jsonTypeName, parseJson, renderCanonical } from "./json.js";
import type { Canonical, JsonObject } from "./json.js";
import { formatTimestamp, parseTimestamp } from "./timestamps.js";
import { SCHEMA_VERSION } from "./types.js";
import type { StoredConversation } from "./types.js";
import { decodeUsageRecord, encodeUsageRecord, requireText } from "./usage.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Canonical lowercase UUID; this also keeps the ID safe as a file name. */
export function isValidConversationId(value: string): boolean {
  return UUID.test(value);
}

/**
 * Validates and reads a conversation file (text, or bytes decoded as strict
 * UTF-8). Throws `StorageCodecError` when the file as a whole is unusable;
 * unknown fields are ignored and malformed usage records are skipped.
 */
export function decodeConversation(input: string | Uint8Array): StoredConversation {
  const root = asObject(parseJson(input));
  if (root === undefined) {
    throw new StorageCodecError("document", "the top level must be a JSON object");
  }
  if (!isSchemaVersion1(root.fields.get("schema_version"))) {
    throw new StorageCodecError("document", "unsupported schema_version (expected 1)");
  }
  const id = asString(root.fields.get("id"));
  if (id === undefined || !isValidConversationId(id)) {
    throw new StorageCodecError("field", "'id' must be a canonical lowercase UUID string");
  }
  const rawMessages = asArray(root.fields.get("messages"));
  if (rawMessages === undefined) {
    throw new StorageCodecError("field", "'messages' must be a list");
  }
  const messages = rawMessages.map((item, index): Message => {
    const message = asObject(item);
    if (message === undefined) {
      throw new StorageCodecError("field", `message ${String(index)} must be an object`);
    }
    const role = asString(message.fields.get("role"));
    if (role !== "user" && role !== "assistant") {
      throw new StorageCodecError("field", `message ${String(index)} has an invalid role (${jsonTypeName(message.fields.get("role"))})`);
    }
    const content = asString(message.fields.get("content"));
    if (content === undefined || !isWellFormed(content)) {
      throw new StorageCodecError("field", `message ${String(index)} content must be a string without unpaired surrogates`);
    }
    return Object.freeze({ role, content });
  });
  const createdAt = timestampField(root, "created_at");
  const updatedAt = timestampField(root, "updated_at");
  const provider = optionalText(root, "provider");
  const model = optionalText(root, "model");
  // Absent or non-array requests mean none; bad records are skipped individually.
  const requests = (asArray(root.fields.get("requests")) ?? []).flatMap((item) => decodeUsageRecord(item) ?? []);
  return Object.freeze({
    id,
    createdAt,
    updatedAt,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    messages: Object.freeze(messages),
    requests: Object.freeze(requests),
  });
}

function timestampField(object: JsonObject, field: string): Date {
  const text = asString(object.fields.get(field));
  if (text === undefined) {
    throw new StorageCodecError("field", `'${field}' must be a string`);
  }
  const instant = parseTimestamp(text);
  if (instant === undefined) {
    throw new StorageCodecError("field", `'${field}' must be an RFC 3339 timestamp with a time zone (years 0001-9999)`);
  }
  return instant;
}

/** Absent or null: unknown. Otherwise a non-empty string of any value. */
function optionalText(object: JsonObject, field: string): string | undefined {
  if (!isPresent(object, field)) {
    return undefined;
  }
  const value = asString(object.fields.get(field));
  if (value === undefined || value === "" || !isWellFormed(value)) {
    throw new StorageCodecError("field", `'${field}' must be a non-empty string`);
  }
  return value;
}

/**
 * Canonical file text: 2-space indent, reference key order, a trailing
 * newline; unknown provider/model and empty requests are omitted. The caller's
 * value is validated, so malformed data is never written.
 */
export function encodeConversation(conversation: StoredConversation): string {
  if (typeof conversation.id !== "string" || !isValidConversationId(conversation.id)) {
    throw new StorageCodecError("value", "'id' must be a canonical lowercase UUID string");
  }
  const entries: (readonly [string, Canonical])[] = [
    ["schema_version", BigInt(SCHEMA_VERSION)],
    ["id", conversation.id],
    ["created_at", formatTimestamp(conversation.createdAt, "created_at")],
    ["updated_at", formatTimestamp(conversation.updatedAt, "updated_at")],
  ];
  for (const [field, value] of [["provider", conversation.provider], ["model", conversation.model]] as const) {
    if (value !== undefined) {
      requireText(value, field);
      if (value === "") {
        throw new StorageCodecError("value", `'${field}' must not be empty (omit it when unknown)`);
      }
      entries.push([field, value]);
    }
  }
  entries.push([
    "messages",
    conversation.messages.map((message, index): Canonical => {
      const role: unknown = message.role; // callers can bypass the type
      if (role !== "user" && role !== "assistant") {
        throw new StorageCodecError("value", `message ${String(index)} has an invalid role`);
      }
      requireText(message.content, `message ${String(index)} content`);
      return new CanonicalObject([["role", message.role], ["content", message.content]]);
    }),
  ]);
  if (conversation.requests.length > 0) {
    entries.push(["requests", conversation.requests.map((record, index) => encodeUsageRecord(record, index))]);
  }
  return `${renderCanonical(new CanonicalObject(entries), 2)}\n`;
}
