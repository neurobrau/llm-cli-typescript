import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveSettings } from "../src/application/resolve-settings.js";
import { SettingsError } from "../src/domain/errors.js";
import { styleInstructions } from "../src/domain/settings.js";
import type {
  CliOverrides,
  CliReasoning,
  ModelCapabilities,
  ModelPreferences,
  ReasoningSupport,
  SettingsInput,
  SettingsMode,
} from "../src/domain/settings.js";

const openaiLevels: ReasoningSupport = {
  known: true,
  values: ["none", "low", "medium", "high"],
  allowsModelDefault: true,
  defaultValue: "none",
  modelDefault: "medium",
};
const ollamaOnOff: ReasoningSupport = {
  known: true,
  values: ["off", "on"],
  allowsModelDefault: false,
  defaultValue: "off",
};
const noReasoning: ReasoningSupport = { known: true, values: [], allowsModelDefault: true };
const unknownSupport: ReasoningSupport = { known: false, values: [], allowsModelDefault: true };

function make(
  reasoning: ReasoningSupport,
  options: {
    cli?: CliOverrides;
    saved?: ModelPreferences;
    savedAnswerStyle?: SettingsInput["savedAnswerStyle"];
    limit?: number;
    mode?: SettingsMode;
    model?: string;
  } = {},
): SettingsInput {
  const capabilities: ModelCapabilities =
    options.limit === undefined ? { reasoning } : { reasoning, maxOutputTokensLimit: options.limit };
  return {
    provider: "openai",
    model: options.model ?? "m",
    capabilities,
    saved: options.saved ?? {},
    ...(options.savedAnswerStyle === undefined ? {} : { savedAnswerStyle: options.savedAnswerStyle }),
    cli: options.cli ?? {},
    mode: options.mode ?? "lenient",
  };
}

void describe("reasoning resolution", () => {
  void it("uses the confirmed application default when nothing is chosen", () => {
    const { settings, notices } = resolveSettings(make(openaiLevels));
    assert.deepEqual(settings.reasoning, { effort: "none", explicit: false, source: "builtin" });
    assert.deepEqual(notices, []);
    const ollama = resolveSettings(make(ollamaOnOff)).settings.reasoning;
    assert.deepEqual(ollama, { effort: "off", explicit: false, source: "builtin" });
  });

  void it("omits reasoning without a confirmed default or confirmed support", () => {
    for (const support of [noReasoning, unknownSupport, { ...openaiLevels, known: false }]) {
      const { settings } = resolveSettings(make(support));
      assert.deepEqual(settings.reasoning, { explicit: false, source: "builtin" });
    }
  });

  void it("lets a saved value override the builtin default, and CLI override saved", () => {
    const saved = { reasoning: "high" };
    assert.deepEqual(resolveSettings(make(openaiLevels, { saved })).settings.reasoning, {
      effort: "high",
      explicit: true,
      source: "saved",
    });
    const both = resolveSettings(make(openaiLevels, { saved, cli: { reasoning: "low" } }));
    assert.deepEqual(both.settings.reasoning, { effort: "low", explicit: true, source: "cli" });
    assert.deepEqual(both.notices, []);
    assert.deepEqual(resolveSettings(make(ollamaOnOff, { saved: { reasoning: "on" } })).settings.reasoning, {
      effort: "on",
      explicit: true,
      source: "saved",
    });
  });

  void it("omits the parameter for an explicit model default without selecting the application default", () => {
    const cli = resolveSettings(make(openaiLevels, { cli: { reasoning: "model-default" } }));
    assert.deepEqual(cli.settings.reasoning, { explicit: true, source: "cli" });
    const saved = resolveSettings(make(openaiLevels, { saved: { reasoning: "default" } }));
    assert.deepEqual(saved.settings.reasoning, { explicit: true, source: "saved" });
    const unknown = resolveSettings(make(unknownSupport, { cli: { reasoning: "model-default" } }));
    assert.deepEqual(unknown.settings.reasoning, { explicit: true, source: "cli" });
  });

  void it("maps CLI values by exact match, none/off alias and effort to on", () => {
    const cases: readonly { support: ReasoningSupport; cli: CliReasoning; effort: string }[] = [
      { support: openaiLevels, cli: "high", effort: "high" },
      { support: openaiLevels, cli: "off", effort: "none" },
      { support: ollamaOnOff, cli: "none", effort: "off" },
      { support: ollamaOnOff, cli: "off", effort: "off" },
      { support: ollamaOnOff, cli: "high", effort: "on" },
      { support: ollamaOnOff, cli: "on", effort: "on" },
      { support: { ...ollamaOnOff, values: ["low", "medium", "high"] }, cli: "medium", effort: "medium" },
    ];
    for (const { support, cli, effort } of cases) {
      const { settings } = resolveSettings(make(support, { cli: { reasoning: cli }, mode: "strict" }));
      assert.deepEqual(settings.reasoning, { effort, explicit: true, source: "cli" }, cli);
    }
  });

  void it("does not invent other aliases", () => {
    const levels = { ...ollamaOnOff, values: ["low", "high"] };
    assert.throws(() => resolveSettings(make(levels, { cli: { reasoning: "medium" }, mode: "strict" })), SettingsError);
    assert.throws(() => resolveSettings(make(levels, { cli: { reasoning: "none" }, mode: "strict" })), SettingsError);
  });

  void it("accepts none/off on a known non-reasoning model by omitting the parameter", () => {
    for (const cli of ["none", "off"] as const) {
      const { settings } = resolveSettings(make(noReasoning, { cli: { reasoning: cli }, mode: "strict" }));
      assert.deepEqual(settings.reasoning, { explicit: true, source: "cli" });
    }
  });

  void it("rejects concrete reasoning on a non-reasoning model: error in strict, notice in lenient", () => {
    const message = "m does not support reasoning; 'high' is not available";
    assert.throws(
      () => resolveSettings(make(noReasoning, { cli: { reasoning: "high" }, mode: "strict" })),
      (error: unknown) => error instanceof SettingsError && error.message === `${message}.`,
    );
    const lenient = resolveSettings(make(noReasoning, { cli: { reasoning: "high" } }));
    assert.deepEqual(lenient.notices, [`${message}; ignoring the command-line value.`]);
    assert.deepEqual(lenient.settings.reasoning, { explicit: false, source: "builtin" });
  });

  void it("passes explicit concrete values through when support is unknown", () => {
    const { settings, notices } = resolveSettings(make(unknownSupport, { cli: { reasoning: "xhigh" }, mode: "strict" }));
    assert.deepEqual(settings.reasoning, { effort: "xhigh", explicit: true, source: "cli" });
    assert.deepEqual(notices, []);
  });

  void it("rejects model-default when capabilities forbid it", () => {
    const message = "m has no model-default reasoning choice (m supports reasoning: Off, On).";
    assert.throws(
      () => resolveSettings(make(ollamaOnOff, { cli: { reasoning: "model-default" }, mode: "strict" })),
      (error: unknown) => error instanceof SettingsError && error.message === message,
    );
  });

  void it("falls back from a rejected lenient CLI value to a valid saved value before the builtin default", () => {
    const result = resolveSettings(
      make(ollamaOnOff, { cli: { reasoning: "model-default" }, saved: { reasoning: "on" } }),
    );
    assert.deepEqual(result.settings.reasoning, { effort: "on", explicit: true, source: "saved" });
    assert.deepEqual(result.notices, [
      "m has no model-default reasoning choice (m supports reasoning: Off, On); ignoring the command-line value.",
    ]);
    const noSaved = resolveSettings(make(ollamaOnOff, { cli: { reasoning: "model-default" } }));
    assert.deepEqual(noSaved.settings.reasoning, { effort: "off", explicit: false, source: "builtin" });
  });

  void it("accepts only exactly offered saved values, without CLI aliases", () => {
    const cases: readonly { support: ReasoningSupport; saved: string }[] = [
      { support: openaiLevels, saved: "xhigh" },
      { support: ollamaOnOff, saved: "high" },
      { support: openaiLevels, saved: "off" },
      { support: unknownSupport, saved: "low" },
      { support: noReasoning, saved: "none" },
    ];
    for (const { support, saved } of cases) {
      const { settings, notices } = resolveSettings(make(support, { saved: { reasoning: saved } }));
      assert.equal(settings.reasoning.source, "builtin", saved);
      assert.equal(settings.reasoning.explicit, false);
      assert.equal(notices.length, 1);
      assert.match(notices[0] ?? "", /^Saved reasoning '.+' is not available for m \(.+\); using .+\.$/);
    }
  });

  void it("explains an unsupported saved value with stable wording", () => {
    const { notices } = resolveSettings(make(ollamaOnOff, { saved: { reasoning: "high" } }));
    assert.deepEqual(notices, [
      "Saved reasoning 'High' is not available for m (m supports reasoning: Off, On); using Off.",
    ]);
  });

  void it("refuses saved 'default' when omission is not selectable", () => {
    const { settings, notices } = resolveSettings(make(ollamaOnOff, { saved: { reasoning: "default" } }));
    assert.deepEqual(settings.reasoning, { effort: "off", explicit: false, source: "builtin" });
    assert.deepEqual(notices, [
      "Saved reasoning 'Default' is not available for m (m supports reasoning: Off, On); using Off.",
    ]);
  });
});

void describe("max output tokens resolution", () => {
  void it("distinguishes absent, saved null and chosen values", () => {
    assert.deepEqual(resolveSettings(make(unknownSupport)).settings.maxOutputTokens, {
      explicit: false,
      source: "builtin",
    });
    assert.deepEqual(resolveSettings(make(unknownSupport, { saved: { maxOutputTokens: null } })).settings.maxOutputTokens, {
      explicit: true,
      source: "saved",
    });
    assert.deepEqual(resolveSettings(make(unknownSupport, { saved: { maxOutputTokens: 600 } })).settings.maxOutputTokens, {
      value: 600,
      explicit: true,
      source: "saved",
    });
  });

  void it("lets CLI override saved, including invalid saved values, without notices", () => {
    for (const saved of [{ maxOutputTokens: 600 }, { maxOutputTokens: null }, { maxOutputTokens: 9999 }]) {
      const result = resolveSettings(make(unknownSupport, { saved, cli: { maxOutputTokens: 100 }, limit: 4096 }));
      assert.deepEqual(result.settings.maxOutputTokens, { value: 100, explicit: true, source: "cli" });
      assert.deepEqual(result.notices, []);
    }
  });

  void it("accepts values up to and including a known limit, and rejects larger ones", () => {
    const equal = resolveSettings(make(unknownSupport, { cli: { maxOutputTokens: 4096 }, limit: 4096, mode: "strict" }));
    assert.equal(equal.settings.maxOutputTokens.value, 4096);
    assert.throws(
      () => resolveSettings(make(unknownSupport, { cli: { maxOutputTokens: 4097 }, limit: 4096, mode: "strict" })),
      (error: unknown) =>
        error instanceof SettingsError && error.message === "4097 exceeds the limit of 4096 output tokens for m.",
    );
  });

  void it("imposes no ceiling when the limit is unknown", () => {
    const { settings } = resolveSettings(make(unknownSupport, { cli: { maxOutputTokens: Number.MAX_SAFE_INTEGER }, mode: "strict" }));
    assert.equal(settings.maxOutputTokens.value, Number.MAX_SAFE_INTEGER);
  });

  void it("rejects invalid CLI values in strict mode and ignores them with a notice in lenient mode", () => {
    const invalid: readonly unknown[] = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "100", true, null];
    for (const value of invalid) {
      const cli = { maxOutputTokens: value as number };
      assert.throws(() => resolveSettings(make(unknownSupport, { cli, mode: "strict" })), SettingsError, String(value));
      const lenient = resolveSettings(make(unknownSupport, { cli, saved: { maxOutputTokens: 300 } }));
      assert.deepEqual(lenient.settings.maxOutputTokens, { value: 300, explicit: true, source: "saved" });
      assert.equal(lenient.notices.length, 1);
      assert.match(lenient.notices[0] ?? "", /^Max output tokens must be a positive whole number, not .+\. Using the default\.$/);
    }
  });

  void it("falls back to omission with a notice for invalid or excessive saved values", () => {
    const tooBig = resolveSettings(make(unknownSupport, { saved: { maxOutputTokens: 5000 }, limit: 4096 }));
    assert.deepEqual(tooBig.settings.maxOutputTokens, { explicit: false, source: "builtin" });
    assert.deepEqual(tooBig.notices, [
      "Saved setting ignored: 5000 exceeds the limit of 4096 output tokens for m. Using the default.",
    ]);
    for (const value of [0, -5, 2.5, Number.NaN]) {
      const result = resolveSettings(make(unknownSupport, { saved: { maxOutputTokens: value } }));
      assert.equal(result.settings.maxOutputTokens.source, "builtin");
      assert.equal(result.notices.length, 1);
    }
  });
});

void describe("reference regression cases", () => {
  // Derived from Go chat/settings_test.go and Python tests/test_preferences.py.
  const luna: ReasoningSupport = {
    known: true,
    values: ["none", "low", "medium", "high", "xhigh"],
    allowsModelDefault: true,
    defaultValue: "none",
    modelDefault: "medium",
  };

  void it("lists the offered values in a strict CLI error", () => {
    assert.throws(
      () => resolveSettings(make(luna, { cli: { reasoning: "minimal" }, mode: "strict" })),
      (error: unknown) =>
        error instanceof SettingsError &&
        error.message === "m supports reasoning: None, Low, Medium, High, XHigh; 'minimal' is not available.",
    );
  });

  void it("does not let a valid saved value rescue an invalid strict flag", () => {
    const saved = { reasoning: "off", maxOutputTokens: 10 };
    assert.throws(() => resolveSettings(make(ollamaOnOff, { saved, cli: { reasoning: "model-default" }, mode: "strict" })), SettingsError);
    assert.throws(() => resolveSettings(make(luna, { saved, cli: { maxOutputTokens: 5000 }, limit: 4096, mode: "strict" })), SettingsError);
  });

  void it("falls back to saved values with the reference notices when a switched model rejects both flags", () => {
    const result = resolveSettings(
      make(ollamaOnOff, {
        model: "qwen3.5:4b",
        cli: { reasoning: "model-default", maxOutputTokens: 9000 },
        saved: { reasoning: "on", maxOutputTokens: 512 },
        limit: 4096,
      }),
    );
    assert.deepEqual(result.settings.reasoning, { effort: "on", explicit: true, source: "saved" });
    assert.deepEqual(result.settings.maxOutputTokens, { value: 512, explicit: true, source: "saved" });
    assert.deepEqual(result.notices, [
      "qwen3.5:4b has no model-default reasoning choice (qwen3.5:4b supports reasoning: Off, On); ignoring the command-line value.",
      "9000 exceeds the limit of 4096 output tokens for qwen3.5:4b. Using the default.",
    ]);
  });

  void it("labels an unusable saved 'default' as Default and an absent builtin default as Model default", () => {
    const { notices } = resolveSettings(make(unknownSupport, { saved: { reasoning: "low" } }));
    assert.deepEqual(notices, [
      "Saved reasoning 'Low' is not available for m (m reasoning support is not confirmed); using Model default.",
    ]);
    const levels = { known: true, values: ["low", "medium", "high"], allowsModelDefault: true } satisfies ReasoningSupport;
    const rejected = resolveSettings(make(levels, { cli: { reasoning: "xhigh" } }));
    assert.deepEqual(rejected.settings.reasoning, { explicit: false, source: "builtin" });
    assert.match(rejected.notices[0] ?? "", /'xhigh' is not available/);
  });

  void it("keeps settings of different models independent", () => {
    const first = resolveSettings(make(luna, { model: "m", saved: { reasoning: "high" } }));
    const other = resolveSettings(make(luna, { model: "other" }));
    assert.equal(first.settings.reasoning.effort, "high");
    assert.equal(other.settings.reasoning.effort, "none");
  });
});

void describe("answer style resolution", () => {
  void it("prefers CLI, then saved, then normal", () => {
    const resolve = (cli: CliOverrides, saved?: "brief" | "detailed") =>
      resolveSettings(make(unknownSupport, { cli, ...(saved === undefined ? {} : { savedAnswerStyle: saved }) })).settings.answerStyle;
    assert.deepEqual(resolve({ answerStyle: "detailed" }, "brief"), { value: "detailed", source: "cli" });
    assert.deepEqual(resolve({}, "brief"), { value: "brief", source: "saved" });
    assert.deepEqual(resolve({}), { value: "normal", source: "builtin" });
  });

  void it("supplies the reference instruction text; normal supplies none", () => {
    assert.equal(
      styleInstructions("brief"),
      "Answer briefly and concisely. Use a few sentences or a short list. " +
        "Leave out background and caveats unless the user asks for them.",
    );
    assert.equal(
      styleInstructions("detailed"),
      "Give a comprehensive, well-structured explanation. Cover the relevant " +
        "background and the reasoning behind the answer, and include concrete " +
        "examples when they help.",
    );
    assert.equal(styleInstructions("normal"), undefined);
  });
});

void describe("resolver purity", () => {
  void it("resolves different provider/model selections independently", () => {
    const first = resolveSettings(make(openaiLevels, { model: "a", saved: { reasoning: "high" } }));
    const second = resolveSettings(make(openaiLevels, { model: "b" }));
    assert.equal(first.settings.model, "a");
    assert.equal(first.settings.reasoning.effort, "high");
    assert.equal(second.settings.model, "b");
    assert.equal(second.settings.reasoning.effort, "none");
    const ollama = resolveSettings({ ...make(ollamaOnOff), provider: "ollama" });
    assert.equal(ollama.settings.provider, "ollama");
  });

  void it("does not mutate inputs and is repeatable", () => {
    const values = Object.freeze(["off", "on"]);
    const support: ReasoningSupport = Object.freeze({ ...ollamaOnOff, values });
    const input = Object.freeze(
      make(support, { cli: Object.freeze({ reasoning: "high" }), saved: Object.freeze({ reasoning: "on" }) }),
    );
    const snapshot = JSON.stringify(input);
    const first = resolveSettings(input);
    const second = resolveSettings(input);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(input), snapshot);
    assert.notEqual(first.settings.reasoning, second.settings.reasoning);
  });
});
