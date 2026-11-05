/**
 * Validation of the custom max-output-tokens prompt. Pure. The digits are
 * checked and compared as `bigint`, so no value is ever rounded, exponential,
 * negative or fractional before it is accepted.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export type TokenInput = { readonly ok: true; readonly value: bigint } | { readonly ok: false; readonly message: string };

/**
 * `text` is the trimmed input; `limit` the model's known ceiling. The reference messages are used; the
 * numeric-range message (no smaller known limit, more than a safe integer) is specific to this edition.
 */
export function parseTokenInput(text: string, limit: number | undefined, model: string): TokenInput {
  if (text === "") return { ok: false, message: "Enter a positive whole number. Try again or press Esc." };
  if (!/^[0-9]+$/u.test(text)) return { ok: false, message: `'${text}' is not a positive whole number. Try again or press Esc.` };
  const value = BigInt(text);
  if (value === 0n) return { ok: false, message: "Max output tokens must be a positive whole number, not 0. Try again or press Esc." };
  if (limit !== undefined && value > BigInt(limit)) {
    return { ok: false, message: `${value.toString(10)} exceeds the limit of ${String(limit)} output tokens for ${model}. Try again or press Esc.` };
  }
  if (value > MAX_SAFE) {
    return {
      ok: false,
      message: `${value.toString(10)} is more than the largest supported number of ${MAX_SAFE.toString(10)} output tokens. Try again or press Esc.`,
    };
  }
  return { ok: true, value };
}
