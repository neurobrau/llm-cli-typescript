/**
 * The LLM SETTINGS panel rows (docs/tui-spec.md section 4a). Pure.
 *
 * Token figures are exact bigint sums of the usage records; abbreviation uses
 * integer arithmetic only, never `Number(bigint)`.
 */
import { formatCostShort, totalCost } from "../pricing/index.js";
import type { ResolvedSettings } from "../domain/settings.js";
import type { StoredUsageRecord } from "../storage/types.js";
import { PANEL_CONTENT_WIDTH } from "./layout.js";
import { fit } from "./text.js";

export type PanelStyle = "border" | "text";

export interface PanelRow {
  readonly text: string;
  readonly style: PanelStyle;
}

export interface PanelStats {
  readonly input: bigint | undefined;
  readonly output: bigint | undefined;
  readonly total: bigint | undefined;
  readonly cached: bigint | undefined;
  readonly reasoning: bigint | undefined;
  /** Input tokens of the latest completed request. */
  readonly context: bigint | undefined;
  /** Short estimated cost of these records (`-` when there are none); computed with the counts, not per frame. */
  readonly cost: string;
  readonly any: boolean;
}

type CountField = "inputTokens" | "outputTokens" | "totalTokens" | "cachedInputTokens" | "reasoningTokens";

function sum(records: readonly StoredUsageRecord[], field: CountField): bigint | undefined {
  let total: bigint | undefined;
  for (const record of records) {
    const count = record.usage[field];
    if (count !== undefined) total = (total ?? 0n) + count;
  }
  return total;
}

/** Conversation totals; a count no request reported stays `undefined` (shown as `?`). */
export function panelStats(records: readonly StoredUsageRecord[]): PanelStats {
  return {
    input: sum(records, "inputTokens"),
    output: sum(records, "outputTokens"),
    total: sum(records, "totalTokens"),
    cached: sum(records, "cachedInputTokens"),
    reasoning: sum(records, "reasoningTokens"),
    context: records.findLast((record) => record.status === "completed")?.usage.inputTokens,
    cost: formatCostShort(totalCost(records)),
    any: records.length > 0,
  };
}

const UNITS: readonly (readonly [bigint, string])[] = [
  [1_000_000_000n, "G"],
  [1_000_000n, "M"],
  [1_000n, "k"],
];

/** `value / unit` to three significant digits, rounded half up; `undefined` when it rounds to 1000. */
function scaled(value: bigint, unit: bigint): string | undefined {
  const whole = value / unit;
  const decimals = whole >= 100n ? 0 : whole >= 10n ? 1 : 2;
  const factor = 10n ** BigInt(decimals);
  const rounded = (value * factor * 2n + unit) / (2n * unit);
  if (rounded >= 1000n * factor) return undefined;
  const text = rounded.toString(10).padStart(decimals + 1, "0");
  if (decimals === 0) return text;
  const trimmed = `${text.slice(0, -decimals)}.${text.slice(-decimals)}`.replace(/\.?0+$/, "");
  return trimmed;
}

/** Token count for the narrow panel: `?`, 9999, 12.3k, 4.56M, 2G (only used when needed). */
export function compact(count: bigint | undefined): string {
  if (count === undefined) return "?";
  if (count < 10_000n) return count.toString(10);
  for (const [index, [unit, suffix]] of UNITS.entries()) {
    if (count < unit) continue;
    const text = scaled(count, unit);
    if (text !== undefined) return `${text}${suffix}`;
    const larger = UNITS[index - 1];
    if (larger !== undefined) return `${scaled(count, larger[0]) ?? "1000"}${larger[1]}`;
    return `${((count + unit / 2n) / unit).toString(10)}${suffix}`; // beyond 999G: whole units, clipped by the panel
  }
  return count.toString(10);
}

const exact = (count: bigint | undefined): string => (count === undefined ? "?" : count.toString(10));

export function providerLabel(settings: ResolvedSettings): string {
  return settings.provider === "openai" ? "OpenAI" : "Ollama";
}

/** Rows from the top of the panel; rows beyond the panel height are the caller's to drop. */
export function settingsPanelRows(settings: ResolvedSettings, stats: PanelStats): PanelRow[] {
  const width = PANEL_CONTENT_WIDTH;
  const value = (text: string): PanelRow => ({ text: fit(` ${text}`, width), style: "text" });
  const heading = (text: string): PanelRow => ({ text, style: "border" });
  const counts = (full: string, short: string): PanelRow => value(full.length + 1 <= width ? full : short);
  const limit = settings.maxOutputTokens.value;
  const rows: PanelRow[] = [
    heading("F2 MODEL"),
    value(settings.model),
    heading("F3 PROVIDER"),
    value(providerLabel(settings)),
    heading("F4 REASONING"),
    value(settings.reasoning.effort ?? "model default"),
    heading("F5 MAX TOKENS"),
    value(limit === undefined ? "default" : String(limit)),
    heading("F6 ANSWER STYLE"),
    value(settings.answerStyle.value),
    heading("TOKENS"),
  ];
  if (!stats.any) {
    rows.push(value("-"));
  } else {
    rows.push(
      counts(`in ${exact(stats.input)} out ${exact(stats.output)}`, `in ${compact(stats.input)} out ${compact(stats.output)}`),
      counts(`total ${exact(stats.total)}`, `total ${compact(stats.total)}`),
    );
    if (stats.cached !== undefined && stats.cached > 0n) rows.push(value(`cached ${compact(stats.cached)}`));
    if (stats.reasoning !== undefined && stats.reasoning > 0n) rows.push(value(`reasoning ${compact(stats.reasoning)}`));
  }
  if (stats.context !== undefined) rows.push(value(`context ${compact(stats.context)}`));
  rows.push(heading("COST (EST.)"), value(stats.cost));
  return rows;
}
