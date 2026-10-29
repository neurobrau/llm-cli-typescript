import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  GO_MAX_COUNT,
  StorageCodecError,
  decodeActiveSelection,
  decodeConversation,
  decodeSettings,
  emptySettings,
  encodeActiveSelection,
  encodeConversation,
  encodeSettings,
  isValidConversationId,
} from "../src/storage/index.js";
import { compareCodePoints } from "../src/storage/json.js";
import type { StoredConversation, StoredSettings } from "../src/storage/index.js";
import { activeCases, at, conversationCases, settingsCases } from "./helpers/storage-cases.js";

const FIXTURES = resolve(import.meta.dirname, "..", "..", "tests", "fixtures", "storage");
const fixture = (dir: string, name: string): Buffer => readFileSync(resolve(FIXTURES, dir, name));

const ID = "11111111-1111-4111-8111-111111111111";

function failure(action: () => unknown, kind?: string): StorageCodecError {
  try {
    action();
  } catch (error: unknown) {
    assert.ok(error instanceof StorageCodecError, String(error));
    if (kind !== undefined) {
      assert.equal(error.kind, kind, error.message);
    }
    return error;
  }
  return assert.fail("expected a StorageCodecError");
}

/** A minimal valid conversation document with overrides. */
function conversationText(overrides: Record<string, unknown> = {}, drop: readonly string[] = []): string {
  const base: Record<string, unknown> = {
    schema_version: 1,
    id: ID,
    created_at: "2026-10-21T12:00:00.000Z",
    updated_at: "2026-10-21T12:00:00.000Z",
    messages: [{ role: "user", content: "hi" }],
  };
  const merged = { ...base, ...overrides };
  for (const key of drop) {
    Reflect.deleteProperty(merged, key);
  }
  return JSON.stringify(merged);
}

const settingsText = (overrides: Record<string, unknown> = {}): string => JSON.stringify({ schema_version: 1, answer_style: "brief", providers: {}, ...overrides });

void describe("Python-generated fixtures (copied from the Go edition): decode and re-encode byte for byte", () => {
  for (const name of ["conversation_empty_after_reset", "conversation_legacy_no_provider", "conversation_ollama_unicode", "conversation_openai_usage"]) {
    void it(`${name}.json`, () => {
      const bytes = fixture("python", `${name}.json`);
      assert.equal(Buffer.from(encodeConversation(decodeConversation(bytes))).compare(bytes), 0);
      assert.equal(Buffer.from(encodeConversation(decodeConversation(bytes.toString("utf8")))).compare(bytes), 0);
    });
  }

  void it("settings.json", () => {
    const bytes = fixture("python", "settings.json");
    const { settings, notices } = decodeSettings(bytes);
    assert.deepEqual(notices, []);
    assert.equal(Buffer.from(encodeSettings(settings)).compare(bytes), 0);
  });

  void it("active.json", () => {
    const bytes = fixture("python", "active.json");
    assert.equal(Buffer.from(encodeActiveSelection(decodeActiveSelection(bytes))).compare(bytes), 0);
  });

  void it("decodes to the expected values", () => {
    const usage = decodeConversation(fixture("python", "conversation_openai_usage.json"));
    assert.equal(usage.id, "7c1e4b2a-9f3d-4e8a-b6c5-1a2b3c4d5e6f");
    assert.equal(usage.createdAt.toISOString(), "2026-10-22T05:54:00.123Z");
    assert.deepEqual(usage.requests, [
      {
        at: at("2026-10-22T05:54:29.609Z"),
        provider: "openai",
        model: "gpt-6-luna",
        status: "completed",
        serviceTier: "default",
        usage: { inputTokens: 1000n, outputTokens: 200n, totalTokens: 1200n, cachedInputTokens: 600n, cacheWriteTokens: 100n, reasoningTokens: 50n },
      },
    ]);
    const unicode = decodeConversation(fixture("python", "conversation_ollama_unicode.json"));
    assert.equal(unicode.messages[0]?.content, "Grüße, 世界! Ünïcödé 🎉\nLine two\twith tab");
    assert.deepEqual(unicode.requests[1]?.usage, { inputTokens: 30n, outputTokens: 0n }); // no total is invented
    const legacy = decodeConversation(fixture("python", "conversation_legacy_no_provider.json"));
    assert.ok(!("provider" in legacy) && !("model" in legacy));
    assert.deepEqual(decodeActiveSelection(fixture("python", "active.json")), { provider: "ollama", model: "qwen3.5:4b" });
    const prefs = decodeSettings(fixture("python", "settings.json")).settings;
    assert.equal(prefs.answerStyle, "brief");
    assert.deepEqual(prefs.providers.get("openai")?.get("gpt-6-luna"), { maxOutputTokens: null });
    assert.deepEqual(prefs.providers.get("openai")?.get("gpt-5"), { reasoning: "default" });
    assert.deepEqual(prefs.providers.get("ollama")?.get("qwen3.5:4b"), { reasoning: "on", maxOutputTokens: 600n });
  });
});

void describe("TS-created canonical fixtures", () => {
  for (const { file, value } of conversationCases) {
    void it(`${file}: encode gives the committed bytes and decode gives the value back`, () => {
      const bytes = fixture("ts", file);
      assert.equal(Buffer.from(encodeConversation(value)).compare(bytes), 0);
      assert.deepEqual(decodeConversation(bytes), value);
      assert.equal(Buffer.from(encodeConversation(decodeConversation(bytes))).compare(bytes), 0);
    });
  }
  for (const { file, value } of settingsCases) {
    void it(`${file}: encode gives the committed bytes and decode gives the value back`, () => {
      const bytes = fixture("ts", file);
      assert.equal(Buffer.from(encodeSettings(value)).compare(bytes), 0);
      const { settings, notices } = decodeSettings(bytes);
      assert.deepEqual(notices, []);
      assert.equal(Buffer.from(encodeSettings(settings)).compare(bytes), 0);
      assert.deepEqual(normalized(settings), normalized(value));
    });
  }
  for (const { file, value } of activeCases) {
    void it(`${file}: encode gives the committed bytes`, () => {
      const bytes = fixture("ts", file);
      assert.equal(Buffer.from(encodeActiveSelection(value)).compare(bytes), 0);
      assert.deepEqual(decodeActiveSelection(bytes), value);
    });
  }

  void it("pins exact bytes for the large-count and key-order cases", () => {
    const usage = fixture("ts", "conversation_usage_edges.json").toString("utf8");
    for (const token of ['"input_tokens": 9007199254740993,', '"output_tokens": 9223372036854775807,', '"total_tokens": 1180591620717411303429,', '"service_tier": "",']) {
      assert.ok(usage.includes(`      ${token}`) || usage.includes(`      ${token.slice(0, -1)}\n`), token);
    }
    const keys = [...fixture("ts", "settings_special_keys.json").toString("utf8").matchAll(/^ {4}"(.*)": \{$/gmu)].map((match) => match[1]);
    assert.deepEqual(keys, ["__proto__", "ollama", "openai", "￮", "😀"]); // code-point order
    assert.equal(fixture("ts", "settings_empty.json").toString("utf8"), '{\n  "schema_version": 1,\n  "answer_style": "normal",\n  "providers": {}\n}\n');
    assert.equal(fixture("ts", "active_unicode.json").toString("utf8"), '{"schema_version": 1, "provider": "ollama", "model": "mödel \\"q\\" \\\\ 日本 😀\\n"}\n');
    const empty = fixture("ts", "conversation_timestamps.json").toString("utf8");
    assert.ok(empty.includes('"messages": [],'));
    assert.ok(empty.includes('"created_at": "0001-01-01T00:00:00.000Z"') && empty.includes('"updated_at": "9999-12-31T23:59:59.999Z"'));
  });
});

/** Maps compare by content, not insertion order. */
function normalized(settings: StoredSettings): unknown {
  const byName = (a: readonly [string, unknown], b: readonly [string, unknown]): number => compareCodePoints(a[0], b[0]);
  return {
    answerStyle: settings.answerStyle,
    providers: [...settings.providers].map(([name, models]) => [name, [...models].sort(byName)] as const).sort(byName),
  };
}

void describe("conversation decoding", () => {
  void it("reads a legacy file without provider, model or requests and does not invent them", () => {
    const conversation = decodeConversation(conversationText());
    assert.deepEqual(conversation, {
      id: ID,
      createdAt: at("2026-10-21T12:00:00.000Z"),
      updatedAt: at("2026-10-21T12:00:00.000Z"),
      messages: [{ role: "user", content: "hi" }],
      requests: [],
    });
    assert.ok(!("provider" in conversation));
    assert.ok(!encodeConversation(conversation).includes('"provider"'));
  });

  void it("treats null provider/model as unknown and keeps unknown provider strings", () => {
    const unknown = decodeConversation(conversationText({ provider: null, model: null }));
    assert.ok(!("provider" in unknown) && !("model" in unknown));
    const future = decodeConversation(conversationText({ provider: "futureai", model: "a/b:c" }));
    assert.equal(future.provider, "futureai");
    assert.equal(future.model, "a/b:c");
  });

  void it("normalizes offsets and ignores unknown fields everywhere", () => {
    const text = conversationText({
      created_at: "2026-10-21T14:00:00+02:00",
      updated_at: "2026-10-21T12:00:00.123456Z",
      messages: [{ role: "user", content: "Hi", extra: true, nested: { a: [] } }],
    }).replace("[]}]", "[1e999]}]").replace(/\}$/, ',"future_field":123456789012345678901234567890}');
    const conversation = decodeConversation(text);
    assert.equal(conversation.createdAt.toISOString(), "2026-10-21T12:00:00.000Z");
    assert.equal(conversation.updatedAt.toISOString(), "2026-10-21T12:00:00.123Z");
    assert.deepEqual(conversation.messages, [{ role: "user", content: "Hi" }]);
  });

  void it("accepts schema_version 1.0 but not true, strings or other numbers", () => {
    decodeConversation(conversationText({ schema_version: 1 }).replace('"schema_version":1', '"schema_version":1.0'));
    for (const version of [true, "1", 2, 0, null, [], {}, 99]) {
      failure(() => decodeConversation(conversationText({ schema_version: version })), "document");
    }
    failure(() => decodeConversation(conversationText({}, ["schema_version"])), "document");
  });

  void it("rejects unusable documents with typed errors", () => {
    for (const text of ["[]", "null", '"x"', "1", "true"]) {
      failure(() => decodeConversation(text), "document");
    }
    failure(() => decodeConversation("{"), "syntax");
    failure(() => decodeConversation(Uint8Array.from([0xff])), "encoding");
  });

  void it("requires a canonical lowercase UUID id (any version) and rejects path-like ids", () => {
    assert.ok(isValidConversationId("00000000-0000-0000-0000-000000000000"));
    assert.equal(decodeConversation(conversationText({ id: "ffffffff-ffff-1fff-ffff-ffffffffffff" })).id, "ffffffff-ffff-1fff-ffff-ffffffffffff");
    const bad = ["../../etc/passwd", "11111111-1111-4111-8111-11111111111", "11111111-1111-4111-8111-1111111111111", "11111111111141118111111111111111", "11111111-1111-4111-8111-11111111111G", "AAAAAAAA-1111-4111-8111-111111111111", `${ID}/x`, `${ID}.json`, ` ${ID}`, `{${ID}}`, "urn:uuid:11111111-1111-4111-8111-111111111111", "", 5, null];
    for (const id of bad) {
      failure(() => decodeConversation(conversationText({ id })), "field");
    }
    failure(() => decodeConversation(conversationText({}, ["id"])), "field");
  });

  void it("invalidates the conversation for any bad message, and requires the messages list", () => {
    const bad: unknown[] = [[1], ["x"], [null], [{ role: "system", content: "x" }], [{ role: "user" }], [{ role: "user", content: null }], [{ role: "user", content: 5 }], [{ role: "User", content: "x" }], [{ content: "x" }], [{ role: "user", content: "ok" }, { role: "assistant", content: ["x"] }], [{ role: "user", content: "\ud800" }]];
    for (const messages of bad) {
      failure(() => decodeConversation(conversationText({ messages })), "field");
    }
    for (const messages of [null, {}, "x", 1]) {
      failure(() => decodeConversation(conversationText({ messages })), "field");
    }
    failure(() => decodeConversation(conversationText({}, ["messages"])), "field");
  });

  void it("rejects bad or missing timestamps", () => {
    for (const field of ["created_at", "updated_at"]) {
      for (const value of ["2026-10-21T12:00:00", "nope", 5, null, "2026-02-30T00:00:00Z", "2026-10-21 12:00:00Z"]) {
        failure(() => decodeConversation(conversationText({ [field]: value })), "field");
      }
      failure(() => decodeConversation(conversationText({}, [field])), "field");
    }
  });

  void it("rejects non-string or empty provider/model, and accepts only absent or null as unknown", () => {
    for (const field of ["provider", "model"]) {
      for (const value of [42, "", ["x"], {}, true, false, "\udc00"]) {
        failure(() => decodeConversation(conversationText({ [field]: value })), "field");
      }
    }
  });

  void it("treats absent or non-array requests as none and skips malformed records individually", () => {
    for (const requests of [undefined, null, {}, "x", 5, true]) {
      assert.deepEqual(decodeConversation(conversationText(requests === undefined ? {} : { requests })).requests, []);
    }
    const good = { at: "2026-10-21T12:00:00.000Z", provider: "openai", model: "gpt-6-luna", status: "completed", input_tokens: 5, output_tokens: 1, future_field: 1 };
    const conversation = decodeConversation(
      conversationText({
        requests: [
          good,
          { at: "nope" },
          { ...good, input_tokens: -1 },
          { ...good, status: "x" },
          { ...good, status: null },
          { ...good, output_tokens: "1" },
          { ...good, output_tokens: 1.5 },
          { ...good, output_tokens: true },
          { ...good, provider: 5 },
          { ...good, model: null },
          { ...good, service_tier: 5 },
          { ...good, cached_input_tokens: [] },
          { ...good, at: "2026-10-21T12:00:00" },
          42,
          null,
          [],
          { ...good, input_tokens: 7, status: "incomplete", service_tier: "" },
        ],
      }),
    );
    assert.equal(conversation.messages.length, 1);
    assert.deepEqual(conversation.requests, [
      { at: at("2026-10-21T12:00:00.000Z"), provider: "openai", model: "gpt-6-luna", status: "completed", usage: { inputTokens: 5n, outputTokens: 1n } },
      { at: at("2026-10-21T12:00:00.000Z"), provider: "openai", model: "gpt-6-luna", status: "incomplete", serviceTier: "", usage: { inputTokens: 7n, outputTokens: 1n } },
    ]);
  });

  void it("rejects float-form counts (1.0, 1e2) in records even though schema_version 1.0 is accepted", () => {
    for (const lexeme of ["1.0", "1e2", "1E2", "0.5", "1e0"]) {
      const text = conversationText({ requests: [] }).replace(
        '"requests":[]',
        `"requests":[{"at":"2026-10-21T12:00:00Z","provider":"p","model":"m","output_tokens":${lexeme}}]`,
      );
      assert.deepEqual(decodeConversation(text).requests, [], lexeme);
    }
  });

  void it("defaults an absent status to completed, keeps empty tier, treats null tier and null counts as absent", () => {
    const record = { at: "2026-10-21T12:00:00Z", provider: "", model: "", input_tokens: null, service_tier: null, total_tokens: 0 };
    const [first] = decodeConversation(conversationText({ requests: [record] })).requests;
    assert.deepEqual(first, { at: at("2026-10-21T12:00:00.000Z"), provider: "", model: "", status: "completed", usage: { totalTokens: 0n } });
    const [second] = decodeConversation(conversationText({ requests: [{ ...record, service_tier: "" }] })).requests;
    assert.equal(second?.serviceTier, "");
  });

  void it("preserves counts beyond Number.MAX_SAFE_INTEGER, 64 bits and beyond, exactly", () => {
    const text = conversationText({ requests: [] }).replace(
      '"requests":[]',
      '"requests":[{"at":"2026-10-21T12:00:00Z","provider":"p","model":"m","input_tokens":9007199254740993,"output_tokens":9223372036854775807,"total_tokens":9223372036854775808,"cached_input_tokens":1180591620717411303429,"reasoning_tokens":-0}]',
    );
    const [record] = decodeConversation(text).requests;
    assert.deepEqual(record?.usage, {
      inputTokens: 9007199254740993n,
      outputTokens: GO_MAX_COUNT,
      totalTokens: GO_MAX_COUNT + 1n,
      cachedInputTokens: 1180591620717411303429n,
      reasoningTokens: 0n,
    });
    const written = encodeConversation(decodeConversation(text));
    assert.ok(written.includes('"input_tokens": 9007199254740993,') && written.includes('"cached_input_tokens": 1180591620717411303429,'));
    assert.ok(!/e\+|"input_tokens": "/u.test(written));
  });

  void it("does not let huge unknown numbers corrupt recognized fields", () => {
    const conversation = decodeConversation(conversationText({ id: ID }).replace(/\}$/, ',"huge":123456789012345678901234567890123456789e400,"inf":1e999}'));
    assert.equal(conversation.id, ID);
  });

  void it("last duplicate key wins, as with Python", () => {
    const text = '{"schema_version":1,"id":"' + ID + '","created_at":"2026-10-21T12:00:00Z","updated_at":"2026-10-21T12:00:00Z","messages":[],"messages":[{"role":"user","content":"last"}],"model":"a","model":"b"}';
    const conversation = decodeConversation(text);
    assert.deepEqual(conversation.messages, [{ role: "user", content: "last" }]);
    assert.equal(conversation.model, "b");
  });

  void it("accepts a content string with astral and escaped characters", () => {
    const conversation = decodeConversation(conversationText({ messages: [{ role: "assistant", content: "\u2028 😀 \u0000 \u007f" }] }));
    assert.equal(conversation.messages[0]?.content, "\u2028 😀 \u0000 \u007f");
  });

  void it("returns frozen results and diagnostics without content", () => {
    const conversation = decodeConversation(conversationText());
    assert.ok(Object.isFrozen(conversation) && Object.isFrozen(conversation.messages));
    const error = failure(() => decodeConversation(conversationText({ messages: [{ role: "user", content: 7, secret: "top-secret-body" }] })));
    assert.ok(!error.message.includes("top-secret"));
  });
});

void describe("conversation encoding", () => {
  const base: StoredConversation = { id: ID, createdAt: at("2026-10-21T12:00:00.000Z"), updatedAt: at("2026-10-21T12:00:00.000Z"), messages: [], requests: [] };

  void it("writes the exact canonical bytes with ordered keys, omitting unknown provider/model and empty requests", () => {
    assert.equal(
      encodeConversation({ ...base, messages: [{ role: "user", content: "Hi" }] }),
      `{\n  "schema_version": 1,\n  "id": "${ID}",\n  "created_at": "2026-10-21T12:00:00.000Z",\n  "updated_at": "2026-10-21T12:00:00.000Z",\n  "messages": [\n    {\n      "role": "user",\n      "content": "Hi"\n    }\n  ]\n}\n`,
    );
    assert.equal(encodeConversation(base).includes('"messages": []'), true);
  });

  void it("does not retain unknown fields and truncates dates to milliseconds", () => {
    const withExtras = { ...base, extra: 1, updatedAt: new Date(1_700_000_000_123.9) } as StoredConversation;
    const text = encodeConversation(withExtras);
    assert.ok(!text.includes("extra"));
    assert.ok(text.includes('"updated_at": "2023-11-14T22:13:20.123Z"'));
  });

  void it("rejects unsafe in-memory values instead of writing them", () => {
    const cases: readonly (readonly [string, object])[] = [
      ["id", { id: "../x" }],
      ["id", { id: "AAAAAAAA-1111-4111-8111-111111111111" }],
      ["createdAt", { createdAt: new Date(Number.NaN) }],
      ["updatedAt", { updatedAt: "2026-10-21T12:00:00Z" }],
      ["provider", { provider: "" }],
      ["provider", { provider: "\ud800" }],
      ["model", { model: 5 }],
      ["role", { messages: [{ role: "system", content: "x" }] }],
      ["content", { messages: [{ role: "user", content: 5 }] }],
      ["surrogate", { messages: [{ role: "user", content: "a\udc00" }] }],
      ["status", { requests: [{ at: base.createdAt, provider: "p", model: "m", status: "x", usage: {} }] }],
      ["negative", { requests: [{ at: base.createdAt, provider: "p", model: "m", status: "completed", usage: { inputTokens: -1n } }] }],
      ["number count", { requests: [{ at: base.createdAt, provider: "p", model: "m", status: "completed", usage: { inputTokens: 5 } }] }],
      ["tier", { requests: [{ at: base.createdAt, provider: "p", model: "m", status: "completed", serviceTier: 3, usage: {} }] }],
      ["record time", { requests: [{ at: new Date(Number.NaN), provider: "p", model: "m", status: "completed", usage: {} }] }],
    ];
    for (const [name, override] of cases) {
      failure(() => encodeConversation({ ...base, ...override }), "value");
      assert.ok(name !== "");
    }
  });
});

void describe("settings decoding", () => {
  void it("defaults style and providers when absent, and decodes concrete, default, null and absent preferences distinctly", () => {
    assert.deepEqual(decodeSettings('{"schema_version": 1}'), { settings: emptySettings(), notices: [] });
    const { settings, notices } = decodeSettings(
      settingsText({
        providers: {
          openai: { models: { a: { reasoning: "default" }, b: { max_output_tokens: null }, c: { max_output_tokens: 7 }, d: {}, e: { reasoning: null, max_output_tokens: null }, f: { reasoning: "low", future: 1 } } },
        },
      }),
    );
    assert.deepEqual(notices, []);
    const models = settings.providers.get("openai");
    assert.ok(models);
    assert.deepEqual(models.get("a"), { reasoning: "default" });
    assert.deepEqual(models.get("b"), { maxOutputTokens: null });
    assert.deepEqual(models.get("c"), { maxOutputTokens: 7n });
    assert.deepEqual(models.get("d"), {});
    assert.deepEqual(models.get("e"), { maxOutputTokens: null });
    assert.deepEqual(models.get("f"), { reasoning: "low" });
    assert.ok(!("maxOutputTokens" in (models.get("a") ?? {})));
  });

  void it("recovers from bad values with notices, skipping whole model entries (as Python's test expects five notices)", () => {
    const { settings, notices } = decodeSettings(
      settingsText({
        answer_style: "poetic",
        providers: {
          openai: { models: { good: { reasoning: "low" }, "bad-tokens": { max_output_tokens: -5 }, "bad-bool": { max_output_tokens: true }, "bad-reasoning": { reasoning: 3 }, "half-good": { reasoning: "low", max_output_tokens: 0 } } },
          ollama: "nope",
        },
        future: true,
      }),
    );
    assert.equal(settings.answerStyle, "normal");
    assert.deepEqual([...(settings.providers.get("openai")?.keys() ?? [])], ["good"]);
    assert.equal(settings.providers.has("ollama"), false);
    assert.equal(notices.length, 6);
    assert.match(notices[0] ?? "", /unknown answer_style/);
    assert.ok(notices.some((notice) => /"half-good".*max_output_tokens/.test(notice)));
    assert.ok(notices.some((notice) => /"ollama".*'models' must be an object/.test(notice)));
  });

  void it("skips an entry that is not an object, a non-object models map, and malformed names", () => {
    const { settings, notices } = decodeSettings(
      settingsText({ providers: { a: { models: { x: 5, y: null, z: [], ok: {} } }, b: { models: [] }, c: {}, d: null, e: [] } }),
    );
    assert.deepEqual([...(settings.providers.get("a")?.keys() ?? [])], ["ok"]);
    assert.equal(notices.length, 3 + 4);
    assert.deepEqual([...settings.providers.keys()], ["a"]);
  });

  void it("rejects unusable documents", () => {
    for (const text of ["[]", "null", '"x"', "{", settingsText({ schema_version: 2 }), settingsText({ schema_version: true }), '{"answer_style": "brief"}']) {
      failure(() => decodeSettings(text));
    }
    for (const providers of [null, [], "x", 5, true]) {
      failure(() => decodeSettings(settingsText({ providers })), "document");
    }
    failure(() => decodeSettings(Uint8Array.from([0x7b, 0xff])), "encoding");
  });

  void it("treats a null or non-string answer_style as unknown and keeps all three valid styles", () => {
    for (const style of ["brief", "normal", "detailed"]) {
      assert.equal(decodeSettings(settingsText({ answer_style: style })).settings.answerStyle, style);
    }
    for (const style of [null, 3, "Brief", "", ["brief"]]) {
      const decoded = decodeSettings(settingsText({ answer_style: style }));
      assert.equal(decoded.settings.answerStyle, "normal");
      assert.equal(decoded.notices.length, 1);
    }
  });

  void it("keeps arbitrary keys as safe data and never touches prototypes", () => {
    const text = '{"schema_version":1,"providers":{"__proto__":{"models":{"__proto__":{"reasoning":"x"},"constructor":{"max_output_tokens":3},"hasOwnProperty":{}}},"constructor":{"models":{"1":{"reasoning":"y"}}}}}';
    const { settings, notices } = decodeSettings(text);
    assert.deepEqual(notices, []);
    assert.deepEqual(settings.providers.get("__proto__")?.get("__proto__"), { reasoning: "x" });
    assert.deepEqual(settings.providers.get("__proto__")?.get("constructor"), { maxOutputTokens: 3n });
    assert.deepEqual(settings.providers.get("constructor")?.get("1"), { reasoning: "y" });
    assert.equal(({} as Record<string, unknown>).reasoning, undefined);
    assert.equal(Object.getPrototypeOf({}), Object.prototype);
  });

  void it("accepts max_output_tokens beyond Number.MAX_SAFE_INTEGER and beyond 64 bits without rounding", () => {
    const { settings } = decodeSettings('{"schema_version":1,"providers":{"p":{"models":{"a":{"max_output_tokens":9007199254740993},"b":{"max_output_tokens":9223372036854775808},"c":{"max_output_tokens":1180591620717411303429}}}}}');
    const models = settings.providers.get("p");
    assert.ok(models);
    assert.equal(models.get("a")?.maxOutputTokens, 9007199254740993n);
    assert.equal(models.get("b")?.maxOutputTokens, GO_MAX_COUNT + 1n);
    assert.equal(models.get("c")?.maxOutputTokens, 1180591620717411303429n);
    for (const bad of ["5.0", "5e0", "0", "-0", "-1", '"5"', "[]", "false", "1.5"]) {
      const result = decodeSettings(`{"schema_version":1,"providers":{"p":{"models":{"a":{"max_output_tokens":${bad}}}}}}`);
      assert.equal(result.settings.providers.size, 0, bad);
      assert.equal(result.notices.length, 1, bad);
    }
  });

  void it("does not validate saved reasoning against capabilities, and orders notices by code point", () => {
    const { settings, notices } = decodeSettings(settingsText({ providers: { z: { models: { "😀": 1, "￮": 1 } }, a: { models: { b: 1, a: 1 } } } }));
    assert.equal(settings.providers.size, 0);
    assert.deepEqual(
      notices.map((notice) => notice.replace(/^Ignoring settings for /, "").replace(/: entry must be an object\.$/, "")),
      ['"a"/"a"', '"a"/"b"', '"z"/"￮"', '"z"/"😀"'],
    );
    assert.equal(decodeSettings(settingsText({ providers: { p: { models: { m: { reasoning: "anything-at-all" } } } } })).settings.providers.get("p")?.get("m")?.reasoning, "anything-at-all");
  });

  void it("rejects empty reasoning and malformed names without leaking them raw into notices", () => {
    const { settings, notices } = decodeSettings(settingsText({ providers: { p: { models: { "bad\nname\u001b[31m": 1, ok: { reasoning: "" } } } } }));
    assert.equal(settings.providers.size, 0);
    assert.equal(notices.length, 2);
    assert.ok(notices.every((notice) => !notice.includes("\u001b") && !notice.includes("\n")));
  });
});

void describe("settings encoding", () => {
  const settings = (providers: [string, [string, object][]][]): StoredSettings => ({
    answerStyle: "normal",
    providers: new Map(providers.map(([name, models]) => [name, new Map(models)])),
  });

  void it("omits empty model entries and providers left empty, and keeps reasoning before max_output_tokens", () => {
    const text = encodeSettings(settings([["p", [["m", { maxOutputTokens: 3n, reasoning: "low" }], ["empty", {}]]], ["gone", [["x", {}]]], ["none", []]]));
    assert.equal(text, '{\n  "schema_version": 1,\n  "answer_style": "normal",\n  "providers": {\n    "p": {\n      "models": {\n        "m": {\n          "reasoning": "low",\n          "max_output_tokens": 3\n        }\n      }\n    }\n  }\n}\n');
    assert.equal(encodeSettings(emptySettings()), '{\n  "schema_version": 1,\n  "answer_style": "normal",\n  "providers": {}\n}\n');
  });

  void it("does not reorder numeric-looking model names", () => {
    const text = encodeSettings(settings([["p", [["2", { reasoning: "a" }], ["10", { reasoning: "b" }], ["1", { reasoning: "c" }]]]]));
    assert.deepEqual([...text.matchAll(/^ {8}"(\d+)"/gmu)].map((match) => match[1]), ["1", "10", "2"]);
  });

  void it("rejects unsafe values", () => {
    const bad: object[] = [
      { answerStyle: "poetic" },
      { answerStyle: undefined },
      { providers: new Map([["p\ud800", new Map([["m", { reasoning: "x" }]])]]) },
      { providers: new Map([["p", new Map([["m\udc00", { reasoning: "x" }]])]]) },
      { providers: new Map([["p", new Map([["m", { reasoning: "" }]])]]) },
      { providers: new Map([["p", new Map([["m", { reasoning: 5 }]])]]) },
      { providers: new Map([["p", new Map([["m", { maxOutputTokens: 0n }]])]]) },
      { providers: new Map([["p", new Map([["m", { maxOutputTokens: -1n }]])]]) },
      { providers: new Map([["p", new Map([["m", { maxOutputTokens: 5 }]])]]) },
      { providers: new Map([["p", new Map([["m", { maxOutputTokens: "5" }]])]]) },
    ];
    for (const override of bad) {
      failure(() => encodeSettings({ ...emptySettings(), ...override }), "value");
    }
  });
});

void describe("active selection", () => {
  void it("writes one line with Python separators, the exact field order and a trailing newline", () => {
    assert.equal(encodeActiveSelection({ provider: "openai", model: "gpt-6-luna" }), '{"schema_version": 1, "provider": "openai", "model": "gpt-6-luna"}\n');
  });

  void it("accepts only supported providers and a non-empty model", () => {
    assert.deepEqual(decodeActiveSelection('{"schema_version":1.0,"provider":"openai","model":"m","extra":[1e999]}'), { provider: "openai", model: "m" });
    const bad = [
      '{"schema_version":1,"provider":"futureai","model":"m"}',
      '{"schema_version":1,"provider":"OpenAI","model":"m"}',
      '{"schema_version":1,"provider":"","model":"m"}',
      '{"schema_version":1,"provider":null,"model":"m"}',
      '{"schema_version":1,"provider":"ollama"}',
      '{"schema_version":1,"provider":"ollama","model":""}',
      '{"schema_version":1,"provider":"ollama","model":5}',
      '{"schema_version":1,"provider":"ollama","model":"\\ud800"}',
      '{"schema_version":2,"provider":"ollama","model":"m"}',
      '{"schema_version":true,"provider":"ollama","model":"m"}',
      '{"provider":"ollama","model":"m"}',
      "[]",
      "{",
    ];
    for (const text of bad) {
      failure(() => decodeActiveSelection(text));
    }
  });

  void it("refuses to write unsupported selections", () => {
    for (const value of [{ provider: "futureai", model: "m" }, { provider: "ollama", model: "" }, { provider: "ollama", model: "\ud800" }, { provider: "ollama", model: 5 }]) {
      failure(() => encodeActiveSelection(value as never), "value");
    }
  });
});
