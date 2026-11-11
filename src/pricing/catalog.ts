/**
 * The dated REFERENCE price catalog (Python pricing.py / Go pricing.go).
 *
 * This is a compatibility snapshot dated 2026-10-22, not a statement about
 * current OpenAI rates; nothing here fetches or refreshes prices. Rates are
 * USD per 1,000,000 tokens, stored as exact thousandths.
 */
import { FACTOR_SCALE, parseRate } from "./money.js";

export const PRICING_VERSION = "2026-10-22";
export const PRICING_SOURCES: readonly string[] = Object.freeze([
  "https://developers.openai.com/api/docs/pricing",
  "https://developers.openai.com/api/docs/models/gpt-6-luna",
  "https://developers.openai.com/api/docs/models/gpt-5.1",
  "https://developers.openai.com/api/docs/guides/prompt-caching",
]);

/** USD per million tokens in thousandths of a dollar. */
export interface Rates {
  readonly input: bigint;
  readonly cachedInput: bigint;
  readonly output: bigint;
  /** Absent: cache writes are billed as ordinary input. */
  readonly cacheWrite?: bigint;
}

export interface ModelPricing {
  readonly standard: Rates;
  readonly longContext?: Rates;
  /** Reported input tokens of one request; strictly above it the long-context rates apply. */
  readonly longContextThreshold?: bigint;
  /** Tier name to factor in halves (`FACTOR_SCALE` = 1x). */
  readonly tiers: ReadonlyMap<string, bigint>;
}

function rates(input: string, cachedInput: string, output: string, cacheWrite?: string): Rates {
  return Object.freeze({
    input: parseRate(input),
    cachedInput: parseRate(cachedInput),
    output: parseRate(output),
    ...(cacheWrite === undefined ? {} : { cacheWrite: parseRate(cacheWrite) }),
  });
}

const ONE = FACTOR_SCALE;
const HALF = FACTOR_SCALE / 2n;
const TWICE = FACTOR_SCALE * 2n;

/** Exact-name lookup only (a Map: no inherited keys such as "constructor"). */
const CATALOG: ReadonlyMap<string, ModelPricing> = new Map<string, ModelPricing>([
  [
    "gpt-6-luna",
    Object.freeze({
      standard: rates("0.10", "0.01", "0.50", "0.125"),
      longContext: rates("0.20", "0.02", "0.75", "0.25"),
      longContextThreshold: 272_000n,
      tiers: new Map<string, bigint>([
        ["default", ONE],
        ["flex", HALF],
        ["batch", HALF],
        ["fast", TWICE],
        ["priority", TWICE], // "priority" was renamed "fast" in the reference
      ]),
    }),
  ],
  [
    "gpt-5.1",
    Object.freeze({
      standard: rates("1.25", "0.125", "10.00"),
      tiers: new Map<string, bigint>([["default", ONE]]),
    }),
  ],
]);

const SNAPSHOT_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

/** Exact model, else the exact base of one anchored `-YYYY-MM-DD` suffix; never a prefix or family guess. */
export function pricingFor(model: string): ModelPricing | undefined {
  return CATALOG.get(model) ?? CATALOG.get(model.replace(SNAPSHOT_SUFFIX, ""));
}

/** Catalog model names (for tests and documentation). */
export function catalogModels(): readonly string[] {
  return [...CATALOG.keys()];
}
