// Pure helpers of the pricing parity check: the TypeScript results for the
// shared cases, and the comparison with what the real Python functions printed.

/** "0.0060000" -> "0.006", "12.50" -> "12.5", "7.0" -> "7"; null stays null. Exact string work, no numbers. */
export function normalizeDecimal(text) {
  if (text === null || text === undefined) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) throw new Error(`not a plain decimal: ${text}`);
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/** Exact decimal string with at most 9 decimals -> Usd units (the display fixtures). */
export function usdFromDecimal(text, denominator) {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(text);
  if (match === null) throw new Error(`unsupported money fixture: ${text}`);
  const fraction = match[2] ?? "";
  const scaled = BigInt(match[1] + fraction);
  const divisor = 10n ** BigInt(fraction.length);
  const units = (scaled * denominator) / divisor;
  if (units * divisor !== scaled * denominator) throw new Error(`inexact money fixture: ${text}`);
  return { units };
}

const COUNTS = [
  ["input_tokens", "inputTokens"],
  ["output_tokens", "outputTokens"],
  ["cached_input_tokens", "cachedInputTokens"],
  ["cache_write_tokens", "cacheWriteTokens"],
];

export function toRequest(item) {
  const usage = {};
  for (const [key, property] of COUNTS) {
    const value = item.usage[key];
    if (value !== undefined && value !== null) usage[property] = BigInt(value);
  }
  return { provider: item.provider, model: item.model, ...(item.tier === undefined ? {} : { serviceTier: item.tier }), usage };
}

function costJson(pricing, cost) {
  if (cost === undefined) return null;
  return {
    status: cost.status,
    amount: cost.amount === undefined ? null : pricing.exactDecimal(cost.amount),
    notes: [...cost.notes],
  };
}

export function computeTs(pricing, denominator, cases, money) {
  const result = { version: pricing.PRICING_VERSION, sources: [...pricing.PRICING_SOURCES], cases: {}, money: {} };
  for (const item of cases) {
    const requests = item.records.map(toRequest);
    const total = pricing.totalCost(requests);
    result.cases[item.name] = {
      estimates: requests.map((request) => costJson(pricing, pricing.estimate(request))),
      total: costJson(pricing, total),
      short: pricing.formatCostShort(total),
      describe: pricing.describeCost(total),
    };
  }
  for (const text of money) result.money[text] = pricing.formatMoney(usdFromDecimal(text, denominator));
  return result;
}

function sameCost(a, b) {
  if (a === null || b === null) return a === b;
  return (
    a.status === b.status &&
    normalizeDecimal(a.amount) === normalizeDecimal(b.amount) &&
    a.notes.length === b.notes.length &&
    a.notes.every((note, index) => note === b.notes[index])
  );
}

/** Differences between the TS and Python results (empty = identical). */
export function compare(ts, py) {
  const problems = [];
  if (ts.version !== py.version) problems.push(`catalog version: TS ${ts.version}, Python ${py.version}`);
  if (JSON.stringify(ts.sources) !== JSON.stringify(py.sources)) problems.push("catalog sources differ");
  for (const [name, expected] of Object.entries(py.cases)) {
    const actual = ts.cases[name];
    if (actual === undefined) {
      problems.push(`${name}: missing in TS`);
      continue;
    }
    if (actual.estimates.length !== expected.estimates.length) problems.push(`${name}: estimate count`);
    expected.estimates.forEach((item, index) => {
      if (!sameCost(actual.estimates[index] ?? null, item)) {
        problems.push(`${name}[${String(index)}]: TS ${JSON.stringify(actual.estimates[index])} vs Python ${JSON.stringify(item)}`);
      }
    });
    if (!sameCost(actual.total, expected.total)) problems.push(`${name}: total TS ${JSON.stringify(actual.total)} vs Python ${JSON.stringify(expected.total)}`);
    if (actual.short !== expected.short) problems.push(`${name}: short TS ${actual.short} vs Python ${expected.short}`);
    if (actual.describe !== expected.describe) problems.push(`${name}: describe TS ${actual.describe} vs Python ${expected.describe}`);
  }
  for (const [text, expected] of Object.entries(py.money)) {
    if (ts.money[text] !== expected) problems.push(`money ${text}: TS ${String(ts.money[text])} vs Python ${expected}`);
  }
  for (const name of Object.keys(ts.cases)) if (py.cases[name] === undefined) problems.push(`${name}: missing in Python`);
  return problems;
}

/** A copy whose first known amount is one unit too large: the comparison must notice. */
export function corrupt(result) {
  const copy = JSON.parse(JSON.stringify(result));
  for (const item of Object.values(copy.cases)) {
    const target = item.estimates.find((estimate) => estimate !== null && estimate.amount !== null);
    if (target !== undefined) {
      const text = normalizeDecimal(target.amount);
      target.amount = `${text}${text.includes(".") ? "" : "."}0000000001`;
      return copy;
    }
  }
  throw new Error("no amount to corrupt");
}
