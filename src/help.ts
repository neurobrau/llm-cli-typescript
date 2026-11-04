import { PROGRAM_NAME } from "./args.js";
import type { StreamTiming, TokenUsage } from "./domain/generation.js";

const EDITION = "NeuroBräu TypeScript CLI";

/** The banner/version title without the version number. */
export const EDITION_TITLE = EDITION;

export function versionText(version: string): string {
  return `${EDITION} ${version}\n`;
}

export function usageHint(): string {
  return `Try '${PROGRAM_NAME} --help' for usage.\n`;
}

export function helpText(version: string): string {
  return `usage: ${PROGRAM_NAME} [-h] [--version] [--provider PROVIDER] [--model MODEL_ID]
                 [--reasoning-effort EFFORT] [--max-output-tokens N]
                 [--answer-style STYLE] [--usage] [--stream] [--plain]
                 [--no-history] [--transcript-on-exit]
                 [prompt]

${EDITION} ${version}

With a prompt, sends it once to OpenAI or a local Ollama server and prints
the answer; no history or saved settings are used.
Without a prompt, starts a chat that continues the last saved conversation,
saves each completed exchange and applies saved settings: a fullscreen
DOS-style interface on a supported terminal (xterm, screen, tmux, rxvt
families), otherwise (or with --plain, or when input/output is not a
terminal) a line-oriented chat (YOU > / AI >). With --stream the answer is
printed as it arrives. Cost estimates and the F2-F6 settings menus
(provider/model switching) are future work. OpenAI requires OPENAI_API_KEY
in the environment. Ollama needs no key; OLLAMA_HOST selects the server (default
http://127.0.0.1:11434).

positional arguments:
  prompt                     prompt text for a one-shot request; omit to chat

options:
  -h, --help                 show this help message and exit
  --version                  show program's version number and exit
  --provider PROVIDER        LLM provider: openai (default) or ollama. In chat,
                             without --provider and --model, the saved
                             selection or the newest conversation is used
  --model MODEL_ID           model identifier (default: gpt-6-luna for openai,
                             the first local model for ollama)
  --reasoning-effort EFFORT  none, minimal, low, medium, high, xhigh, max, or
                             model-default (send no effort; the model uses its
                             own default). Without it, the saved choice (chat
                             only) or none is used where supported
  --max-output-tokens N      maximum number of tokens to generate (default:
                             the saved choice (chat only), else the model's)
  --answer-style STYLE       brief, normal or detailed (default: the saved
                             choice (chat only), else normal)
  --usage                    print reported token usage to stderr
  --stream                   print the answer as it arrives; Ctrl+C cancels
                             and nothing of a partial answer is saved
  --plain                    line-oriented chat even on a capable terminal;
                             not allowed with a prompt
  --no-history               chat without reading or saving conversations;
                             not allowed with a prompt
  --transcript-on-exit       fullscreen chat only: after the terminal is
                             restored, print the committed conversation
                             (no effect in the plain chat); not allowed with
                             a prompt

In chat: /help, /reset, /cleanup, /usage and /exit (also with a backslash).
Use -- before a prompt that starts with a dash.
`;
}

/** Reference format; only reported counts are shown. */
export function formatUsage(usage: TokenUsage | undefined): string {
  if (usage === undefined) {
    return "Token usage: not reported";
  }
  const fields: readonly (readonly [string, bigint | undefined])[] = [
    ["input", usage.inputTokens],
    ["output", usage.outputTokens],
    ["total", usage.totalTokens],
  ];
  const parts = fields.flatMap(([name, count]) => (count === undefined ? [] : [`${name}=${count.toString()}`]));
  return `Token usage: ${parts.length > 0 ? parts.join(", ") : "not reported"}`;
}

/**
 * The `Duration:` line for provider-reported timing (Ollama), or "" when the
 * total was not reported. Missing values are never shown as zero.
 */
export function formatDuration(timing: StreamTiming | undefined): string {
  const total = timing?.totalSeconds;
  if (total === undefined || total <= 0) {
    return "";
  }
  const details: string[] = [];
  const load = timing?.loadSeconds;
  const generation = timing?.evalSeconds;
  if (load !== undefined && load > 0) {
    details.push(`load ${load.toFixed(2)} s`);
  }
  if (generation !== undefined && generation > 0) {
    details.push(`generation ${generation.toFixed(2)} s`);
  }
  return `Duration: ${total.toFixed(2)} s${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}
