/** Display forms of an estimate (pricing.py format_cost_short / describe_cost). Pure. */
import { PRICING_VERSION } from "./catalog.js";
import type { CostEstimate } from "./estimate.js";
import { formatMoney } from "./money.js";

/** Compact panel form: `-`, `$0 (local)`, `unavailable`, `$0.001234`, `~$…` qualified, `>=$…` partial. */
export function formatCostShort(cost: CostEstimate | undefined): string {
  if (cost === undefined) {
    return "-";
  }
  if (cost.status === "free_local") {
    return "$0 (local)";
  }
  if (cost.amount === undefined) {
    return "unavailable";
  }
  const prefix = cost.status === "qualified" ? "~" : cost.status === "partial" ? ">=" : "";
  return prefix + formatMoney(cost.amount);
}

/** One line for /usage, always labelled as an estimate. */
export function describeCost(cost: CostEstimate | undefined): string {
  if (cost === undefined) {
    return "Estimated cost: - (no requests yet)";
  }
  if (cost.status === "free_local") {
    return "API cost: $0 (local Ollama inference)";
  }
  if (cost.amount === undefined) {
    return `Estimated cost: unavailable (${cost.notes.join("; ")})`;
  }
  const label = cost.status === "qualified" ? "approximately " : cost.status === "partial" ? "at least " : "";
  const detail = cost.notes.length > 0 ? `; ${cost.notes.join("; ")}` : "";
  return `Estimated cost: ${label}${formatMoney(cost.amount)} (ESTIMATED, not a billed amount; pricing ${PRICING_VERSION}${detail})`;
}
