/**
 * Strict, lossless JSON reading and the canonical (Python-compatible) writer.
 *
 * Reading uses the native `JSON.parse` with a reviver. For every number the
 * reviver receives `context.source`, the original lexeme, which survives even
 * when the ordinary numeric argument was rounded (`9007199254740993` arrives
 * as `9007199254740992`). The tree built here keeps numbers as lexemes and
 * only converts the recognized fields, by lexeme, to `bigint`. No JSON
 * parser is written, no text is rewritten, and no global is patched.
 */
import { StorageCodecError } from "./errors.js";

/** A number exactly as written in the text. Only the reader creates these. */
export class JsonNumber {
  constructor(readonly source: string) {}
}

/**
 * A parsed object. Fields live in a Map, so keys such as `__proto__` or
 * `constructor` are plain data and nothing is looked up through a prototype.
 * Duplicate keys: the last one wins (native parsing, as Python).
 */
export class JsonObject {
  constructor(readonly fields: ReadonlyMap<string, JsonValue>) {}
}

export type JsonValue = null | boolean | string | JsonNumber | JsonObject | readonly JsonValue[];

const INTEGER_LEXEME = /^-?(?:0|[1-9][0-9]*)$/;

/** Decodes bytes strictly (a BOM is kept, so it fails as JSON like in the references) and parses. */
export function parseJson(input: string | Uint8Array): JsonValue {
  const text = typeof input === "string" ? input : decodeUtf8(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, revive);
  } catch (error: unknown) {
    if (error instanceof StorageCodecError) {
      throw error;
    }
    if (error instanceof RangeError) {
      throw new StorageCodecError("syntax", "the JSON is nested too deeply");
    }
    // The native message quotes the input; it is deliberately not forwarded.
    throw new StorageCodecError("syntax", "the text is not valid JSON");
  }
  return parsed as JsonValue; // built only by `revive`
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StorageCodecError("encoding", "the input is not valid UTF-8");
  }
}

function revive(this: unknown, _key: string, value: unknown, context: JsonParseContext): unknown {
  if (typeof value === "number") {
    // Never fall back to the (possibly rounded) numeric argument.
    if (typeof context.source !== "string") {
      throw new StorageCodecError("runtime", "JSON.parse source-text access is not available in this runtime");
    }
    return new JsonNumber(context.source);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return new JsonObject(new Map(Object.entries(value)));
  }
  return value;
}

// ----- typed access (own data only) -----

export function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value instanceof JsonObject ? value : undefined;
}

export function asArray(value: JsonValue | undefined): readonly JsonValue[] | undefined {
  return Array.isArray(value) ? (value as readonly JsonValue[]) : undefined;
}

export function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** True when the field exists and is not null. */
export function isPresent(object: JsonObject, key: string): boolean {
  const value = object.fields.get(key);
  return value !== undefined && value !== null;
}

/**
 * A non-negative integer lexeme (`0`, `42`, and `-0` which both references
 * read as 0) as a bigint of any size; `undefined` for fractions, exponents,
 * negatives and every non-number.
 */
export function nonNegativeInteger(value: JsonValue | undefined): bigint | undefined {
  if (!(value instanceof JsonNumber) || !INTEGER_LEXEME.test(value.source)) {
    return undefined;
  }
  const parsed = BigInt(value.source);
  return parsed >= 0n ? parsed : undefined;
}

/** `schema_version` equal to 1; like Python and Go, `1.0` and `1e0` count, `true` does not. */
export function isSchemaVersion1(value: JsonValue | undefined): boolean {
  if (!(value instanceof JsonNumber)) {
    return false;
  }
  return INTEGER_LEXEME.test(value.source) ? BigInt(value.source) === 1n : Number(value.source) === 1;
}

/** Describes a value's JSON type for diagnostics, never its content. */
export function jsonTypeName(value: JsonValue | undefined): string {
  if (value === undefined) {
    return "missing";
  }
  if (value === null) {
    return "null";
  }
  if (value instanceof JsonNumber) {
    return "number";
  }
  if (value instanceof JsonObject) {
    return "object";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

// ----- strings -----

/** False for lone UTF-16 surrogates, which have no UTF-8 form. */
export function isWellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return false;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Python's string order (Unicode code points), not JavaScript's UTF-16 code-unit order. */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return Math.sign(a.length - i - (b.length - j));
}

// ----- canonical writer -----

/** An object whose key order is exactly the order of its entries. */
export class CanonicalObject {
  constructor(readonly entries: readonly (readonly [string, Canonical])[]) {}
}

export type Canonical = null | string | bigint | readonly Canonical[] | CanonicalObject;

/**
 * Python `json.dumps(..., ensure_ascii=False)` layout. With `indent`:
 * one item per line, empty containers as `[]`/`{}`. Without: one line with
 * `, ` and `: ` separators. Integers are bare base-10 tokens; strings go
 * through `JSON.stringify` (same escapes as Python for well-formed text).
 */
export function renderCanonical(value: Canonical, indent?: number): string {
  return render(value, indent, 0);
}

function render(value: Canonical, indent: number | undefined, level: number): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  const items: string[] = Array.isArray(value)
    ? (value as readonly Canonical[]).map((item) => render(item, indent, level + 1))
    : (value as CanonicalObject).entries.map(([key, item]) => `${JSON.stringify(key)}: ${render(item, indent, level + 1)}`);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (items.length === 0) {
    return `${open}${close}`;
  }
  if (indent === undefined) {
    return `${open}${items.join(", ")}${close}`;
  }
  const inner = " ".repeat(indent * (level + 1));
  return `${open}\n${items.map((item) => inner + item).join(",\n")}\n${" ".repeat(indent * level)}${close}`;
}
