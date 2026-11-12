/**
 * Pure per-request and per-conversation cost estimation (pricing.py
 * estimate/total_cost). Only reported counts are used; missing information
 * is a qualified assumption or "unavailable", never a guess. No input is
 * mutated and results are frozen.
 */
import type { TokenUsage } from "../domain/generation.js";
import { pricingFor, tierFactor } from "./catalog.js";
import { FACTOR_SCALE, ZERO_USD, addUsd } from "./money.js";
import type { Usd } from "./money.js";

export type CostStatus = "estimated" | "qualified" | "partial" | "unavailable" | "free_local";

export interface CostEstimate {
  readonly status: CostStatus;
  /** Absent only for "unavailable"; zero is a known amount. */
  readonly amount?: Usd;
  readonly notes: readonly string[];
}

/** The reported counts one request needs; a stored usage record satisfies it. */
export interface PricedRequest {
  readonly provider: string;
  readonly model: string;
  readonly serviceTier?: string;
  readonly usage: TokenUsage;
}

function make(status: CostStatus, amount: Usd | undefined, notes: readonly string[]): CostEstimate {
  return Object.freeze({
    status,
    ...(amount === undefined ? {} : { amount }),
    notes: Object.freeze([...notes]),
  });
}

const unavailable = (note: string): CostEstimate => make("unavailable", undefined, [note]);

/**
 * Ollama cloud tags (`glm-4.7:cloud`, `gemma4:31b-cloud`): the tag after the
 * last colon is `cloud` or ends in `-cloud` (Python is_cloud_name; a pure copy
 * so pricing does not import the Ollama adapter).
 */
export function isCloudName(model: string): boolean {
  const tag = model.slice(model.lastIndexOf(":") + 1);
  return tag === "cloud" || tag.endsWith("-cloud");
}

/** Estimated cost of one request, in the reference's order of decisions and notes. */
export function estimate(request: PricedRequest): CostEstimate {
  const { provider, model } = request;
  if (provider === "ollama") {
    if (isCloudName(model)) {
      return unavailable(`${model} is an Ollama cloud model`);
    }
    return make("free_local", ZERO_USD, []);
  }
  if (provider !== "openai") {
    return unavailable(`no pricing for provider ${provider}`);
  }
  const pricing = pricingFor(model);
  if (pricing === undefined) {
    return unavailable(`no pricing data for ${model}`);
  }
  const { inputTokens, outputTokens } = request.usage;
  if (inputTokens === undefined || outputTokens === undefined) {
    return unavailable("token usage was not reported");
  }

  const notes: string[] = [];
  const tier = request.serviceTier;
  let factor: bigint;
  if (tier === undefined || tier === "auto") {
    factor = FACTOR_SCALE;
    notes.push("Standard tier assumed (tier not reported)");
  } else {
    const known = tierFactor(pricing, tier);
    if (known === undefined) {
      return unavailable(`no pricing for the ${tier} tier of ${model}`);
    }
    factor = known;
  }

  const { longContext, longContextThreshold } = pricing;
  const rates =
    longContext !== undefined && longContextThreshold !== undefined && inputTokens > longContextThreshold
      ? longContext
      : pricing.standard;

  let cached = request.usage.cachedInputTokens;
  let writes = request.usage.cacheWriteTokens;
  if (cached === undefined) {
    notes.push("cached tokens not reported (all input priced as uncached)");
    cached = 0n;
  }
  if (writes === undefined) {
    if (rates.cacheWrite !== undefined) {
      notes.push("cache writes not reported (priced as ordinary input)");
    }
    writes = 0n;
  }
  const ordinary = inputTokens - cached - writes;
  if (ordinary < 0n) {
    return unavailable("inconsistent usage (cached + writes > input)");
  }
  const writeRate = rates.cacheWrite ?? rates.input;
  // Thousandths of a dollar per 1M tokens times tokens; the factor is in halves.
  const weighted = ordinary * rates.input + cached * rates.cachedInput + writes * writeRate + outputTokens * rates.output;
  // units = weighted/RATE_SCALE/1e6 * factor/FACTOR_SCALE USD, with the denominator RATE_SCALE*1e6*FACTOR_SCALE.
  const units = weighted * factor;
  return make(notes.length > 0 ? "qualified" : "estimated", Object.freeze({ units }), notes);
}

/** Combined estimate for a conversation; `undefined` when there are no requests. */
export function totalCost(requests: readonly PricedRequest[]): CostEstimate | undefined {
  if (requests.length === 0) {
    return undefined;
  }
  const estimates = requests.map(estimate);
  if (estimates.every((item) => item.status === "free_local")) {
    return make("free_local", ZERO_USD, []);
  }
  const notes = [...new Set(estimates.flatMap((item) => item.notes))];
  let amount: Usd | undefined;
  for (const item of estimates) {
    if (item.amount !== undefined) {
      amount = addUsd(amount ?? ZERO_USD, item.amount);
    }
  }
  if (amount === undefined) {
    return make("unavailable", undefined, notes);
  }
  if (estimates.some((item) => item.status === "unavailable")) {
    return make("partial", amount, notes);
  }
  return make(estimates.some((item) => item.status === "qualified") ? "qualified" : "estimated", amount, notes);
}

