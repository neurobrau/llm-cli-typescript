import { parseArgs } from "node:util";

import type { ProviderId } from "./domain/generation.js";
import { ANSWER_STYLES, MODEL_DEFAULT, REASONING_EFFORTS } from "./domain/settings.js";
import type { AnswerStyle, CliReasoning } from "./domain/settings.js";

export const PROGRAM_NAME = "neurobrau";

/** A validated one-shot request. */
export interface PromptInvocation {
  readonly provider: ProviderId;
  readonly model?: string;
  readonly reasoning?: CliReasoning;
  readonly maxOutputTokens?: number;
  readonly answerStyle?: AnswerStyle;
  readonly usage: boolean;
  /** Exactly as given, whitespace preserved. */
  readonly prompt: string;
}

/**
 * A validated interactive (plain chat) request. `provider` is present only
 * when `--provider` was given: restoring a conversation treats an omitted
 * provider differently from an explicit `--provider openai`. A `--model`
 * without `--provider` selects OpenAI at the application layer, not here.
 */
export interface ChatInvocation {
  readonly provider?: ProviderId;
  readonly model?: string;
  readonly reasoning?: CliReasoning;
  readonly maxOutputTokens?: number;
  readonly answerStyle?: AnswerStyle;
  readonly usage: boolean;
  readonly noHistory: boolean;
}

export type ParsedArgs =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "prompt"; readonly invocation: PromptInvocation }
  | { readonly kind: "chat"; readonly invocation: ChatInvocation }
  | { readonly kind: "error"; readonly message: string };

/** Options of the Python/Go editions that this build deliberately rejects. */
const FUTURE_OPTIONS: ReadonlySet<string> = new Set(["stream", "transcript-on-exit"]);

/** Switches that only make sense for the interactive chat. */
const CHAT_SWITCHES: ReadonlySet<string> = new Set(["plain", "no-history"]);

const VALUE_OPTIONS = ["provider", "model", "reasoning-effort", "max-output-tokens", "answer-style"] as const;
type ValueOption = (typeof VALUE_OPTIONS)[number];

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  usage: { type: "boolean" },
  plain: { type: "boolean" },
  "no-history": { type: "boolean" },
  provider: { type: "string" },
  model: { type: "string" },
  "reasoning-effort": { type: "string" },
  "max-output-tokens": { type: "string" },
  "answer-style": { type: "string" },
} as const;

function isValueOption(name: string): name is ValueOption {
  return (VALUE_OPTIONS as readonly string[]).includes(name);
}

/**
 * Pure argument parser. It never throws for user input and performs no I/O.
 * Repeated identical --help/--version/--usage switches are idempotent; value
 * options may be given once. "--" ends option parsing.
 */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const { tokens } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  let help = false;
  let version = false;
  let usage = false;
  const chatSwitches = new Set<string>();
  const values = new Map<ValueOption, string>();
  const valued: string[] = [];
  const problems: string[] = [];
  const future: string[] = [];
  const unknown: string[] = [];
  const positionals: string[] = [];

  for (const token of tokens) {
    if (token.kind === "positional") {
      positionals.push(token.value);
    } else if (token.kind === "option") {
      const { name, rawName } = token;
      if (name === "help" || name === "version" || name === "usage" || CHAT_SWITCHES.has(name)) {
        if (token.inlineValue === true) {
          valued.push(rawName);
        } else if (name === "help") {
          help = true;
        } else if (name === "version") {
          version = true;
        } else if (name === "usage") {
          usage = true;
        } else {
          chatSwitches.add(name);
        }
      } else if (isValueOption(name)) {
        // A separate value that looks like an option is a missing value (use --opt=value for such text).
        const missing = token.value === undefined || (!token.inlineValue && token.value.startsWith("-"));
        if (missing) {
          problems.push(`option ${quote(rawName)} requires a value`);
        } else if (values.has(name)) {
          problems.push(`option ${quote(`--${name}`)} was given more than once`);
        } else {
          values.set(name, token.value);
        }
      } else if (FUTURE_OPTIONS.has(name)) {
        future.push(rawName);
      } else {
        unknown.push(rawName);
      }
    }
  }

  const [firstValued] = valued;
  if (firstValued !== undefined) {
    return fail(`invalid argument: option ${quote(firstValued)} does not take a value`);
  }
  const [firstProblem] = problems;
  if (firstProblem !== undefined) {
    return fail(`invalid argument: ${firstProblem}`);
  }
  const hasGenerationOptions = usage || values.size > 0;
  const hasOtherArguments =
    future.length > 0 || unknown.length > 0 || positionals.length > 0 || hasGenerationOptions || chatSwitches.size > 0;
  if ((help || version) && hasOtherArguments) {
    const switchName = help ? "--help" : "--version";
    return fail(`invalid invocation: ${switchName} cannot be combined with other arguments`);
  }
  if (help && version) {
    return fail("conflicting options: --help and --version cannot be used together");
  }
  const [firstFuture] = future;
  if (firstFuture !== undefined) {
    return fail(`unsupported option ${quote(firstFuture)}: not implemented yet`);
  }
  const [firstUnknown] = unknown;
  if (firstUnknown !== undefined) {
    return fail(`unknown option ${quote(firstUnknown)}`);
  }

  const settings = validateValues(values);
  if (typeof settings === "string") {
    return fail(settings);
  }

  if (positionals.length > 1) {
    return fail("unsupported positional arguments: expected exactly one prompt");
  }
  const [prompt] = positionals;
  if (prompt === undefined) {
    if (help) {
      return { kind: "help" };
    }
    if (version) {
      return { kind: "version" };
    }
    // No prompt: plain chat, with or without options.
    return {
      kind: "chat",
      invocation: {
        ...(values.has("provider") ? { provider: settings.provider } : {}),
        ...(settings.model === undefined ? {} : { model: settings.model }),
        ...(settings.reasoning === undefined ? {} : { reasoning: settings.reasoning }),
        ...(settings.maxOutputTokens === undefined ? {} : { maxOutputTokens: settings.maxOutputTokens }),
        ...(settings.answerStyle === undefined ? {} : { answerStyle: settings.answerStyle }),
        usage,
        noHistory: chatSwitches.has("no-history"),
      },
    };
  }
  if (prompt.trim() === "") {
    return fail("the prompt must not be empty");
  }
  const [firstChatSwitch] = chatSwitches;
  if (firstChatSwitch !== undefined) {
    return fail(`option "--${firstChatSwitch}" cannot be used with a prompt: it applies to the interactive chat only`);
  }
  return { kind: "prompt", invocation: { ...settings, usage, prompt } };
}

type ValidatedSettings = Omit<PromptInvocation, "usage" | "prompt">;

/** Validates option values; returns a diagnostic string on failure. */
function validateValues(values: ReadonlyMap<ValueOption, string>): ValidatedSettings | string {
  const provider = values.get("provider");
  if (provider !== undefined && provider !== "openai" && provider !== "ollama") {
    return `invalid provider ${quote(provider)}: expected openai or ollama`;
  }
  const model = values.get("model");
  if (model?.trim() === "") {
    return "invalid model: the model ID must not be empty";
  }
  const effort = values.get("reasoning-effort");
  const reasoning = ([...REASONING_EFFORTS, MODEL_DEFAULT] as const).find((candidate) => candidate === effort);
  if (effort !== undefined && reasoning === undefined) {
    return `invalid reasoning effort ${quote(effort)}: expected ${[...REASONING_EFFORTS, MODEL_DEFAULT].join(", ")}`;
  }
  const tokens = values.get("max-output-tokens");
  let maxOutputTokens: number | undefined;
  if (tokens !== undefined) {
    maxOutputTokens = /^[0-9]+$/.test(tokens) ? Number(tokens) : Number.NaN;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      return `invalid max output tokens ${quote(tokens)}: expected a positive whole number`;
    }
  }
  const style = values.get("answer-style");
  const answerStyle = ANSWER_STYLES.find((candidate) => candidate === style);
  if (style !== undefined && answerStyle === undefined) {
    return `invalid answer style ${quote(style)}: expected ${ANSWER_STYLES.join(", ")}`;
  }
  return {
    provider: provider ?? "openai",
    ...(model === undefined ? {} : { model }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(answerStyle === undefined ? {} : { answerStyle }),
  };
}

function fail(message: string): ParsedArgs {
  return { kind: "error", message };
}

/** JSON quoting keeps control characters in user input out of diagnostics. */
function quote(text: string): string {
  return JSON.stringify(text);
}
