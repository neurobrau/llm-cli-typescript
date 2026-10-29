/**
 * TS-created synthetic storage cases. Each case has typed in-memory input and
 * a committed expected-bytes file under tests/fixtures/storage/ts/. Tests
 * check encode(input) === file bytes and decode(file) === input.
 */
import type {
  ActiveSelection,
  StoredConversation,
  StoredModelPreferences,
  StoredSettings,
} from "../../src/storage/index.js";

export const at = (iso: string): Date => new Date(iso);

const BEYOND_64_BIT = 2n ** 70n + 5n; // 1180591620717411303429

export const conversationCases: readonly { readonly file: string; readonly value: StoredConversation }[] = [
  {
    file: "conversation_control_chars.json",
    value: {
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: at("2026-01-02T03:04:05.006Z"),
      updatedAt: at("2026-01-02T03:04:05.006Z"),
      provider: "ollama",
      model: "hf.co/org/model:Q4_K_M",
      messages: [
        { role: "user", content: "line one\nline two\r\n\ttabbed \"quoted\" back\\slash" },
        { role: "assistant", content: "ctrl \u0001 \u001f \b \f del\u007f nul-free; ls\u2028ps\u2029 snow ☃ astral 😀 é" },
        { role: "user", content: "" },
      ],
      requests: [],
    },
  },
  {
    file: "conversation_usage_edges.json",
    value: {
      id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      createdAt: at("2026-10-21T12:00:00.000Z"),
      updatedAt: at("2026-10-21T12:00:00.999Z"),
      provider: "openai",
      model: "gpt-6-luna",
      messages: [{ role: "user", content: "hi" }],
      requests: [
        {
          at: at("2026-10-21T12:00:00.000Z"),
          provider: "openai",
          model: "gpt-6-luna",
          status: "completed",
          serviceTier: "",
          usage: { inputTokens: 0n, outputTokens: 0n },
        },
        {
          at: at("2026-10-21T12:00:01.000Z"),
          provider: "ollama",
          model: "m",
          status: "incomplete",
          usage: {},
        },
        {
          at: at("2026-10-21T12:00:02.000Z"),
          provider: "",
          model: "",
          status: "completed",
          serviceTier: "flex",
          usage: {
            inputTokens: 9007199254740993n,
            outputTokens: 9223372036854775807n,
            totalTokens: BEYOND_64_BIT,
            cachedInputTokens: 9007199254740992n,
            cacheWriteTokens: 1n,
            reasoningTokens: 0n,
          },
        },
      ],
    },
  },
  {
    file: "conversation_timestamps.json",
    value: {
      id: "11111111-2222-3333-4444-555555555555",
      createdAt: at("0001-01-01T00:00:00.000Z"),
      updatedAt: at("9999-12-31T23:59:59.999Z"),
      messages: [],
      requests: [
        { at: at("1969-12-31T23:59:59.999Z"), provider: "p", model: "m", status: "completed", usage: {} },
        { at: at("1970-01-01T00:00:00.000Z"), provider: "p", model: "m", status: "completed", usage: {} },
        { at: at("2024-02-29T23:59:59.001Z"), provider: "p", model: "m", status: "completed", usage: {} },
      ],
    },
  },
  {
    file: "conversation_unknown_provider.json",
    value: {
      id: "0b6f8e52-2c1d-4c7e-9a3b-5d2e1f0a9c41",
      createdAt: at("2030-05-06T07:08:09.010Z"),
      updatedAt: at("2030-05-06T07:08:09.010Z"),
      provider: "futureai",
      model: "vendor/model:tag",
      messages: [{ role: "assistant", content: "x" }],
      requests: [],
    },
  },
];

const prefs = (value: StoredModelPreferences): StoredModelPreferences => value;
const models = (...entries: [string, StoredModelPreferences][]): ReadonlyMap<string, StoredModelPreferences> => new Map(entries);

export const settingsCases: readonly { readonly file: string; readonly value: StoredSettings }[] = [
  {
    file: "settings_special_keys.json",
    value: {
      answerStyle: "detailed",
      providers: new Map([
        // Deliberately not in sorted order; the writer sorts by code point.
        ["😀", models(["z", prefs({ reasoning: "low" })])],
        ["￮", models(["bmp-high", prefs({ maxOutputTokens: 1n })])],
        [
          "__proto__",
          models(
            ["constructor", prefs({ reasoning: "default" })],
            ["__proto__", prefs({ maxOutputTokens: null })],
            ["toString", prefs({ reasoning: "on", maxOutputTokens: 9007199254740993n })],
          ),
        ],
        [
          "ollama",
          models(
            ["10", prefs({ maxOutputTokens: 2n ** 70n })],
            ["9", prefs({ reasoning: "off" })],
            ["1", prefs({ reasoning: "high" })],
            ["a/b:c", prefs({ maxOutputTokens: 600n })],
            ["é", prefs({ reasoning: "x" })],
            ["Z", prefs({ reasoning: "upper" })],
            ["a", prefs({ reasoning: "lower" })],
          ),
        ],
        ["openai", models(["gpt-6-luna", prefs({ maxOutputTokens: BEYOND_64_BIT })])],
      ]),
    },
  },
  { file: "settings_empty.json", value: { answerStyle: "normal", providers: new Map() } },
];

export const activeCases: readonly { readonly file: string; readonly value: ActiveSelection }[] = [
  { file: "active_unicode.json", value: { provider: "ollama", model: "mödel \"q\" \\ 日本 😀\n" } },
];
