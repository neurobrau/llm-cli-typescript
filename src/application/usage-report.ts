/**
 * Token-only conversation usage report (no prices; cost estimates are not
 * implemented yet). Every count field is summed on its own with bigint over
 * the records that reported it; a missing count is "not reported", never zero,
 * and a sum over only some of the requests says so.
 */
import type { StoredUsageRecord } from "../storage/types.js";

type CountField = "inputTokens" | "outputTokens" | "totalTokens" | "cachedInputTokens" | "cacheWriteTokens" | "reasoningTokens";

const FIELDS: readonly (readonly [CountField, string])[] = [
  ["inputTokens", "Input tokens"],
  ["outputTokens", "Output tokens"],
  ["totalTokens", "Total tokens"],
  ["cachedInputTokens", "Cached input tokens (part of input)"],
  ["cacheWriteTokens", "Cache write tokens (part of input)"],
  ["reasoningTokens", "Reasoning tokens (part of output)"],
];

export const NO_COST_NOTE = "Cost estimates are not implemented yet.";

/** Base-10 with thousands separators, exact for any size. */
export function groupDigits(value: bigint): string {
  return value.toString(10).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function usageReport(records: readonly StoredUsageRecord[]): string {
  if (records.length === 0) {
    return `Token usage: no API requests in this conversation yet.\n${NO_COST_NOTE}`;
  }
  const completed = records.filter((record) => record.status === "completed").length;
  const incomplete = records.length - completed;
  const lines = [
    `Conversation usage (${String(records.length)} request(s): ${String(completed)} completed, ${String(incomplete)} incomplete; as reported by the API):`,
  ];
  for (const [field, label] of FIELDS) {
    lines.push(`  ${label}: ${describeSum(records, field)}`);
  }
  const latest = records.findLast((record) => record.status === "completed");
  const latestInput = latest?.usage.inputTokens;
  if (latestInput !== undefined) {
    lines.push(
      `Latest completed request input: ${groupDigits(latestInput)} tokens (the whole history is sent, and billed, with every request)`,
    );
  } else if (latest !== undefined) {
    lines.push("Latest completed request input: not reported");
  }
  if (incomplete > 0) {
    lines.push(`Includes ${String(incomplete)} incomplete answer(s): billed, but not saved as messages.`);
  }
  lines.push(NO_COST_NOTE);
  return lines.join("\n");
}

function describeSum(records: readonly StoredUsageRecord[], field: CountField): string {
  let sum = 0n;
  let reporting = 0;
  for (const record of records) {
    const count = record.usage[field];
    if (count !== undefined) {
      sum += count;
      reporting += 1;
    }
  }
  if (reporting === 0) {
    return "not reported";
  }
  if (reporting === records.length) {
    return groupDigits(sum);
  }
  return `${groupDigits(sum)} (reported subtotal: ${String(reporting)} of ${String(records.length)} requests reported this)`;
}
