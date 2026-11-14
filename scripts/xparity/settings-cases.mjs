// Deterministic settings-resolution matrix for the cross-language check.
// Case ids are unique and named by coverage group; the same list is given to
// the real Python resolver, the real Go resolver and the TypeScript resolver.
const SUPPORTS = {
  levels: { values: ["none", "low", "medium", "high", "xhigh"], known: true, default: "none", allows_default: true },
  levelsNoDefaultValue: { values: ["low", "medium", "high"], known: true, default: "", allows_default: true },
  offOn: { values: ["off", "on"], known: true, default: "off", allows_default: false },
  none: { values: [], known: true, default: "", allows_default: true },
  unknown: { values: [], known: false, default: "", allows_default: true },
};
const CLI_REASONING = [null, "model-default", "low", "high", "xhigh", "none", "off", "on", "bogus"];
const SAVED_REASONING = [null, "default", "low", "none", "off", "on", "stale"];
const LIMITS = [null, 4096];

const cases = [];
const add = (id, support, rest = {}) =>
  cases.push({
    id,
    support: SUPPORTS[support],
    support_error: "",
    limit: null,
    prefs: { reasoning: null, max_set: false, max: null, ...(rest.prefs ?? {}) },
    overrides: { reasoning: null, max: null, ...(rest.overrides ?? {}) },
    strict: false,
    ...(rest.top ?? {}),
  });

// reasoning: every support x CLI value x saved value x strictness
for (const [name] of Object.entries(SUPPORTS)) {
  for (const cli of CLI_REASONING) {
    for (const saved of SAVED_REASONING) {
      for (const strict of [true, false]) {
        add(`reasoning/${name}/cli=${cli ?? "-"}/saved=${saved ?? "-"}/${strict ? "strict" : "lenient"}`, name, {
          prefs: { reasoning: saved },
          overrides: { reasoning: cli },
          top: { strict },
        });
      }
    }
  }
}

// maximum output tokens: absent / null / integer, CLI and saved, around the limit, strict and lenient
const CLI_MAX = [null, 1, 4096, 4097, 0, -5];
const SAVED_MAX = [
  { max_set: false, max: null },
  { max_set: true, max: null },
  { max_set: true, max: 1 },
  { max_set: true, max: 4096 },
  { max_set: true, max: 4097 },
  { max_set: true, max: 600 },
];
for (const limit of LIMITS) {
  for (const cli of CLI_MAX) {
    for (const saved of SAVED_MAX) {
      for (const strict of [true, false]) {
        add(`max/limit=${limit ?? "-"}/cli=${cli ?? "-"}/saved=${saved.max_set ? String(saved.max) : "-"}/${strict ? "strict" : "lenient"}`, "levels", {
          prefs: saved,
          overrides: { max: cli },
          top: { limit, strict },
        });
      }
    }
  }
}

// a failed capability lookup (Python/Go only; the TypeScript resolver is pure and its caller adds that notice)
for (const [name, cli, saved] of [["none", null, null], ["cli-effort", "low", null], ["saved-effort", null, "low"], ["saved-default", null, "default"]]) {
  add(`support-error/${name}`, "unknown", { prefs: { reasoning: saved }, overrides: { reasoning: cli }, top: { support_error: "network is unreachable" } });
}

// the combined worked example
add("combined/cli-wins-over-saved", "levels", { prefs: { reasoning: "low", max_set: true, max: 600 }, overrides: { reasoning: "high", max: 1000 }, top: { limit: 4096 } });
add("combined/saved-both", "levels", { prefs: { reasoning: "low", max_set: true, max: 600 }, top: { limit: 4096 } });
add("combined/strict-both-bad", "none", { overrides: { reasoning: "low", max: 9999 }, top: { limit: 4096, strict: true } });

export const SETTINGS_CASES = Object.freeze(cases);
export const SETTINGS_GROUPS = Object.freeze(["reasoning", "max", "support-error", "combined"]);
