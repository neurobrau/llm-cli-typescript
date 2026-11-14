// Synthetic storage fixtures for the cross-language matrix. Canonical files are
// produced by the TypeScript encoder from domain objects; raw files are written
// by hand to exercise normalization, rejection and the documented differences.
// Counts are BigInt end to end (never routed through JS numbers).
const at = (iso) => new Date(iso);
const ID = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const rec = (when, provider, model, status, usage, serviceTier) => ({
  at: at(when),
  provider,
  model,
  status,
  ...(serviceTier === undefined ? {} : { serviceTier }),
  usage,
});
const conv = (n, extra = {}) => ({
  id: ID(n),
  createdAt: at("2026-10-21T12:00:00.000Z"),
  updatedAt: at("2026-10-21T12:00:00.000Z"),
  messages: [],
  requests: [],
  ...extra,
});

const TWO_53_MINUS_1 = 9007199254740991n;
const TWO_53_PLUS_1 = 9007199254740993n;
const INT64_MAX = 9223372036854775807n;

/** Common-domain fixtures: every implementation must read and write these byte for byte. */
export function commonFixtures() {
  const list = [];
  const c = (name, value, covers) => list.push({ kind: "conversation", file: `conversation_${name}.json`, value, covers });
  const s = (name, value, covers) => list.push({ kind: "settings", file: `settings_${name}.json`, value, covers });
  const a = (name, value, covers) => list.push({ kind: "active", file: `active_${name}.json`, value, covers });

  c("empty", conv(1), "empty conversation; absent provider/model/requests (legacy shape)");
  c("multi_turn", conv(2, {
    provider: "openai",
    model: "gpt-6-luna",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
      { role: "user", content: "second" },
      { role: "assistant", content: "two" },
    ],
  }), "multi-turn conversation with provider and model identity");
  c("provider_only", conv(3, { provider: "ollama", messages: [{ role: "user", content: "x" }] }), "provider without model matches any model");
  c("usage_outcomes", conv(4, {
    provider: "openai",
    model: "gpt-6-luna",
    requests: [
      rec("2026-10-21T12:00:00.000Z", "openai", "gpt-6-luna", "completed", { inputTokens: 10n, outputTokens: 5n, totalTokens: 15n, cachedInputTokens: 0n, cacheWriteTokens: 0n, reasoningTokens: 0n }, "default"),
      rec("2026-10-21T12:00:01.000Z", "openai", "gpt-6-luna", "incomplete", { inputTokens: 7n }, "flex"),
      rec("2026-10-21T12:00:02.000Z", "ollama", "m", "completed", {}),
      rec("2026-10-21T12:00:03.000Z", "openai", "gpt-6-luna", "completed", { outputTokens: 0n }, ""),
      rec("2026-10-21T12:00:04.000Z", "openai", "gpt-6-luna", "incomplete", {}, ""),
    ],
  }), "completed/incomplete; absent versus explicit zero; absent versus explicit empty service tier");
  c("counts_edges", conv(5, {
    provider: "ollama",
    model: "m",
    requests: [
      rec("2026-10-21T12:00:00.000Z", "ollama", "m", "completed", { inputTokens: TWO_53_MINUS_1 }),
      rec("2026-10-21T12:00:01.000Z", "ollama", "m", "completed", { outputTokens: TWO_53_PLUS_1 }),
      rec("2026-10-21T12:00:02.000Z", "ollama", "m", "completed", { totalTokens: INT64_MAX }),
      rec("2026-10-21T12:00:03.000Z", "ollama", "m", "incomplete", { cachedInputTokens: TWO_53_PLUS_1 }),
      rec("2026-10-21T12:00:04.000Z", "ollama", "m", "completed", { cacheWriteTokens: INT64_MAX }),
      rec("2026-10-21T12:00:05.000Z", "ollama", "m", "completed", { reasoningTokens: INT64_MAX }),
    ],
  }), "2^53-1, 2^53+1 and signed 64-bit maximum, one field per record (no sum is formed)");
  c("text_edges", conv(6, {
    provider: "ollama",
    model: "hf.co/org/model:Q4_K_M",
    messages: [
      { role: "user", content: "line one\nline two\r\n\ttabbed \"quoted\" back\\slash <&>" },
      { role: "assistant", content: "ctrl \u0001 \u001f \b \f del\u007f snow ☃ astral 😀 é ￮" },
      { role: "user", content: "" },
    ],
  }), "control characters, quotes, backslash, HTML characters, BMP-high and astral code points, empty content");
  c("timestamps", conv(8, {
    createdAt: at("0001-01-01T00:00:00.000Z"),
    updatedAt: at("9999-12-31T23:59:59.999Z"),
    provider: "openai",
    requests: [
      rec("1969-12-31T23:59:59.999Z", "openai", "m", "completed", {}),
      rec("2038-01-19T03:14:08.001Z", "openai", "m", "completed", {}),
      rec("2026-12-31T23:59:59.999Z", "openai", "m", "completed", {}),
    ],
  }), "year 0001 and 9999 boundaries, pre-epoch, 2038, year end, millisecond precision");

  const prefs = (entries) => new Map(entries.map(([p, m]) => [p, new Map(m)]));
  s("default", { answerStyle: "normal", providers: new Map() }, "empty settings");
  s("style_brief", { answerStyle: "brief", providers: new Map() }, "global answer style brief");
  s("style_detailed", { answerStyle: "detailed", providers: new Map() }, "global answer style detailed");
  s("reasoning_max", { answerStyle: "normal", providers: prefs([["openai", [["a", { reasoning: "default" }], ["b", { reasoning: "none" }], ["c", { maxOutputTokens: null }], ["d", { maxOutputTokens: 4096n }], ["e", { reasoning: "high", maxOutputTokens: null }], ["f", {}]]]]) }, "reasoning default versus a value versus absent; max absent/null/integer; empty entry omitted");
  s("independent_models", { answerStyle: "detailed", providers: prefs([["openai", [["gpt-6-luna", { reasoning: "low", maxOutputTokens: 600n }]]], ["ollama", [["gpt-6-luna", { reasoning: "off" }], ["qwen3.5:4b", { reasoning: "on", maxOutputTokens: 8192n }]]]]) }, "same model name under two providers keeps independent preferences");
  s("special_keys", { answerStyle: "normal", providers: prefs([["__proto__", [["__proto__", { maxOutputTokens: null }], ["constructor", { reasoning: "default" }]]], ["ollama", [["10", { reasoning: "a" }], ["9", { reasoning: "b" }], ["1", { reasoning: "c" }], ["a/b:c", { maxOutputTokens: 600n }], ["Z", { reasoning: "upper" }], ["é", { reasoning: "x" }], ["😀", { reasoning: "astral" }], ["￮", { reasoning: "bmp-high" }]]], ["😀", [["z", { reasoning: "low" }]]]]) }, "__proto__, integer-like strings, code-point ordering (BMP-high before astral), slashes and colons");
  s("limits", { answerStyle: "normal", providers: prefs([["ollama", [["big", { maxOutputTokens: INT64_MAX }], ["mid", { maxOutputTokens: TWO_53_PLUS_1 }]]]]) }, "saved max output tokens at 2^53+1 and the signed 64-bit maximum");

  a("ascii", { provider: "openai", model: "gpt-6-luna" }, "plain active selection");
  a("unicode", { provider: "ollama", model: "mödel \"q\" \\ 日本 \u{1F600} \u0001" }, "quotes, backslash, non-ASCII and control characters in the model");
  return list;
}

/** Raw files that every implementation must rewrite to the TypeScript canonical bytes. */
export function normalizationFixtures() {
  const base = (extra) => `{"schema_version": 1, "id": "00000000-0000-4000-8000-0000000000a1", "messages": [{"role": "user", "content": "caf\\u00e9 \\ud83d\\ude00"}], ${extra}}`;
  return [
    { file: "conversation_norm_offsets.json", text: base('"created_at": "2026-10-21T14:00:00.123456789+02:00", "updated_at": "2026-01-01T00:30:00-05:30"'), why: "offset timestamps become UTC with millisecond precision (truncated)", contains: ["\"created_at\": \"2026-10-21T12:00:00.123Z\"", "\"updated_at\": \"2026-01-01T06:00:00.000Z\"", "café 😀"] },
    { file: "conversation_norm_unknown_fields.json", text: base('"created_at": "2026-10-21T12:00:00Z", "updated_at": "2026-10-21T12:00:00Z", "extra": {"a": [1, 2]}, "requests": [{"at": "2026-10-21T12:00:00Z", "provider": "openai", "model": "m", "future": true, "input_tokens": 3}]'), why: "unknown fields (also inside records) are dropped on rewrite; unicode escapes become characters", contains: ["\"input_tokens\": 3"], lacks: ["extra", "future", "\"a\""] },
    { file: "conversation_norm_legacy_status.json", text: base('"created_at": "2026-10-21T12:00:00Z", "updated_at": "2026-10-21T12:00:00Z", "provider": null, "requests": [{"at": "2026-10-21T12:00:00Z", "provider": "openai", "model": "m", "service_tier": null, "input_tokens": 1}]'), why: "absent status is completed; null provider/service_tier are absent", contains: ["\"status\": \"completed\"", "\"input_tokens\": 1"], lacks: ["null", "service_tier", "\"provider\": \"\""] },
    { file: "conversation_norm_malformed_record.json", text: base('"created_at": "2026-10-21T12:00:00Z", "updated_at": "2026-10-21T12:00:00Z", "requests": [{"at": "bad", "provider": "openai", "model": "m"}, {"at": "2026-10-21T12:00:00Z", "provider": "openai", "model": "m", "output_tokens": -1}, {"at": "2026-10-21T12:00:00Z", "provider": "openai", "model": "m", "output_tokens": 2}]'), why: "malformed usage records are skipped, valid ones kept", contains: ["\"output_tokens\": 2"], lacks: ["\"output_tokens\": -1", "bad"] },
    { file: "settings_norm_unsorted.json", text: '{"answer_style": "brief", "schema_version": 1, "providers": {"ollama": {"models": {"z": {"reasoning": "low"}, "a": {"max_output_tokens": null}}}, "openai": {"models": {}}}, "unknown": 1}', why: "keys are sorted, empty providers/models canonicalized, unknown fields dropped", contains: ["\"answer_style\": \"brief\""], lacks: ["unknown"], ordered: ["\"a\"", "\"z\""] },
    { file: "active_norm_spaced.json", text: '{ "model" : "m\\u00f6", "provider": "ollama", "schema_version": 1, "extra": 5 }\n', why: "active.json is rewritten in the one-line canonical form", exact: "{\"schema_version\": 1, \"provider\": \"ollama\", \"model\": \"mö\"}\n" },
  ];
}

/** Raw files every implementation must reject (the text of the error is not compared). */
export function rejectionFixtures() {
  const ok = '"id": "00000000-0000-4000-8000-0000000000b1", "created_at": "2026-10-21T12:00:00Z", "updated_at": "2026-10-21T12:00:00Z"';
  const raw = (file, text, why) => ({ file, text, why });
  return [
    raw("conversation_bad_json.json", "{", "malformed JSON"),
    raw("conversation_bad_empty.json", "", "empty file"),
    raw("conversation_bad_toplevel.json", "[]", "top level is not an object"),
    raw("conversation_bad_schema.json", `{"schema_version": 2, ${ok}, "messages": []}`, "unsupported schema version"),
    raw("conversation_bad_schema_text.json", `{"schema_version": "1", ${ok}, "messages": []}`, "schema version as text"),
    raw("conversation_bad_id.json", '{"schema_version": 1, "id": "00000000-0000-4000-8000-0000000000B1", "created_at": "2026-10-21T12:00:00Z", "updated_at": "2026-10-21T12:00:00Z", "messages": []}', "uppercase id"),
    raw("conversation_bad_messages.json", `{"schema_version": 1, ${ok}, "messages": {}}`, "messages is not a list"),
    raw("conversation_bad_role.json", `{"schema_version": 1, ${ok}, "messages": [{"role": "system", "content": "x"}]}`, "invalid role"),
    raw("conversation_bad_content.json", `{"schema_version": 1, ${ok}, "messages": [{"role": "user", "content": 5}]}`, "content is not a string"),
    raw("conversation_bad_created.json", `{"schema_version": 1, "id": "00000000-0000-4000-8000-0000000000b1", "updated_at": "2026-10-21T12:00:00Z", "messages": []}`, "missing created_at"),
    raw("conversation_bad_naive_time.json", `{"schema_version": 1, "id": "00000000-0000-4000-8000-0000000000b1", "created_at": "2026-10-21T12:00:00", "updated_at": "2026-10-21T12:00:00Z", "messages": []}`, "timestamp without a time zone"),
    raw("conversation_bad_provider.json", `{"schema_version": 1, ${ok}, "provider": "", "messages": []}`, "empty provider"),
    raw("settings_bad_json.json", "{", "malformed JSON"),
    raw("settings_bad_schema.json", '{"schema_version": 2}', "unsupported schema version"),
    raw("settings_bad_providers.json", '{"schema_version": 1, "providers": []}', "providers is not an object"),
    raw("active_bad_model.json", '{"schema_version": 1, "provider": "openai", "model": ""}\n', "empty model"),
    raw("active_bad_json.json", "nope", "not JSON"),
  ];
}

/**
 * Differences outside the all-three-language domain: each fixture states, per
 * implementation, exactly what is expected: "reject", or {bytes(codecs)} (the
 * exact rewritten bytes, derived from a domain object by the TypeScript
 * encoder or written literally). Every outcome is asserted; nothing is ignored.
 */
export function differenceFixtures() {
  const BIG = 2n ** 70n + 5n;
  const head = '{"schema_version": 1, "id": "00000000-0000-4000-8000-0000000000c1", "created_at": "2026-10-21T12:00:00Z", "updated_at": "2026-10-21T12:00:00Z", "messages": []';
  const c1 = (extra = {}) => ({ id: "00000000-0000-4000-8000-0000000000c1", createdAt: at("2026-10-21T12:00:00.000Z"), updatedAt: at("2026-10-21T12:00:00.000Z"), messages: [], requests: [], ...extra });
  const r = (usage) => rec("2026-10-21T12:00:00.000Z", "ollama", "m", "completed", usage);
  const conversationBytes = (value) => (codecs) => codecs.encodeConversation(value);
  const settingsOf = (models) => ({ answerStyle: "normal", providers: new Map([["ollama", new Map(models)]]) });
  const settingsBytes = (value) => (codecs) => codecs.encodeSettings(value);
  const same = (text) => ({ bytes: () => text });
  return [
    { file: "conversation_diff_beyond_int64.json", group: "beyond-int64", text: `${head}, "requests": [{"at": "2026-10-21T12:00:00Z", "provider": "ollama", "model": "m", "input_tokens": ${BIG.toString()}}, {"at": "2026-10-21T12:00:00Z", "provider": "ollama", "model": "m", "output_tokens": 7}]}`,
      why: "docs/storage.md: counts are arbitrary-size integers in Python/TypeScript; Go reads signed 64-bit integers and skips a record it cannot read (never rounding it)",
      expect: { ts: { bytes: conversationBytes(c1({ requests: [r({ inputTokens: BIG }), r({ outputTokens: 7n })] })) }, python: { bytes: conversationBytes(c1({ requests: [r({ inputTokens: BIG }), r({ outputTokens: 7n })] })) }, go: { bytes: conversationBytes(c1({ requests: [r({ outputTokens: 7n })] })) } } },
    { file: "settings_diff_beyond_int64.json", group: "beyond-int64", text: `{"schema_version": 1, "answer_style": "normal", "providers": {"ollama": {"models": {"big": {"max_output_tokens": ${BIG.toString()}}, "ok": {"max_output_tokens": 5}}}}}`,
      why: "a saved limit above signed 64 bits is kept by Python/TypeScript; Go ignores that entry with a warning (and then rewrites the rest)",
      expect: { ts: { bytes: settingsBytes(settingsOf([["big", { maxOutputTokens: BIG }], ["ok", { maxOutputTokens: 5n }]])) }, python: { bytes: settingsBytes(settingsOf([["big", { maxOutputTokens: BIG }], ["ok", { maxOutputTokens: 5n }]])) }, go: { bytes: settingsBytes(settingsOf([["ok", { maxOutputTokens: 5n }]])), warns: true } } },
    { file: "conversation_diff_nan.json", group: "nan", text: `${head}, "requests": [{"at": "2026-10-21T12:00:00Z", "provider": "ollama", "model": "m", "input_tokens": NaN}]}`,
      why: "NaN is not JSON: TypeScript and Go reject the whole file; Python's json module reads the literal as a float, so the usage record is skipped as malformed",
      expect: { ts: "reject", python: { bytes: conversationBytes(c1()) }, go: "reject" } },
    { file: "conversation_diff_true_schema.json", group: "schema-true", text: '{"schema_version": true, "id": "00000000-0000-4000-8000-0000000000c1", "created_at": "2026-10-21T12:00:00Z", "updated_at": "2026-10-21T12:00:00Z", "messages": []}',
      why: "docs/storage.md: schema_version true is rejected by TypeScript and Go; Python treats True as 1",
      expect: { ts: "reject", python: { bytes: conversationBytes(c1()) }, go: "reject" } },
    { file: "conversation_diff_space_time.json", group: "permissive-timestamp", text: '{"schema_version": 1, "id": "00000000-0000-4000-8000-0000000000c1", "created_at": "2026-10-21 12:00:00+00:00", "updated_at": "2026-10-21T12:00:00Z", "messages": []}',
      why: "Python accepts a space separator (ISO 8601 beyond RFC 3339); TypeScript and Go require RFC 3339",
      expect: { ts: "reject", python: { bytes: conversationBytes(c1()) }, go: "reject" } },
    { file: "conversation_diff_unknown_provider.json", group: "unknown-provider", text: `${head}, "provider": "futureai", "model": "vendor/model:tag"}`,
      why: "Go reads an unknown provider but refuses to write it back; Python and TypeScript keep it",
      expect: { ts: { bytes: conversationBytes(c1({ provider: "futureai", model: "vendor/model:tag" })) }, python: { bytes: conversationBytes(c1({ provider: "futureai", model: "vendor/model:tag" })) }, go: "reject" } },
    { file: "conversation_diff_separators.json", group: "separators", text: null,
      value: c1({ messages: [{ role: "user", content: "ls\u2028ps\u2029end" }] }),
      why: "Go's JSON encoder always escapes U+2028/U+2029 as \\u2028/\\u2029; Python (ensure_ascii=False) and TypeScript write them raw. Same data, different bytes: Go output is accepted by both and normalizes back to the canonical bytes",
      expect: { ts: "canonical", python: "canonical", go: "canonical-with-escaped-separators" } },
    { file: "active_diff_unknown_provider.json", group: "unknown-provider", text: '{"schema_version": 1, "provider": "x", "model": "m"}\n',
      why: "docs/storage.md: an unknown active.json provider is a typed error in TypeScript and a warning in Go; Python accepts any provider string",
      expect: { ts: "reject", python: same('{"schema_version": 1, "provider": "x", "model": "m"}\n'), go: "reject" } },
  ];
}
