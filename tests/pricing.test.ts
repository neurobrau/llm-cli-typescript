import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRICING_SOURCES,
  PRICING_VERSION,
  ZERO_USD,
  catalogModels,
  describeCost,
  estimate,
  exactDecimal,
  formatCostShort,
  formatMoney,
  isCloudName,
  pricingFor,
  totalCost,
} from "../src/pricing/index.js";
import type { CostEstimate, PricedRequest, Usd } from "../src/pricing/index.js";
import { USD_DENOMINATOR, parseRate } from "../src/pricing/money.js";

const LUNA = "gpt-6-luna";

function req(usage: PricedRequest["usage"], over: Partial<{ model: string; tier: string | undefined; provider: string }> = {}): PricedRequest {
  const tier = "tier" in over ? over.tier : "default";
  return { provider: over.provider ?? "openai", model: over.model ?? LUNA, ...(tier === undefined ? {} : { serviceTier: tier }), usage };
}
const full = (input: bigint, output: bigint, cached = 0n, writes = 0n) => ({ inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteTokens: writes });
const amountOf = (cost: CostEstimate | undefined): string => {
  assert.ok(cost?.amount !== undefined, "amount expected");
  return exactDecimal(cost.amount);
};
const unitsOf = (cost: CostEstimate | undefined): bigint | undefined => cost?.amount?.units;
const amountOrZero = (cost: CostEstimate | undefined): Usd => cost?.amount ?? ZERO_USD;
const usd = (units: bigint): Usd => ({ units });
/** Exact decimal string (at most 9 decimals) as Usd. */
const dollars = (text: string): Usd => {
  const [whole = "0", fraction = ""] = text.split(".");
  const scaled = BigInt(whole + fraction);
  return usd((scaled * USD_DENOMINATOR) / 10n ** BigInt(fraction.length));
};

void describe("catalog", () => {
  void it("is the dated reference snapshot with its provenance", () => {
    assert.equal(PRICING_VERSION, "2026-10-22");
    assert.deepEqual(PRICING_SOURCES, [
      "https://developers.openai.com/api/docs/pricing",
      "https://developers.openai.com/api/docs/models/gpt-6-luna",
      "https://developers.openai.com/api/docs/models/gpt-5.1",
      "https://developers.openai.com/api/docs/guides/prompt-caching",
    ]);
    assert.deepEqual(catalogModels(), ["gpt-6-luna", "gpt-5.1"]);
  });

  void it("holds the exact rates per million tokens in thousandths", () => {
    const luna = pricingFor(LUNA);
    assert.deepEqual(luna?.standard, { input: 100n, cachedInput: 10n, output: 500n, cacheWrite: 125n });
    assert.deepEqual(pricingFor(LUNA)?.longContext, { input: 200n, cachedInput: 20n, output: 750n, cacheWrite: 250n });
    assert.equal(pricingFor(LUNA)?.longContextThreshold, 272_000n);
    assert.deepEqual(pricingFor("gpt-5.1")?.standard, { input: 1250n, cachedInput: 125n, output: 10000n });
    assert.equal(pricingFor("gpt-5.1")?.longContext, undefined);
    assert.deepEqual([...(pricingFor("gpt-5.1")?.tiers ?? [])], [["default", 2n]]);
  });

  void it("looks models up exactly, with one anchored dated-snapshot fallback", () => {
    assert.equal(pricingFor("gpt-6-luna-2026-09-01"), pricingFor(LUNA));
    for (const name of ["GPT-6-LUNA", "gpt-6", "gpt-6-luna-preview", "gpt-6-luna-2026-9-01", "gpt-6-luna-2026-09-01x", "gpt-6-luna-2026-09-01\n", "ft:gpt-6-luna:org", "constructor", "__proto__", "toString", ""]) {
      assert.equal(pricingFor(name), undefined, name);
    }
    // Only one suffix is removed.
    assert.equal(pricingFor("gpt-6-luna-2026-09-01-2026-09-01"), undefined);
  });

  void it("parses only exact rates", () => {
    assert.equal(parseRate("0.125"), 125n);
    assert.equal(parseRate("10.00"), 10000n);
    for (const bad of ["0.1255", "1e3", "-1", ".5", "", "1,5", "0.1 "]) assert.throws(() => parseRate(bad), RangeError, bad);
  });
});

void describe("estimate", () => {
  void it("prices the documented standard example exactly", () => {
    const cost = estimate(req(full(15_000n, 2_000n, 4_000n, 1_000n)));
    assert.equal(cost.status, "estimated");
    assert.equal(amountOf(cost), "0.002165");
    assert.deepEqual(cost.notes, []);
  });

  void it("does not add reasoning tokens again and ignores totalTokens", () => {
    const base = estimate(req(full(1_000n, 2_000n)));
    assert.equal(amountOf(base), "0.0011");
    assert.equal(amountOf(estimate(req({ ...full(1_000n, 2_000n), reasoningTokens: 1_500n }))), "0.0011");
    assert.equal(amountOf(estimate(req({ ...full(1_000n, 2_000n), totalTokens: 7n }))), "0.0011");
    assert.equal(amountOf(estimate(req({ ...full(1_000n, 2_000n), totalTokens: 10n ** 30n }))), "0.0011");
    // totalTokens alone never replaces input/output.
    assert.equal(estimate(req({ totalTokens: 3_000n })).status, "unavailable");
  });

  void it("switches to long-context rates only for a reported input above 272000, for the whole request", () => {
    assert.equal(amountOf(estimate(req(full(272_000n, 1_000n)))), "0.0277");
    assert.equal(amountOf(estimate(req(full(272_001n, 1_000n)))), "0.0551502"); // 272001*0.20 + 1000*0.75 per 1M
    // cache-heavy: the threshold uses reported input, before subtracting cache components
    assert.equal(amountOf(estimate(req(full(272_001n, 0n, 272_001n)))), "0.00544002");
    assert.equal(amountOf(estimate(req(full(272_000n, 0n, 272_000n)))), "0.00272");
    // two requests of 200000 do not sum into a long-context tier
    const total = totalCost([req(full(200_000n, 0n)), req(full(200_000n, 0n))]);
    assert.equal(amountOf(total), "0.04");
  });

  void it("applies every Luna tier factor, including the priority alias", () => {
    const base = 100_000n * 100n + 10_000n * 500n; // thousandths x tokens
    const unit = (factor: bigint): string => exactDecimal(usd(base * factor));
    for (const [tier, factor] of [["default", 2n], ["flex", 1n], ["batch", 1n], ["fast", 4n], ["priority", 4n]] as const) {
      const cost = estimate(req(full(100_000n, 10_000n), { tier }));
      assert.equal(amountOf(cost), unit(factor), tier);
      assert.equal(cost.status, "estimated");
    }
  });

  void it("treats an absent or auto tier as a qualified standard tier, and empty or unknown tiers as unavailable", () => {
    for (const tier of [undefined, "auto"]) {
      const cost = estimate(req(full(1_000n, 1_000n), { tier }));
      assert.equal(cost.status, "qualified");
      assert.equal(amountOf(cost), "0.0006");
      assert.deepEqual(cost.notes, ["Standard tier assumed (tier not reported)"]);
    }
    for (const tier of ["", "ultrafast", "Default", "FLEX"]) {
      const cost = estimate(req(full(1n, 1n), { tier }));
      assert.equal(cost.status, "unavailable", JSON.stringify(tier));
      assert.equal(cost.amount, undefined);
      assert.deepEqual(cost.notes, [`no pricing for the ${tier} tier of ${LUNA}`]);
    }
    assert.equal(estimate(req(full(1n, 1n), { model: "gpt-5.1", tier: "flex" })).status, "unavailable");
    assert.equal(estimate(req(full(1n, 1n), { model: "gpt-5.1", tier: "priority" })).status, "unavailable");
    assert.equal(estimate(req(full(1n, 1n), { model: "gpt-5.1", tier: "default" })).status, "estimated");
  });

  void it("is unavailable when input or output was not reported", () => {
    for (const usage of [{ outputTokens: 5n }, { inputTokens: 10n }, {}]) {
      const cost = estimate(req(usage));
      assert.equal(cost.status, "unavailable");
      assert.deepEqual(cost.notes, ["token usage was not reported"]);
    }
  });

  void it("qualifies missing cache counts but not reported zeros, in the reference note order", () => {
    const both = estimate(req({ inputTokens: 10_000n, outputTokens: 1_000n }, { tier: undefined }));
    assert.equal(both.status, "qualified");
    assert.deepEqual(both.notes, [
      "Standard tier assumed (tier not reported)",
      "cached tokens not reported (all input priced as uncached)",
      "cache writes not reported (priced as ordinary input)",
    ]);
    assert.equal(amountOf(both), "0.0015");
    assert.deepEqual(estimate(req({ inputTokens: 1n, outputTokens: 1n, cachedInputTokens: 0n })).notes, ["cache writes not reported (priced as ordinary input)"]);
    assert.deepEqual(estimate(req({ inputTokens: 1n, outputTokens: 1n, cacheWriteTokens: 0n })).notes, ["cached tokens not reported (all input priced as uncached)"]);
    assert.deepEqual(estimate(req(full(1n, 1n))).notes, []);
    // a model without a special write rate needs no write qualification
    assert.deepEqual(estimate(req({ inputTokens: 1n, outputTokens: 1n, cachedInputTokens: 0n }, { model: "gpt-5.1" })).notes, []);
    assert.equal(estimate(req({ inputTokens: 1n, outputTokens: 1n, cachedInputTokens: 0n }, { model: "gpt-5.1" })).status, "estimated");
  });

  void it("does not mutate its input, and assumptions never fill the usage record", () => {
    const usage = Object.freeze({ inputTokens: 10n, outputTokens: 1n });
    const request = Object.freeze({ provider: "openai", model: LUNA, usage });
    estimate(request);
    totalCost([request, request]);
    assert.deepEqual(Object.keys(usage), ["inputTokens", "outputTokens"]);
    assert.deepEqual(Object.keys(request), ["provider", "model", "usage"]);
  });

  void it("bills cache writes as ordinary input on GPT-5.1 and replaces, not adds, on Luna", () => {
    const five = estimate(req(full(10_000n, 0n, 2_000n, 3_000n), { model: "gpt-5.1" }));
    assert.equal(amountOf(five), "0.01025"); // (5000 + 3000)*1.25 + 2000*0.125 per 1M
    assert.equal(five.status, "estimated");
    const luna = estimate(req(full(10_000n, 0n, 0n, 10_000n)));
    assert.equal(amountOf(luna), "0.00125"); // all input at the write rate, nothing added
  });

  void it("rejects cached + writes above input without a negative amount, at any size", () => {
    for (const [i, c, w] of [[10n, 8n, 5n], [10n, 11n, 0n], [10n, 0n, 11n], [2n ** 64n, 2n ** 64n, 1n], [10n, 2n ** 70n, 2n ** 70n]] as const) {
      const cost = estimate(req({ inputTokens: i, outputTokens: 1n, cachedInputTokens: c, cacheWriteTokens: w }));
      assert.equal(cost.status, "unavailable");
      assert.equal(cost.amount, undefined);
      assert.deepEqual(cost.notes, ["inconsistent usage (cached + writes > input)"]);
    }
    assert.equal(estimate(req({ inputTokens: 13n, outputTokens: 1n, cachedInputTokens: 8n, cacheWriteTokens: 5n })).status, "estimated");
  });

  void it("is exact beyond 2^53, the signed 64-bit limit and 2^70", () => {
    const big = 2n ** 70n + 5n;
    // (big*100 + big*500) / 1e9 USD  (default tier, long context: big*200 + big*750)
    const cost = estimate(req(full(big, big)));
    assert.equal(cost.status, "estimated");
    assert.equal(cost.amount?.units, (big * 200n + big * 750n) * 2n);
    const edge = 9_223_372_036_854_775_807n;
    assert.equal(estimate(req(full(edge, edge))).amount?.units, (edge * 200n + edge * 750n) * 2n);
    const safe = 9_007_199_254_740_993n;
    assert.equal(estimate(req(full(safe, 0n))).amount?.units, safe * 200n * 2n);
    // a sum of huge amounts stays exact
    const total = totalCost([req(full(big, 1n)), req(full(big + 2n, 3n))]);
    assert.equal(total?.amount?.units, ((big * 200n + 750n) + ((big + 2n) * 200n + 3n * 750n)) * 2n);
  });

  void it("treats Ollama locally as free API cost and cloud tags as unavailable, never free", () => {
    for (const usage of [{}, full(10n, 10n)]) {
      const local = estimate(req(usage, { provider: "ollama", model: "qwen3.5:4b", tier: undefined }));
      assert.equal(local.status, "free_local");
      assert.equal(local.amount?.units, 0n);
    }
    for (const model of ["glm-4.7:cloud", "gemma4:31b-cloud", "x:cloud", "a:b:c-cloud"]) {
      const cost = estimate(req(full(1n, 1n), { provider: "ollama", model }));
      assert.equal(cost.status, "unavailable", model);
      assert.deepEqual(cost.notes, [`${model} is an Ollama cloud model`]);
    }
    assert.equal(isCloudName("cloud"), true); // no colon: the whole name is the tag, as in the reference
    for (const model of ["cloud:7b", "x:mycloud", "x:cloud-x", "x:Cloud"]) assert.equal(isCloudName(model), false, model);
    const unknown = estimate(req(full(1n, 1n), { provider: "acme" }));
    assert.equal(unknown.status, "unavailable");
    assert.deepEqual(unknown.notes, ["no pricing for provider acme"]);
    assert.deepEqual(estimate(req(full(1n, 1n), { model: "gpt-4o" })).notes, ["no pricing data for gpt-4o"]);
  });

  void it("returns frozen results", () => {
    const cost = estimate(req(full(1n, 1n)));
    assert.ok(Object.isFrozen(cost) && Object.isFrozen(cost.notes) && Object.isFrozen(cost.amount));
    assert.throws(() => { (cost.notes as string[]).push("x"); });
  });
});

void describe("totalCost", () => {
  const ok = req(full(1_000n, 1_000n));
  const unknown = req(full(1n, 1n), { model: "unknown-model" });
  const local = req({}, { provider: "ollama", model: "a", tier: undefined });

  void it("has no estimate without requests and is free only when every request is local", () => {
    assert.equal(totalCost([]), undefined);
    const all = totalCost([local, local]);
    assert.equal(all?.status, "free_local");
    assert.equal(unitsOf(all), 0n);
  });

  void it("sums known amounts and keeps the status rules", () => {
    assert.equal(totalCost([ok, req(full(2_000n, 1_000n))])?.status, "estimated");
    assert.equal(amountOf(totalCost([ok, req(full(2_000n, 1_000n))])), "0.0013");
    assert.equal(totalCost([ok, req(full(1_000n, 1_000n), { tier: undefined })])?.status, "qualified");
    assert.equal(totalCost([local, ok])?.status, "estimated");
    const partial = totalCost([ok, unknown]);
    assert.equal(partial?.status, "partial");
    assert.equal(amountOf(partial), "0.0006");
    const unavailable = totalCost([unknown, req({ inputTokens: 1n })]);
    assert.equal(unavailable?.status, "unavailable");
    assert.equal(unitsOf(unavailable), undefined);
  });

  void it("keeps a known zero distinct from a missing amount", () => {
    const partial = totalCost([local, unknown]);
    assert.equal(partial?.status, "partial");
    assert.equal(unitsOf(partial), 0n);
    assert.equal(formatCostShort(partial), ">=$0");
    assert.equal(totalCost([unknown])?.amount, undefined);
    assert.equal(estimate(req(full(0n, 0n))).amount?.units, 0n);
  });

  void it("deduplicates notes in first-seen order across requests", () => {
    const a = req({ inputTokens: 10n, outputTokens: 1n }); // cached + writes missing
    const b = req(full(10n, 1n), { tier: undefined }); // tier
    const c = req({ inputTokens: 5n, outputTokens: 1n, cachedInputTokens: 0n }, { tier: undefined }); // tier + writes
    const total = totalCost([a, b, c, unknown]);
    assert.deepEqual(total?.notes, [
      "cached tokens not reported (all input priced as uncached)",
      "cache writes not reported (priced as ordinary input)",
      "Standard tier assumed (tier not reported)",
      "no pricing data for unknown-model",
    ]);
  });

  void it("sums unrounded amounts, not displayed per-request prices", () => {
    const tiny = req(full(1n, 0n), { tier: "flex" }); // 0.00000005 USD
    assert.equal(estimate(tiny).amount?.units, 100n);
    assert.equal(formatMoney(estimate(tiny).amount ?? ZERO_USD), "$0.000000");
    const many: CostEstimate | undefined = totalCost(Array.from({ length: 100_000 }, () => tiny));
    assert.equal(many?.amount?.units, 100n * 100_000n);
    assert.equal(formatMoney(amountOrZero(many)), "$0.005000");
  });

  void it("does not alias or mutate its input array", () => {
    const requests = Object.freeze([ok, ok]);
    const total = totalCost(requests);
    assert.equal(requests.length, 2);
    assert.notEqual(total?.notes, undefined);
  });
});

void describe("formatting", () => {
  void it("formats money like the reference", () => {
    const cases: readonly [string, string][] = [
      ["0", "$0"], ["0.0000004", "$0.000000"], ["0.000165", "$0.000165"], ["0.0021654", "$0.002165"], ["0.01", "$0.0100"], ["12.345678", "$12.3457"],
    ];
    for (const [amount, text] of cases) assert.equal(formatMoney(dollars(amount)), text, amount);
  });

  void it("rounds half up, decides places before rounding, and carries", () => {
    const cases: readonly [string, string][] = [
      ["0.0000005", "$0.000001"], ["0.0000015", "$0.000002"], ["0.0000004999", "$0.000000"], ["0.0099995", "$0.010000"], ["0.0099994", "$0.009999"],
      ["0.00999999", "$0.010000"], ["0.01004999", "$0.0100"], ["0.01005", "$0.0101"], ["0.99995", "$1.0000"], ["0.99994", "$0.9999"],
      ["12.34555", "$12.3456"], ["12.34565", "$12.3457"], ["99999.99995", "$100000.0000"], ["100000000.5", "$100000000.5000"],
      ["123456789012345678901234567890.12345", "$123456789012345678901234567890.1235"],
    ];
    for (const [amount, text] of cases) assert.equal(formatMoney(dollars(amount)), text, amount);
    // a tiny positive amount never shows as the exact zero "$0"
    assert.equal(formatMoney(usd(1n)), "$0.000000");
    assert.ok(!/e|E|NaN|Infinity/.test(formatMoney(usd(10n ** 60n))));
    assert.equal(formatMoney(usd(10n ** 60n)), `$${(5n * 10n ** 50n).toString()}.0000`);
  });

  void it("prints short and long forms exactly like the reference", () => {
    const estimated = totalCost([req(full(15_000n, 2_000n, 4_000n, 1_000n))]);
    const qualified: CostEstimate = { status: "qualified", amount: dollars("0.0006"), notes: ["Standard tier assumed"] };
    const partial: CostEstimate = { status: "partial", amount: dollars("0.0006"), notes: ["no pricing data for x"] };
    const localCost: CostEstimate = { status: "free_local", amount: ZERO_USD, notes: [] };
    const none: CostEstimate = { status: "unavailable", notes: ["no pricing data for x"] };
    assert.equal(formatCostShort(estimated), "$0.002165");
    assert.equal(formatCostShort(qualified), "~$0.000600");
    assert.equal(formatCostShort(partial), ">=$0.000600");
    assert.equal(formatCostShort(localCost), "$0 (local)");
    assert.equal(formatCostShort(none), "unavailable");
    assert.equal(formatCostShort(undefined), "-");
    assert.equal(describeCost(estimated), "Estimated cost: $0.002165 (ESTIMATED, not a billed amount; pricing 2026-10-22)");
    assert.equal(describeCost(qualified), "Estimated cost: approximately $0.000600 (ESTIMATED, not a billed amount; pricing 2026-10-22; Standard tier assumed)");
    assert.equal(describeCost(partial), "Estimated cost: at least $0.000600 (ESTIMATED, not a billed amount; pricing 2026-10-22; no pricing data for x)");
    assert.equal(describeCost(localCost), "API cost: $0 (local Ollama inference)");
    assert.equal(describeCost(none), "Estimated cost: unavailable (no pricing data for x)");
    assert.equal(describeCost(undefined), "Estimated cost: - (no requests yet)");
  });

  void it("prints exact decimals without exponent or rounding", () => {
    assert.equal(exactDecimal(usd(0n)), "0");
    assert.equal(exactDecimal(usd(1n)), "0.0000000005");
    assert.equal(exactDecimal(usd(USD_DENOMINATOR)), "1");
    assert.equal(exactDecimal(usd(USD_DENOMINATOR * 12n + USD_DENOMINATOR / 2n)), "12.5");
  });
});
