// Exact pricing differential: the real Python pricing functions, the real Go
// pricing functions (adapter) and the TypeScript module over the Task 010 corpus.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CASES, MONEY } from "../pricing-cases.mjs";
import { Failure, coverageProblems, expectClean, fractionFromDecimal, fractionFromParts, parseOracleJson, runBounded, sameFraction, showFraction } from "./lib.mjs";

const INT64_MAX = 9223372036854775807n;
const COUNT_KEYS = ["input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cache_write_tokens", "reasoning_tokens"];

/** Case names that contain a count Go's signed 64-bit integers cannot hold (computed here, independently of Go). */
export function beyondInt64(cases) {
  return cases.filter((item) => item.records.some((r) => COUNT_KEYS.some((k) => r.usage[k] !== undefined && r.usage[k] !== null && BigInt(r.usage[k]) > INT64_MAX))).map((item) => item.name);
}

const toRequest = (item) => {
  const usage = {};
  for (const [key, property] of [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"], ["cached_input_tokens", "cachedInputTokens"], ["cache_write_tokens", "cacheWriteTokens"]]) {
    const value = item.usage[key];
    if (value !== undefined && value !== null) usage[property] = BigInt(value);
  }
  return { provider: item.provider, model: item.model, ...(item.tier === undefined ? {} : { serviceTier: item.tier }), usage };
};

/** TypeScript results, with exact rational amounts. */
export function tsPricing(modules, cases, money) {
  const { pricing } = modules;
  const exact = (cost) => (cost === undefined ? null : { status: cost.status, amount: cost.amount === undefined ? null : fractionFromDecimal(pricing.exactDecimal(cost.amount)), notes: [...cost.notes] });
  const caseResults = cases.map((item) => {
    const requests = item.records.map(toRequest);
    const total = pricing.totalCost(requests);
    return {
      name: item.name,
      estimates: requests.map((r) => exact(pricing.estimate(r))),
      total: exact(total),
      short: pricing.formatCostShort(total),
      describe: pricing.describeCost(total),
    };
  });
  const moneyResults = money.map((text) => ({ amount: text, text: pricing.formatMoney(usdFromDecimal(text, modules.money.USD_DENOMINATOR)) }));
  return { version: pricing.PRICING_VERSION, sources: [...pricing.PRICING_SOURCES], cases: caseResults, money: moneyResults };
}

function usdFromDecimal(text, denominator) {
  const [n, d] = fractionFromDecimal(text);
  const units = (n * denominator) / d;
  if (units * d !== n * denominator) throw new Failure(`inexact money fixture ${text}`);
  return { units };
}

const fromPython = (cost) => (cost === null ? null : { status: cost.status, amount: cost.amount === null ? null : fractionFromDecimal(cost.amount), notes: cost.notes });
const fromGo = (cost) => (cost === null ? null : { status: cost.status, amount: cost.num === null ? null : fractionFromParts(cost.num, cost.den), notes: cost.notes });

function sameCost(a, b) {
  if (a === null || b === null) return a === b;
  const amount = a.amount === null || b.amount === null ? a.amount === b.amount : sameFraction(a.amount, b.amount);
  return a.status === b.status && amount && JSON.stringify(a.notes) === JSON.stringify(b.notes);
}
const showCost = (c) => (c === null ? "none" : `${c.status} ${c.amount === null ? "-" : showFraction(c.amount)} ${JSON.stringify(c.notes)}`);

/**
 * Compares TS against one reference ("Python"/"Go") for the cases it covers.
 * Returns problem strings; empty means identical (amounts as exact rationals).
 */
export function comparePricing(label, expectedNames, expectedMoney, ts, ref, skip = new Set()) {
  const names = expectedNames.filter((n) => !skip.has(n));
  const problems = [
    ...coverageProblems(`${label} cases`, expectedNames, ref.cases.map((c) => c.name)),
    ...coverageProblems(`${label} money`, expectedMoney, ref.money.map((m) => m.amount)),
  ];
  if (problems.length > 0) return problems;
  if (ref.version !== ts.version) problems.push(`${label}: catalog version ${ref.version} vs TypeScript ${ts.version}`);
  if (JSON.stringify(ref.sources) !== JSON.stringify(ts.sources)) problems.push(`${label}: catalog sources differ`);
  const refCases = new Map(ref.cases.map((c) => [c.name, c]));
  const tsCases = new Map(ts.cases.map((c) => [c.name, c]));
  for (const name of names) {
    const r = refCases.get(name);
    const t = tsCases.get(name);
    if (r.estimates.length !== t.estimates.length) {
      problems.push(`${label} ${name}: estimate count ${String(r.estimates.length)} vs ${String(t.estimates.length)}`);
      continue;
    }
    r.estimates.forEach((estimate, index) => {
      if (!sameCost(estimate, t.estimates[index])) problems.push(`${label} ${name}[${String(index)}]: ${showCost(estimate)} vs TypeScript ${showCost(t.estimates[index])}`);
    });
    if (!sameCost(r.total, t.total)) problems.push(`${label} ${name}: total ${showCost(r.total)} vs TypeScript ${showCost(t.total)}`);
    if (r.short !== t.short) problems.push(`${label} ${name}: short ${JSON.stringify(r.short)} vs ${JSON.stringify(t.short)}`);
    if (r.describe !== t.describe) problems.push(`${label} ${name}: describe ${JSON.stringify(r.describe)} vs ${JSON.stringify(t.describe)}`);
  }
  const refMoney = new Map(ref.money.map((m) => [m.amount, m.text]));
  for (const m of ts.money) if (refMoney.get(m.amount) !== m.text) problems.push(`${label} money ${m.amount}: ${String(refMoney.get(m.amount))} vs TypeScript ${m.text}`);
  return problems;
}

export async function stagePricing(ctx) {
  const input = join(ctx.scratch, "pricing-cases.json");
  writeFileSync(input, JSON.stringify({ cases: CASES, money: MONEY }));
  const rawPy = parseOracleJson(expectClean(await runBounded(ctx.py.exe, ["-B", "-I", join(ctx.root, "scripts", "xparity", "py_pricing.py"), ctx.py.src, input], { env: ctx.py.env }), "Python pricing oracle"), "Python pricing oracle");
  const rawGo = parseOracleJson(expectClean(await runBounded(ctx.go.exe, ["pricing", input], { env: ctx.go.env }), "Go pricing oracle"), "Go pricing oracle");
  for (const [name, raw] of [["Python", rawPy], ["Go", rawGo]]) if (!Array.isArray(raw.cases) || !Array.isArray(raw.money)) throw new Failure(`${name} pricing oracle output is malformed`);
  const py = { ...rawPy, cases: rawPy.cases.map((c) => ({ ...c, estimates: c.estimates.map(fromPython), total: fromPython(c.total) })) };
  const goAll = { ...rawGo, cases: rawGo.cases.map((c) => ({ ...c, estimates: c.estimates.map(fromGo), total: fromGo(c.total ?? null) })) };
  const ts = tsPricing(ctx.modules, CASES, MONEY);

  const names = CASES.map((c) => c.name);
  // Go's classification of out-of-domain cases must be exactly the independently computed set.
  const expectedOut = beyondInt64(CASES);
  const goOut = goAll.cases.filter((c) => c.out_of_domain).map((c) => c.name);
  if (JSON.stringify([...goOut].sort()) !== JSON.stringify([...expectedOut].sort())) throw new Failure(`Go out-of-domain set ${JSON.stringify(goOut)} differs from the cases above signed 64 bits ${JSON.stringify(expectedOut)}`);
  const skipGo = new Set(goOut);
  // Go prints a null total for the empty conversation; the other fields are compared normally.
  const problemsPy = comparePricing("Python", names, MONEY, ts, py);
  const problemsGo = comparePricing("Go", names, MONEY, ts, goAll, skipGo);
  const problems = [...problemsPy, ...problemsGo];
  if (problems.length > 0) throw new Failure(`${String(problems.length)} pricing difference(s):\n  ${problems.slice(0, 25).join("\n  ")}`);

  // The TS /usage cost line must equal the references' describe text for ordinary data (hostile names are escaped, see below).
  const lineProblems = [];
  for (const item of CASES) {
    if (item.records.length === 0) continue;
    const stored = item.records.map((r) => ({ at: new Date(0), provider: r.provider, model: r.model, status: r.status ?? "completed", ...(r.tier === undefined ? {} : { serviceTier: r.tier }), usage: Object.fromEntries(COUNT_KEYS.filter((k) => r.usage[k] !== undefined && r.usage[k] !== null).map((k) => [camel(k), BigInt(r.usage[k])])) }));
    const line = ctx.modules.usageReport.costLine(stored);
    const reference = py.cases.find((c) => c.name === item.name).describe;
    if (line !== reference) lineProblems.push(`${item.name}: /usage cost line ${JSON.stringify(line)} vs Python ${JSON.stringify(reference)}`);
  }
  const hostile = ctx.modules.usageReport.costLine([{ at: new Date(0), provider: "openai", model: "evil\u001b[2Jmodel", status: "completed", serviceTier: "default", usage: { inputTokens: 1n, outputTokens: 1n } }]);
  if (hostile.includes("\u001b") || !hostile.includes("evil\\x1b[2Jmodel")) lineProblems.push("hostile model name is not escaped in the /usage cost line");
  if (lineProblems.length > 0) throw new Failure(lineProblems.slice(0, 10).join("\n  "));

  // Negative controls.
  const bump = (ref) => ({ ...ref, cases: ref.cases.map((c, i) => (i === 0 ? { ...c, estimates: c.estimates.map((e) => (e === null ? e : { ...e, amount: e.amount === null ? e.amount : [e.amount[0] + 1n, e.amount[1]] })) } : c)) });
  const controls = [
    ["altered Python amount", comparePricing("Python", names, MONEY, ts, bump(py))],
    ["altered Go note", comparePricing("Go", names, MONEY, ts, { ...goAll, cases: goAll.cases.map((c, i) => (i === 0 ? { ...c, total: c.total === null ? c.total : { ...c.total, notes: [...c.total.notes, "x"] } } : c)) }, skipGo)],
    ["dropped Python case", comparePricing("Python", names, MONEY, ts, { ...py, cases: py.cases.slice(0, -1) })],
    ["dropped last Go money fixture", comparePricing("Go", names, MONEY, ts, { ...goAll, money: goAll.money.slice(0, -1) }, skipGo)],
    ["duplicated Python money fixture", comparePricing("Python", names, MONEY, ts, { ...py, money: [...py.money, py.money[0]] })],
    ["altered money text", comparePricing("Python", names, MONEY, ts, { ...py, money: py.money.map((m, i) => (i === 3 ? { ...m, text: `${m.text}0` } : m)) })],
    ["emptied case set", comparePricing("Python", [], MONEY, ts, py)],
  ];
  for (const [name, found] of controls) if (found.length === 0) throw new Failure(`pricing negative control "${name}" was not detected`);

  const inDomain = names.length - goOut.length;
  return `${String(names.length)} cases / ${String(CASES.reduce((n, c) => n + c.records.length, 0))} records / ${String(MONEY.length)} money fixtures identical to Python (exact rationals); ${String(inDomain)} cases identical to Go, ${String(goOut.length)} above signed 64 bits (Python/TypeScript only: ${goOut.join("; ")}); /usage cost line equals Python's text for every non-empty case; 7 negative controls detected`;
}

const camel = (key) => key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
