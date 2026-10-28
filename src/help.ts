import { PROGRAM_NAME } from "./args.js";
import type { TokenUsage } from "./domain/generation.js";

const EDITION = "NeuroBräu TypeScript CLI";

export function versionText(version: string): string {
  return `${EDITION} ${version}\n`;
}

export function usageHint(): string {
  return `Try '${PROGRAM_NAME} --help' for usage.\n`;
}

export function helpText(version: string): string {
  return `usage: ${PROGRAM_NAME} [-h] [--version] [--provider PROVIDER] [--model MODEL_ID]
                 [--reasoning-effort EFFORT] [--max-output-tokens N]
                 [--answer-style STYLE] [--usage] prompt

${EDITION} ${version}

Sends one prompt to OpenAI or a local Ollama server (non-streaming) and prints
the answer. Interactive chat, streaming, history and saved settings are future
work. OpenAI requires OPENAI_API_KEY in the environment. Ollama needs no key;
OLLAMA_HOST selects the server (default http://127.0.0.1:11434).

positional arguments:
  prompt                     prompt text for a one-shot request

options:
  -h, --help                 show this help message and exit
  --version                  show program's version number and exit
  --provider PROVIDER        LLM provider: openai (default) or ollama
  --model MODEL_ID           model identifier (default: gpt-6-luna for openai,
                             the first local model for ollama)
  --reasoning-effort EFFORT  none, minimal, low, medium, high, xhigh, max, or
                             model-default (send no effort; the model uses its
                             own default). Without it, none is used where
                             supported
  --max-output-tokens N      maximum number of tokens to generate (default: the
                             model's)
  --answer-style STYLE       brief, normal or detailed (default: normal)
  --usage                    print reported token usage to stderr

With no arguments, this help is shown. Use -- before a prompt that starts with
a dash.
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
