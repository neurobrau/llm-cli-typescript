/**
 * The items of the five menus (docs/tui-spec.md sections 4b, 4c). Pure: they
 * take what the application already knows (models, capabilities, the resolved
 * choice) and produce `Menu` values; nothing is requested here.
 */
import { reasoningLabel } from "../application/resolve-settings.js";
import { PROVIDER_LABELS, PROVIDER_ORDER } from "../application/provider-hub.js";
import type { ProviderId, ReasoningChoice } from "../domain/generation.js";
import type { ModelInfo } from "../domain/provider.js";
import { ANSWER_STYLES } from "../domain/settings.js";
import type { AnswerStyle, MaxOutputTokensChoice, ModelCapabilities } from "../domain/settings.js";
import { Menu } from "./menu.js";
import type { MenuItem } from "./menu.js";

export const TOKEN_PRESETS: readonly number[] = [256, 512, 1024, 2048, 4096];

export const STYLE_NOTES: Readonly<Record<AnswerStyle, string>> = {
  brief: "short, concise answers",
  normal: "standard answers",
  detailed: "thorough, with examples",
};

export const MODEL_DEFAULT_ID = "model-default";
export const CUSTOM_ID = "custom";
const VALUE_PREFIX = "value:";

export function providerMenu(current: ProviderId): Menu | undefined {
  return Menu.create(
    "provider",
    "SELECT PROVIDER",
    PROVIDER_ORDER.map((id) => ({ id, label: PROVIDER_LABELS[id], current: id === current })),
  );
}

/** Selectable models only (a defensive filter on top of the provider's own), exact IDs, provider order, no duplicates. */
export function selectableModels(models: readonly ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const model of models) {
    if (model.remote) continue;
    if (model.capabilities !== undefined && !model.capabilities.includes("completion")) continue;
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

/** `undefined` when nothing is selectable (an empty menu is never opened). */
export function modelMenu(provider: ProviderId, models: readonly ModelInfo[], currentModel: string): Menu | undefined {
  const items: MenuItem[] = selectableModels(models).map((model) => ({
    id: model.id,
    label: model.id,
    ...(model.details === undefined || model.details === "" ? {} : { note: model.details }),
    current: model.id === currentModel,
  }));
  return Menu.create("model", `SELECT ${PROVIDER_LABELS[provider].toUpperCase()} MODEL`, items);
}

export type ReasoningMenu =
  | { readonly kind: "menu"; readonly menu: Menu; readonly info?: string }
  | { readonly kind: "none"; readonly message: string };

/** `choice` is the effective choice with its provenance: absence of a sent parameter alone is not "Model default". */
export function reasoningMenu(model: string, capabilities: ModelCapabilities, choice: ReasoningChoice): ReasoningMenu {
  const support = capabilities.reasoning;
  const explicitDefault = choice.explicit && choice.effort === undefined;
  let items: MenuItem[];
  let info: string | undefined;
  if (!support.known) {
    items = [{ id: MODEL_DEFAULT_ID, label: "Model default (support unknown)", current: explicitDefault }];
    info =
      `Reasoning support for ${model} is not confirmed, so only the model's default is offered. ` +
      "--reasoning-effort sends a value explicitly.";
  } else if (support.values.length === 0) {
    return { kind: "none", message: `${model} does not support reasoning.` };
  } else {
    const note = support.modelDefault === undefined || support.modelDefault === "" ? "no effort sent" : `no effort sent: ${support.modelDefault}`;
    items = support.allowsModelDefault ? [{ id: MODEL_DEFAULT_ID, label: "Model default", note, current: explicitDefault }] : [];
    items.push(...support.values.map((value) => ({ id: `${VALUE_PREFIX}${value}`, label: reasoningLabel(value), current: choice.effort === value })));
  }
  const menu = Menu.create("reasoning", "REASONING", items);
  if (menu === undefined) return { kind: "none", message: `${model} does not support reasoning.` };
  return info === undefined ? { kind: "menu", menu } : { kind: "menu", menu, info };
}

/** The stored value for a reasoning item: `"default"` for Model default, else the provider's exact string. */
export function reasoningValueOf(id: string): string | undefined {
  if (id === MODEL_DEFAULT_ID) return "default";
  return id.startsWith(VALUE_PREFIX) ? id.slice(VALUE_PREFIX.length) : undefined;
}

export function reasoningChoiceLabel(id: string): string {
  if (id === MODEL_DEFAULT_ID) return "Model default (no effort parameter is sent)";
  return reasoningLabel(id.slice(VALUE_PREFIX.length));
}

export function tokensMenu(choice: MaxOutputTokensChoice, limit: number | undefined): Menu | undefined {
  const current = choice.value;
  const presets = TOKEN_PRESETS.filter((value) => limit === undefined || value <= limit);
  const custom = current !== undefined && !presets.includes(current);
  const items: MenuItem[] = [
    { id: "default", label: "Default", note: "model default", current: current === undefined },
    ...presets.map((value) => ({ id: String(value), label: String(value), current: value === current })),
    {
      id: CUSTOM_ID,
      label: custom ? `Custom (${String(current)})` : "Custom...",
      note: limit === undefined ? "any positive number" : `up to ${String(limit)}`,
      current: custom,
    },
  ];
  return Menu.create("max-tokens", "MAX OUTPUT TOKENS", items);
}

export function styleMenu(current: AnswerStyle): Menu | undefined {
  return Menu.create(
    "style",
    "ANSWER STYLE",
    ANSWER_STYLES.map((style) => ({ id: style, label: style.charAt(0).toUpperCase() + style.slice(1), note: STYLE_NOTES[style], current: style === current })),
  );
}
