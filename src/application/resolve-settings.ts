/**
 * Pure settings resolution (Python docs/tui-spec.md section 13; Go
 * chat.ResolveSettings). No provider calls, files, environment, caches or
 * mutation: callers supply capabilities and saved preferences.
 */
import { SettingsError } from "../domain/errors.js";
import type { ReasoningChoice } from "../domain/generation.js";
import { MODEL_DEFAULT, SAVED_DEFAULT } from "../domain/settings.js";
import type {
  MaxOutputTokensChoice,
  ReasoningSupport,
  SettingsInput,
  SettingsResolution,
} from "../domain/settings.js";

/** Failure messages carry no trailing period; callers append their own punctuation. */
type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export function resolveSettings(input: SettingsInput): SettingsResolution {
  const notices: string[] = [];
  const strict = input.mode === "strict";
  const { model, cli } = input;

  const reasoning = resolveReasoning(input, strict, notices);
  const maxOutputTokens = resolveMaxOutputTokens(input, strict, notices);

  const answerStyle =
    cli.answerStyle !== undefined
      ? { value: cli.answerStyle, source: "cli" as const }
      : input.savedAnswerStyle !== undefined
        ? { value: input.savedAnswerStyle, source: "saved" as const }
        : { value: "normal" as const, source: "builtin" as const };

  return {
    settings: { provider: input.provider, model, reasoning, maxOutputTokens, answerStyle },
    notices,
  };
}

// ----- reasoning -----

function resolveReasoning(input: SettingsInput, strict: boolean, notices: string[]): ReasoningChoice {
  const { model, cli, saved } = input;
  const support = input.capabilities.reasoning;

  if (cli.reasoning !== undefined) {
    const attempt = resolveCliReasoning(model, support, cli.reasoning);
    if (attempt.ok) {
      return attempt.value;
    }
    if (strict) {
      throw new SettingsError(`${attempt.message}.`);
    }
    notices.push(`${attempt.message}; ignoring the command-line value.`);
  }

  const builtin = builtinReasoning(support);
  if (saved.reasoning !== undefined) {
    if (saved.reasoning === SAVED_DEFAULT && support.allowsModelDefault) {
      return { explicit: true, source: "saved" };
    }
    if (saved.reasoning !== SAVED_DEFAULT && support.known && support.values.includes(saved.reasoning)) {
      return { effort: saved.reasoning, explicit: true, source: "saved" };
    }
    notices.push(
      `Saved reasoning '${reasoningLabel(saved.reasoning)}' is not available for ${model} ` +
        `(${describeSupport(model, support)}); using ${builtin.effort === undefined ? "Model default" : reasoningLabel(builtin.effort)}.`,
    );
  }
  return builtin;
}

function builtinReasoning(support: ReasoningSupport): ReasoningChoice {
  const value = support.defaultValue;
  if (support.known && value !== undefined && support.values.includes(value)) {
    return { effort: value, explicit: false, source: "builtin" };
  }
  return { explicit: false, source: "builtin" };
}

function resolveCliReasoning(model: string, support: ReasoningSupport, requested: string): Attempt<ReasoningChoice> {
  if (requested === MODEL_DEFAULT) {
    if (!support.allowsModelDefault) {
      return {
        ok: false,
        message: `${model} has no model-default reasoning choice (${describeSupport(model, support)})`,
      };
    }
    return { ok: true, value: { explicit: true, source: "cli" } };
  }
  if (!support.known) {
    // Support unknown: the future API judges an explicit value.
    return { ok: true, value: { effort: requested, explicit: true, source: "cli" } };
  }
  if (support.values.length === 0 && (requested === "none" || requested === "off")) {
    // "No reasoning" on a model without it: accepted, nothing is sent.
    return { ok: true, value: { explicit: true, source: "cli" } };
  }
  const mapped = mapReasoning(support.values, requested);
  if (mapped !== undefined) {
    return { ok: true, value: { effort: mapped, explicit: true, source: "cli" } };
  }
  return { ok: false, message: `${describeSupport(model, support)}; '${requested}' is not available` };
}

/**
 * Translates a CLI effort into a value the model offers: exact match, then the
 * none/off alias, then `on` for any other effort on models that only switch
 * reasoning on or off (Go llm.mapReasoning order).
 */
function mapReasoning(values: readonly string[], requested: string): string | undefined {
  if (values.includes(requested)) {
    return requested;
  }
  const alias = requested === "none" ? "off" : requested === "off" ? "none" : undefined;
  if (alias !== undefined && values.includes(alias)) {
    return alias;
  }
  if (requested !== "none" && requested !== "off" && values.includes("on")) {
    return "on";
  }
  return undefined;
}

function describeSupport(model: string, support: ReasoningSupport): string {
  if (!support.known) {
    return `${model} reasoning support is not confirmed`;
  }
  if (support.values.length === 0) {
    return `${model} does not support reasoning`;
  }
  return `${model} supports reasoning: ${support.values.map(reasoningLabel).join(", ")}`;
}

/** Display name as in the references: only an absent value is "Model default"; the stored "default" is "Default". */
function reasoningLabel(value: string): string {
  switch (value) {
    case "xhigh":
      return "XHigh";
    case "on":
      return "On";
    case "off":
      return "Off";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

// ----- maximum output tokens -----

function resolveMaxOutputTokens(input: SettingsInput, strict: boolean, notices: string[]): MaxOutputTokensChoice {
  const { model, cli, saved } = input;
  const limit = knownLimit(input.capabilities.maxOutputTokensLimit);

  if (cli.maxOutputTokens !== undefined) {
    const problem = checkMaxOutputTokens(model, cli.maxOutputTokens, limit);
    if (problem === undefined) {
      return { value: cli.maxOutputTokens, explicit: true, source: "cli" };
    }
    if (strict) {
      throw new SettingsError(problem);
    }
    notices.push(`${problem} Using the default.`);
  }

  if (saved.maxOutputTokens === null) {
    return { explicit: true, source: "saved" };
  }
  if (saved.maxOutputTokens !== undefined) {
    const problem = checkMaxOutputTokens(model, saved.maxOutputTokens, limit);
    if (problem === undefined) {
      return { value: saved.maxOutputTokens, explicit: true, source: "saved" };
    }
    notices.push(`Saved setting ignored: ${problem} Using the default.`);
  }
  return { explicit: false, source: "builtin" };
}

/** An unknown (or malformed) limit imposes no ceiling. */
function knownLimit(limit: number | undefined): number | undefined {
  return limit !== undefined && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

function checkMaxOutputTokens(model: string, value: unknown, limit: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return `Max output tokens must be a positive whole number, not ${String(value)}.`;
  }
  if (limit !== undefined && value > limit) {
    return `${String(value)} exceeds the limit of ${String(limit)} output tokens for ${model}.`;
  }
  return undefined;
}
