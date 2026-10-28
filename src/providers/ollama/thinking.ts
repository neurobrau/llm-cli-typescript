/**
 * Ollama reasoning ("thinking") support and the `think` wire value.
 *
 * Support is derived only from reported metadata, never from model names:
 * - capabilities confirmed without `thinking`: no reasoning choices;
 * - `thinking.values` from /api/show: booleans are off/on, strings are named levels;
 * - the `thinking` capability without values: legacy off/on;
 * - nothing reported: unknown (nothing is sent unless the user chose a value).
 * Docs mark `[false]` as "the model does not support thinking", so it gives no choices.
 */
import { ProviderError } from "../../domain/errors.js";
import type { ReasoningSupport } from "../../domain/settings.js";
import type { ShowInfo } from "./parse.js";

export function reasoningSupport(capabilities: readonly string[] | undefined, show: ShowInfo | undefined): ReasoningSupport {
  if (capabilities !== undefined && !capabilities.includes("thinking")) {
    return { known: true, values: [], allowsModelDefault: true };
  }
  let values = show?.thinkingValues ?? [];
  if (values.length === 1 && values[0] === "off") {
    return { known: true, values: [], allowsModelDefault: true };
  }
  if (values.length === 0 && capabilities?.includes("thinking") === true) {
    values = ["off", "on"]; // legacy: the generic boolean `think`
  }
  if (values.length === 0) {
    return { known: false, values: [], allowsModelDefault: true };
  }
  const off = values.includes("off");
  return {
    known: true,
    values,
    // Off/on models keep the project policy: no selectable "model default".
    allowsModelDefault: !off,
    ...(off ? { defaultValue: "off" } : {}),
    ...(show?.thinkingDefault === undefined ? {} : { modelDefault: show.thinkingDefault }),
  };
}

/**
 * Maps the resolved effort to the `think` field: off/none→false, on→true, a
 * named level→that string, no effort→omitted (undefined). A confirmed
 * non-thinking model gets no field. A value outside confirmed support is an
 * error if the user chose it, otherwise it is omitted.
 */
export function thinkField(
  effort: string | undefined,
  explicit: boolean,
  support: ReasoningSupport,
  model: string,
): boolean | string | undefined {
  if (effort === undefined || (support.known && support.values.length === 0)) {
    return undefined;
  }
  const wire = effort === "off" || effort === "none" ? false : effort === "on" ? true : effort;
  if (!support.known) {
    return wire;
  }
  const label = wire === false ? "off" : wire === true ? "on" : wire;
  if (support.values.includes(label)) {
    return wire;
  }
  if (!explicit) {
    return undefined;
  }
  throw new ProviderError(
    `${model} does not support thinking level '${effort}'. Supported: ${support.values.join(", ")}.`,
    "api",
  );
}
