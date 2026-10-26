import { parseArgs } from "node:util";

export const PROGRAM_NAME = "neurobrau";

export type ParsedArgs =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "error"; readonly message: string };

/** Options of the Python/Go editions that this bootstrap deliberately rejects. */
const FUTURE_OPTIONS: ReadonlySet<string> = new Set([
  "provider",
  "model",
  "reasoning-effort",
  "max-output-tokens",
  "answer-style",
  "usage",
  "stream",
  "plain",
  "no-history",
  "transcript-on-exit",
]);

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

/**
 * Pure argument parser for the bootstrap CLI. It never throws for user input
 * and performs no I/O. Repeated identical --help/--version switches are
 * idempotent; "--" ends option parsing.
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
  const valued: string[] = [];
  const future: string[] = [];
  const unknown: string[] = [];
  const positionals: string[] = [];

  for (const token of tokens) {
    if (token.kind === "positional") {
      positionals.push(token.value);
    } else if (token.kind === "option") {
      if (token.name === "help" || token.name === "version") {
        if (token.inlineValue === true) {
          valued.push(token.rawName);
        } else if (token.name === "help") {
          help = true;
        } else {
          version = true;
        }
      } else if (FUTURE_OPTIONS.has(token.name)) {
        future.push(token.rawName);
      } else {
        unknown.push(token.rawName);
      }
    }
  }

  const [firstValued] = valued;
  if (firstValued !== undefined) {
    return fail(`invalid argument: option ${quote(firstValued)} does not take a value`);
  }
  if ((help || version) && (future.length > 0 || unknown.length > 0 || positionals.length > 0)) {
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
  if (positionals.length === 1) {
    return fail("prompt mode is not implemented yet");
  }
  if (positionals.length > 1) {
    return fail("unsupported positional arguments: prompt mode is not implemented yet");
  }
  return version ? { kind: "version" } : { kind: "help" };
}

function fail(message: string): ParsedArgs {
  return { kind: "error", message };
}

/** JSON quoting keeps control characters in user input out of diagnostics. */
function quote(text: string): string {
  return JSON.stringify(text);
}
