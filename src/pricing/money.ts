/**
 * Exact USD amounts. An amount is a whole number of `1 / USD_DENOMINATOR`
 * dollars (bigint). The denominator is the least common multiple that makes
 * every catalog rate and tier factor an integer: rates have at most three
 * decimals per million tokens (1000), the per-million divisor is 1e6, and the
 * tier factors are halves (2).
 */

export const RATE_SCALE = 1_000n;
export const TOKENS_PER_RATE = 1_000_000n;
export const FACTOR_SCALE = 2n;
export const USD_DENOMINATOR = RATE_SCALE * TOKENS_PER_RATE * FACTOR_SCALE;

/** A known USD amount, exact and unrounded. */
export interface Usd {
  /** Dollars times `USD_DENOMINATOR`; never negative. */
  readonly units: bigint;
}

export const ZERO_USD: Usd = Object.freeze({ units: 0n });

export function addUsd(a: Usd, b: Usd): Usd {
  return Object.freeze({ units: a.units + b.units });
}

/** Parses a checked decimal such as "0.125" into thousandths; anything inexact throws. */
export function parseRate(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (match === null) {
    throw new RangeError(`not an exact rate with at most three decimals: ${text}`);
  }
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(3, "0");
  return BigInt(whole) * RATE_SCALE + BigInt(fraction);
}

/** The exact value as a decimal string without trailing zeros ("0.002165", "12", "0.0000000005"). */
export function exactDecimal(amount: Usd): string {
  // USD_DENOMINATOR = 2 * 10^9, so units / D = units * 5 / 10^10 exactly.
  const scaled = amount.units * 5n;
  const whole = scaled / 10_000_000_000n;
  const fraction = (scaled % 10_000_000_000n).toString(10).padStart(10, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString(10) : `${whole.toString(10)}.${fraction}`;
}

/**
 * Display form (pricing.py format_money): exact zero is "$0"; below one cent
 * six decimals, otherwise four, rounded HALF UP. The decimal places come from
 * the exact amount before rounding.
 */
export function formatMoney(amount: Usd): string {
  if (amount.units === 0n) {
    return "$0";
  }
  const cent = USD_DENOMINATOR / 100n;
  const places = amount.units < cent ? 6 : 4;
  const factor = 10n ** BigInt(places);
  const rounded = (amount.units * factor * 2n + USD_DENOMINATOR) / (2n * USD_DENOMINATOR);
  const digits = rounded.toString(10).padStart(places + 1, "0");
  return `$${digits.slice(0, -places)}.${digits.slice(-places)}`;
}
