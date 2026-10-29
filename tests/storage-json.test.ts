import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StorageCodecError } from "../src/storage/errors.js";
import type { JsonValue } from "../src/storage/json.js";
import {
  CanonicalObject,
  JsonNumber,
  JsonObject,
  asArray,
  asObject,
  compareCodePoints,
  isSchemaVersion1,
  isWellFormed,
  nonNegativeInteger,
  parseJson,
  renderCanonical,
} from "../src/storage/json.js";
import { formatTimestamp, parseTimestamp } from "../src/storage/timestamps.js";

function codecError(action: () => unknown, kind: string): StorageCodecError {
  try {
    action();
  } catch (error: unknown) {
    assert.ok(error instanceof StorageCodecError, String(error));
    assert.equal(error.kind, kind, error.message);
    return error;
  }
  return assert.fail("expected a StorageCodecError");
}

void describe("native JSON.parse source access (runtime proof)", () => {
  void it("exposes the exact lexeme although the numeric argument is rounded", () => {
    const seen: { value: number; source: string | undefined }[] = [];
    JSON.parse("[9007199254740993, 1.50, -0, 1e400, 123456789012345678901234567890]", (_key, value, context) => {
      if (typeof value === "number") {
        seen.push({ value, source: context.source });
      }
      return value;
    });
    assert.deepEqual(seen, [
      { value: 9007199254740992, source: "9007199254740993" }, // rounded argument, exact source
      { value: 1.5, source: "1.50" },
      { value: -0, source: "-0" },
      { value: Infinity, source: "1e400" },
      { value: 1.2345678901234568e29, source: "123456789012345678901234567890" },
    ]);
    assert.equal(BigInt("9007199254740993") === BigInt(9007199254740992), false);
  });

  void it("parseJson keeps lexemes and converts by lexeme, not by the rounded number", () => {
    const root = asObject(parseJson('{"n": 9007199254740993, "big": 123456789012345678901234567890}'));
    assert.equal(nonNegativeInteger(root?.fields.get("n")), 9007199254740993n);
    assert.equal(nonNegativeInteger(root?.fields.get("big")), 123456789012345678901234567890n);
  });

  void it("does not patch JSON or BigInt globally", () => {
    assert.equal(Object.hasOwn(BigInt.prototype, "toJSON"), false);
    assert.equal(JSON.parse("9007199254740993"), 9007199254740992);
  });
});

void describe("parseJson", () => {
  void it("builds the tree from JSON text only, so no foreign object can pose as a number or object", () => {
    const root = asObject(parseJson('{"source": "9", "fields": {}, "a": [1, {"b": null}]}'));
    assert.ok(root instanceof JsonObject);
    assert.ok(!(root.fields.get("source") instanceof JsonNumber));
    assert.ok(asArray(root.fields.get("a"))?.[0] instanceof JsonNumber);
    assert.equal(nonNegativeInteger(root.fields.get("source")), undefined);
    // A hand-made look-alike is not accepted by the typed readers.
    const lookalike = JSON.parse('{"source": "7"}') as JsonValue; // a plain object with a "source" field
    assert.equal(nonNegativeInteger(lookalike), undefined);
    assert.equal(asObject(lookalike), undefined);
  });

  void it("keeps special keys as data and lets the last duplicate win", () => {
    const root = asObject(parseJson('{"__proto__": 1, "constructor": 2, "toString": 3, "d": 1, "d": 2, "10": 4, "2": 5}'));
    assert.ok(root);
    assert.deepEqual([...root.fields.keys()].sort(), ["10", "2", "__proto__", "constructor", "d", "toString"]);
    assert.equal(nonNegativeInteger(root.fields.get("d")), 2n);
    assert.equal(root.fields.get("missing"), undefined);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  });

  void it("rejects syntax the references accept or that is malformed, with a generic message", () => {
    const bad = ["", "{", "[1,]", "{'a': 1}", "NaN", "Infinity", "-Infinity", "[NaN]", "01", "1.", ".5", "+1", "1e", '{"a" 1}', "﻿{}", '"\u0001"', "{} x", "nul"];
    for (const text of bad) {
      const error = codecError(() => parseJson(text), "syntax");
      assert.equal(error.message, "the text is not valid JSON", JSON.stringify(text));
    }
  });

  void it("does not echo input in diagnostics", () => {
    const error = codecError(() => parseJson('{"secret-token-123": oops}'), "syntax");
    assert.ok(!error.message.includes("secret"));
  });

  void it("decodes bytes with strict UTF-8 and rejects invalid sequences and BOMs", () => {
    assert.ok(parseJson(new TextEncoder().encode('{"é": "😀"}')) instanceof JsonObject);
    for (const bytes of [[0x7b, 0xff, 0x7d], [0xc3, 0x28], [0xed, 0xa0, 0x80], [0xf0, 0x28, 0x8c, 0x28]]) {
      codecError(() => parseJson(Uint8Array.from(bytes)), "encoding");
    }
    codecError(() => parseJson(Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), "syntax");
  });

  void it("reports excessive nesting as a syntax error", () => {
    codecError(() => parseJson(`${"[".repeat(200_000)}${"]".repeat(200_000)}`), "syntax");
  });

  void it("accepts lone-surrogate escapes in JSON text (callers validate recognized strings)", () => {
    assert.equal(parseJson('"\\ud800"'), "\ud800");
  });
});

void describe("number lexemes", () => {
  const lexeme = (source: string): bigint | undefined => nonNegativeInteger(new JsonNumber(source));

  void it("accepts only non-negative integer lexemes of any size", () => {
    assert.equal(lexeme("0"), 0n);
    assert.equal(lexeme("-0"), 0n);
    assert.equal(lexeme("9223372036854775807"), 9223372036854775807n);
    assert.equal(lexeme("9223372036854775808"), 9223372036854775808n);
    assert.equal(lexeme("1180591620717411303429"), 1180591620717411303429n);
    for (const source of ["-1", "1.0", "1.5", "1e2", "1E2", "1e0", "0.0", "-0.0"]) {
      assert.equal(lexeme(source), undefined, source);
    }
    for (const value of [true, false, null, "5", [], undefined]) {
      assert.equal(nonNegativeInteger(value as never), undefined);
    }
  });

  void it("schema version 1 accepts 1, 1.0 and 1e0 but not booleans, strings or other numbers", () => {
    for (const source of ["1", "1.0", "1.00", "1e0", "10e-1"]) {
      assert.equal(isSchemaVersion1(new JsonNumber(source)), true, source);
    }
    for (const source of ["2", "0", "-0", "-1", "1.5", "11", "1e1"]) {
      assert.equal(isSchemaVersion1(new JsonNumber(source)), false, source);
    }
    for (const value of [true, "1", null, undefined, []]) {
      assert.equal(isSchemaVersion1(value as never), false);
    }
  });
});

void describe("strings and ordering", () => {
  void it("detects lone surrogates", () => {
    assert.equal(isWellFormed("😀 ok é"), true);
    for (const text of ["\ud800", "\udc00", "a\ud83d", "\ude00\ud83d", "x\udc00y"]) {
      assert.equal(isWellFormed(text), false, text);
    }
  });

  void it("orders by Unicode code point, not UTF-16 code unit", () => {
    const sorted = ["😀", "￮", "a", "Z", "é", "10", "9", "1", ""].sort(compareCodePoints);
    assert.deepEqual(sorted, ["", "1", "10", "9", "Z", "a", "é", "￮", "😀"]);
    assert.deepEqual(["\uffee", "\u{1F600}"].sort(), ["\u{1F600}", "\uffee"], "premise: UTF-16 order differs");
    assert.equal(compareCodePoints("a", "a"), 0);
    assert.equal(compareCodePoints("a", "ab"), -1);
    assert.equal(compareCodePoints("ab", "a"), 1);
  });
});

void describe("canonical rendering (Python json.dumps layout)", () => {
  void it("renders indented documents with empty containers and bare integers", () => {
    const value = new CanonicalObject([
      ["a", 1n],
      ["empty_list", []],
      ["empty_object", new CanonicalObject([])],
      ["nested", new CanonicalObject([["k", [null, "x", 18446744073709551616n]]])],
    ]);
    assert.equal(
      renderCanonical(value, 2),
      '{\n  "a": 1,\n  "empty_list": [],\n  "empty_object": {},\n  "nested": {\n    "k": [\n      null,\n      "x",\n      18446744073709551616\n    ]\n  }\n}',
    );
  });

  void it("renders the one-line form with Python separators", () => {
    assert.equal(renderCanonical(new CanonicalObject([["a", 1n], ["b", ["x", null]]])), '{"a": 1, "b": ["x", null]}');
  });

  void it("escapes like Python with ensure_ascii=False", () => {
    const text = `q" b\\ \n\r\t\b\f \u0000 \u001f \u007f \u2028 \u2029 é 😀`;
    assert.equal(renderCanonical(text), '"q\\" b\\\\ \\n\\r\\t\\b\\f \\u0000 \\u001f \u007f \u2028 \u2029 é 😀"');
  });
});

void describe("timestamps", () => {
  const iso = (text: string): string | undefined => {
    const instant = parseTimestamp(text);
    return instant === undefined ? undefined : formatTimestamp(instant, "t");
  };

  void it("normalizes offsets to UTC across date boundaries", () => {
    assert.equal(iso("2026-10-21T14:00:00+02:00"), "2026-10-21T12:00:00.000Z");
    assert.equal(iso("2026-01-01T00:30:00+01:00"), "2025-12-31T23:30:00.000Z");
    assert.equal(iso("2025-12-31T23:30:00-05:30"), "2026-01-01T05:00:00.000Z");
    assert.equal(iso("2026-03-01T00:00:00+14:00"), "2026-02-28T10:00:00.000Z");
    assert.equal(iso("2024-03-01T00:00:00+00:01"), "2024-02-29T23:59:00.000Z");
  });

  void it("truncates finer fractions toward the earlier millisecond", () => {
    assert.equal(iso("2026-10-21T12:00:00Z"), "2026-10-21T12:00:00.000Z");
    assert.equal(iso("2026-10-21T12:00:00.1Z"), "2026-10-21T12:00:00.100Z");
    assert.equal(iso("2026-10-21T12:00:00.123456Z"), "2026-10-21T12:00:00.123Z");
    assert.equal(iso("2026-10-21T12:00:00.123999999999Z"), "2026-10-21T12:00:00.123Z");
    assert.equal(iso("1969-12-31T23:59:59.9999Z"), "1969-12-31T23:59:59.999Z");
    assert.equal(iso("1969-12-31T23:59:59.001+01:00"), "1969-12-31T22:59:59.001Z");
  });

  void it("handles pre-epoch values and the supported range edges", () => {
    assert.equal(iso("0001-01-01T00:00:00Z"), "0001-01-01T00:00:00.000Z");
    assert.equal(iso("1900-01-01T00:00:00Z"), "1900-01-01T00:00:00.000Z");
    assert.equal(iso("9999-12-31T23:59:59.999Z"), "9999-12-31T23:59:59.999Z");
    assert.equal(iso("9999-12-31T23:59:59.999999Z"), "9999-12-31T23:59:59.999Z");
    assert.equal(iso("0001-01-01T05:00:00+05:00"), "0001-01-01T00:00:00.000Z");
  });

  void it("rejects out-of-range normalization, year 0000, impossible dates and bad zones", () => {
    const bad = [
      "0001-01-01T00:00:00+01:00", // normalizes before year 1
      "9999-12-31T23:59:59-01:00", // normalizes past year 9999
      "0000-06-01T00:00:00Z",
      "2026-02-29T00:00:00Z",
      "2100-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-00-10T00:00:00Z",
      "2026-01-00T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T23:60:00Z",
      "2026-01-01T23:59:60Z", // no leap seconds
      "2026-01-01T00:00:00+24:00",
      "2026-01-01T00:00:00+01:60",
      "2026-01-01T00:00:00", // no zone
      "2026-01-01T00:00:00.123", // no zone
      "2026-01-01 00:00:00Z", // space separator (Python-only)
      "2026-01-01t00:00:00z",
      "20260101T000000Z", // basic format
      "2026-01-01",
      "2026-01-01T00:00Z",
      "2026-01-01T00:00:00+0100",
      "2026-01-01T00:00:00+01",
      "2026-01-01T00:00:00.Z",
      "2026-01-01T00:00:00Z ",
      " 2026-01-01T00:00:00Z",
      "２０２６-01-01T00:00:00Z",
      "",
    ];
    for (const text of bad) {
      assert.equal(parseTimestamp(text), undefined, text);
    }
  });

  void it("accepts the leap day of leap years", () => {
    assert.equal(iso("2024-02-29T12:00:00Z"), "2024-02-29T12:00:00.000Z");
    assert.equal(iso("2000-02-29T12:00:00Z"), "2000-02-29T12:00:00.000Z");
  });

  void it("refuses to write invalid instants", () => {
    for (const value of [new Date(Number.NaN), new Date(-62135596800001), new Date(253402300800000), "2026" as unknown as Date, null as unknown as Date]) {
      codecError(() => formatTimestamp(value, "t"), "value");
    }
  });
});

void describe("runtimes without JSON.parse source-text access", () => {
  type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;
  // Simulates an older engine: the reviver is called with the rounded number and either no context or one without `source`.
  function withEngine(callReviver: (reviver: Reviver) => void, action: () => unknown): StorageCodecError {
    const native = JSON.parse;
    const stub = (_text: string, reviver: Reviver): unknown => {
      callReviver(reviver);
      return null;
    };
    JSON.parse = stub as typeof JSON.parse;
    try {
      return codecError(action, "runtime");
    } finally {
      JSON.parse = native;
    }
  }

  void it("reports kind runtime, not syntax, when the reviver context is absent", () => {
    const error = withEngine((reviver) => reviver.call({}, "n", 9007199254740992), () => parseJson("[9007199254740993]"));
    assert.match(error.message, /source-text access/);
  });

  void it("reports kind runtime when the context has no source", () => {
    withEngine((reviver) => reviver.call({}, "n", 9007199254740992, {}), () => parseJson("9007199254740993"));
  });

  void it("is not affected for input without numbers, and the real engine still works", () => {
    assert.equal(parseJson('"text"'), "text");
    assert.equal((parseJson("9007199254740993") as JsonNumber).source, "9007199254740993");
  });
});
