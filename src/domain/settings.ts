import type { ProviderId, ReasoningChoice, ValueSource } from "./generation.js";

export type AnswerStyle = "brief" | "normal" | "detailed";

export const ANSWER_STYLES: readonly AnswerStyle[] = ["brief", "normal", "detailed"];

/** Reasoning effort names of the reference CLI vocabulary. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** CLI value that omits the reasoning parameter (the model uses its own default). */
export const MODEL_DEFAULT = "model-default";
/** Stored reasoning preference meaning "omit the parameter". */
export const SAVED_DEFAULT = "default";

/** A command-line reasoning value. `off`/`on` are accepted by the resolver for alias and interactive reuse. */
export type CliReasoning = typeof MODEL_DEFAULT | (typeof REASONING_EFFORTS)[number] | "off" | "on";

/**
 * What a provider could confirm about a model's reasoning. Unknown
 * (`known: false`) differs from confirmed-empty (`known: true`, no values).
 */
export interface ReasoningSupport {
  readonly known: boolean;
  /** Selectable values in the provider's vocabulary (e.g. `low`, or `off`/`on`). */
  readonly values: readonly string[];
  /** Whether omitting the parameter is a selectable user choice (false e.g. for Ollama off/on-only models). */
  readonly allowsModelDefault: boolean;
  /** NeuroBräu's confirmed application default; absent: omit the parameter. */
  readonly defaultValue?: string;
  /** The model's own default, if documented. Display metadata only. */
  readonly modelDefault?: string;
}

export interface ModelCapabilities {
  readonly reasoning: ReasoningSupport;
  /** Largest allowed max-output-tokens value; absent: unknown (no ceiling is invented). */
  readonly maxOutputTokensLimit?: number;
}

/** Saved preferences for one exact provider/model. Absent fields mean "no preference". */
export interface ModelPreferences {
  /** A provider value, or `"default"` (explicitly omit the parameter). */
  readonly reasoning?: string;
  /** `null`: explicitly the model default. A positive safe integer: the chosen limit. */
  readonly maxOutputTokens?: number | null;
}

export interface CliOverrides {
  readonly reasoning?: CliReasoning;
  /** Positive safe integer; there is no CLI syntax for null/default. */
  readonly maxOutputTokens?: number;
  readonly answerStyle?: AnswerStyle;
}

export type SettingsMode = "strict" | "lenient";

export interface SettingsInput {
  readonly provider: ProviderId;
  readonly model: string;
  readonly capabilities: ModelCapabilities;
  /** Saved preferences for this exact provider/model. */
  readonly saved: ModelPreferences;
  /** Global saved answer style. */
  readonly savedAnswerStyle?: AnswerStyle;
  readonly cli: CliOverrides;
  readonly mode: SettingsMode;
}

export interface MaxOutputTokensChoice {
  /** Absent: the parameter is omitted. */
  readonly value?: number;
  /** True for a user choice, including an explicit "model default" that omits the value. */
  readonly explicit: boolean;
  readonly source: ValueSource;
}

export interface ResolvedSettings {
  readonly provider: ProviderId;
  readonly model: string;
  readonly reasoning: ReasoningChoice;
  readonly maxOutputTokens: MaxOutputTokensChoice;
  readonly answerStyle: { readonly value: AnswerStyle; readonly source: ValueSource };
}

export interface SettingsResolution {
  readonly settings: ResolvedSettings;
  /** Ordered, user-facing notices. */
  readonly notices: readonly string[];
}

/** System/developer instruction for an answer style; `normal` adds none. Same text as the references. */
export function styleInstructions(style: AnswerStyle): string | undefined {
  switch (style) {
    case "brief":
      return (
        "Answer briefly and concisely. Use a few sentences or a short list. " +
        "Leave out background and caveats unless the user asks for them."
      );
    case "detailed":
      return (
        "Give a comprehensive, well-structured explanation. Cover the relevant " +
        "background and the reasoning behind the answer, and include concrete " +
        "examples when they help."
      );
    case "normal":
      return undefined;
  }
}
