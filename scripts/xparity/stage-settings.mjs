// Settings-resolution differential: the real Python resolver, the real Go
// resolver (through the adapter) and the TypeScript resolver over one matrix.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { SETTINGS_CASES } from "./settings-cases.mjs";
import { Failure, compareSettings, coverageProblems, expectClean, parseOracleJson, runBounded } from "./lib.mjs";

/** TypeScript resolver for one case (pure; the caller supplies capabilities). */
export function tsSettings(resolveSettings, item) {
  const support = item.support;
  const input = {
    provider: "openai",
    model: "m",
    capabilities: {
      reasoning: { known: support.known, values: support.values, allowsModelDefault: support.allows_default, ...(support.default === "" ? {} : { defaultValue: support.default }) },
      ...(item.limit === null ? {} : { maxOutputTokensLimit: item.limit }),
    },
    saved: { ...(item.prefs.reasoning === null ? {} : { reasoning: item.prefs.reasoning }), ...(item.prefs.max_set ? { maxOutputTokens: item.prefs.max } : {}) },
    cli: { ...(item.overrides.reasoning === null ? {} : { reasoning: item.overrides.reasoning }), ...(item.overrides.max === null ? {} : { maxOutputTokens: item.overrides.max }) },
    mode: item.strict ? "strict" : "lenient",
  };
  try {
    const resolved = resolveSettings(input);
    return {
      id: item.id,
      effort: resolved.settings.reasoning.effort ?? "",
      explicit: resolved.settings.reasoning.explicit,
      effective: resolved.settings.reasoning.effort ?? "",
      max: resolved.settings.maxOutputTokens.value ?? 0,
      notices: [...resolved.notices],
    };
  } catch (error) {
    return { id: item.id, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Pure comparison of three result lists; used by the stage and by the negative controls. */
export function compareSettingsMatrix(cases, py, go, ts) {
  const problems = [
    ...coverageProblems("Python settings", cases.map((c) => c.id), py.map((r) => r.id)),
    ...coverageProblems("Go settings", cases.map((c) => c.id), go.map((r) => r.id)),
    ...coverageProblems("TypeScript settings", cases.map((c) => c.id), ts.map((r) => r.id)),
  ];
  if (problems.length > 0) return { problems, rules: new Map() };
  const index = (list) => new Map(list.map((r) => [r.id, r]));
  const [P, G, T] = [index(py), index(go), index(ts)];
  const rules = new Map();
  for (const item of cases) {
    const sibling = item.overrides.max !== null && item.overrides.max <= 0 ? G.get(item.id.replace(/\/cli=[^/]*\//, "/cli=-/")) : undefined;
    const outcome = compareSettings(item, P.get(item.id), G.get(item.id), T.get(item.id), sibling);
    problems.push(...outcome.problems);
    for (const rule of outcome.rules) rules.set(rule, (rules.get(rule) ?? 0) + 1);
  }
  return { problems, rules };
}

export async function stageSettings(ctx) {
  const file = join(ctx.scratch, "settings-cases.json");
  writeFileSync(file, JSON.stringify(SETTINGS_CASES));
  const py = parseOracleJson(expectClean(await runBounded(ctx.py.exe, ["-B", "-I", join(ctx.root, "scripts", "xparity", "py_settings.py"), ctx.py.src, file], { env: ctx.py.env }), "Python settings oracle"), "Python settings oracle");
  const go = parseOracleJson(expectClean(await runBounded(ctx.go.exe, ["settings", file], { env: ctx.go.env }), "Go settings oracle"), "Go settings oracle");
  if (!Array.isArray(py) || !Array.isArray(go)) throw new Failure("settings oracle output is not a list");
  const ts = SETTINGS_CASES.map((item) => tsSettings(ctx.modules.settings.resolveSettings, item));

  const { problems, rules } = compareSettingsMatrix(SETTINGS_CASES, py, go, ts);
  if (problems.length > 0) throw new Failure(`${String(problems.length)} unexpected settings difference(s):\n  ${problems.slice(0, 25).join("\n  ")}`);

  // Negative controls: a changed effective value, a changed notice and a dropped result must each be caught.
  const mutate = (list, change) => list.map((r, i) => (i === 7 ? change({ ...r }) : r));
  const controls = [
    ["altered Go value", compareSettingsMatrix(SETTINGS_CASES, py, mutate(go, (r) => ({ ...r, max: (r.max ?? 0) + 1 })), ts)],
    ["altered TypeScript notice", compareSettingsMatrix(SETTINGS_CASES, py, go, mutate(ts, (r) => ({ ...r, notices: [...(r.notices ?? []), "extra"] })))],
    ["dropped Python result", compareSettingsMatrix(SETTINGS_CASES, py.slice(0, -1), go, ts)],
    ["duplicated Go result", compareSettingsMatrix(SETTINGS_CASES, py, [...go, go[0]], ts)],
  ];
  for (const [name, outcome] of controls) {
    if (outcome.problems.length === 0) throw new Failure(`settings negative control "${name}" was not detected`);
  }
  const ruleText = [...rules].map(([name, count]) => `${name}=${String(count)}`).join(", ");
  return `${String(SETTINGS_CASES.length)} cases identical across Python, Go and TypeScript except the documented rules (${ruleText}); 4 negative controls detected`;
}
