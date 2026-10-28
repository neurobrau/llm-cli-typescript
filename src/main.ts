import { PROGRAM_NAME, parseCliArgs } from "./args.js";
import type { PromptInvocation } from "./args.js";
import { resolveSettings } from "./application/resolve-settings.js";
import { EXIT_CANCELLED, ProviderError, SettingsError, exitCodeForKind, isAbortError } from "./domain/errors.js";
import type { Provider } from "./domain/provider.js";
import { styleInstructions } from "./domain/settings.js";
import { formatUsage, helpText, usageHint, versionText } from "./help.js";
import { OpenAIProvider } from "./providers/openai/provider.js";
import { readPackageVersion } from "./version.js";

export type Writer = (text: string) => Promise<void> | void;

export interface Io {
  readonly stdout: Writer;
  readonly stderr: Writer;
}

/**
 * Registers an interrupt (SIGINT) callback for the duration of one operation
 * and returns a function that unregisters it. The executable supplies the
 * real signal wiring; unit tests inject their own.
 */
export interface InterruptSource {
  register(onInterrupt: () => void): () => void;
}

export interface RunDependencies {
  /**
   * Creates the provider for a one-shot prompt. Must not read credentials
   * or do I/O until an operation runs. Default: an OpenAI provider that has
   * no key source, so prompts fail with a missing-key error; the executable
   * composition supplies the real environment-backed factory.
   */
  readonly createProvider?: () => Provider;
  readonly interrupt?: InterruptSource;
  /** Upper bound for waiting on an aborted operation to settle. Default 2000 ms. */
  readonly cleanupTimeoutMs?: number;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_INCOMPLETE = 8;
export const EXIT_BROKEN_PIPE = 141;

const DEFAULT_CLEANUP_TIMEOUT_MS = 2000;

class OutputError extends Error {
  constructor(readonly cause: unknown) {
    super("output failed");
  }
}

/** Runs the CLI and returns the exit code; never calls process.exit(). */
export async function run(argv: readonly string[], io: Io, deps: RunDependencies = {}): Promise<number> {
  try {
    return await execute(argv, io, deps);
  } catch (error: unknown) {
    if (error instanceof OutputError) {
      return outputFailureCode(error.cause, io);
    }
    return reportInternalError(error, io);
  }
}

async function execute(argv: readonly string[], io: Io, deps: RunDependencies): Promise<number> {
  const parsed = parseCliArgs(argv);
  switch (parsed.kind) {
    case "help":
      await write(io.stdout, helpText(readPackageVersion()));
      return EXIT_OK;
    case "version":
      await write(io.stdout, versionText(readPackageVersion()));
      return EXIT_OK;
    case "error":
      await write(io.stderr, `${PROGRAM_NAME}: error: ${parsed.message}\n${usageHint()}`);
      return EXIT_USAGE;
    case "prompt":
      return runPrompt(parsed.invocation, io, deps);
  }
}

async function runPrompt(invocation: PromptInvocation, io: Io, deps: RunDependencies): Promise<number> {
  const provider = (deps.createProvider ?? defaultProvider)();
  const controller = new AbortController();
  const unregister = deps.interrupt?.register(() => {
    controller.abort();
  });
  try {
    const operation = oneShot(invocation, provider, controller.signal);
    // After an interrupt, wait only a bounded time for the operation to settle.
    const outcome = await settleBounded(operation, controller.signal, deps.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
    if (outcome === "interrupted") {
      return await interrupted(io);
    }
    return await present(outcome, invocation, io, controller.signal);
  } catch (error: unknown) {
    if (isAbortError(error) || controller.signal.aborted) {
      return await interrupted(io);
    }
    if (error instanceof SettingsError) {
      await write(io.stderr, `${PROGRAM_NAME}: error: ${error.message}\n`);
      return EXIT_USAGE;
    }
    if (error instanceof ProviderError) {
      await write(io.stderr, `${PROGRAM_NAME}: error: ${error.message}\n`);
      return exitCodeForKind(error.kind);
    }
    throw error;
  } finally {
    unregister?.();
  }
}

function defaultProvider(): Provider {
  return new OpenAIProvider({ getApiKey: () => undefined });
}

async function interrupted(io: Io): Promise<number> {
  await write(io.stderr, `${PROGRAM_NAME}: interrupted\n`);
  return EXIT_CANCELLED;
}

type OneShotResult = Awaited<ReturnType<typeof oneShot>>;

async function oneShot(invocation: PromptInvocation, provider: Provider, signal: AbortSignal) {
  const model = invocation.model ?? (await provider.defaultModel(signal));
  const capabilities = await provider.getCapabilities(model, signal);
  // One-shot uses flags and built-in defaults only: no saved preferences are read.
  const { settings, notices } = resolveSettings({
    provider: provider.id,
    model,
    capabilities,
    saved: {},
    cli: {
      ...(invocation.reasoning === undefined ? {} : { reasoning: invocation.reasoning }),
      ...(invocation.maxOutputTokens === undefined ? {} : { maxOutputTokens: invocation.maxOutputTokens }),
      ...(invocation.answerStyle === undefined ? {} : { answerStyle: invocation.answerStyle }),
    },
    mode: "strict",
  });
  const instructions = styleInstructions(settings.answerStyle.value);
  const outcome = await provider.generate(
    {
      model,
      messages: [{ role: "user", content: invocation.prompt }],
      reasoning: settings.reasoning,
      ...(settings.maxOutputTokens.value === undefined ? {} : { maxOutputTokens: settings.maxOutputTokens.value }),
      ...(instructions === undefined ? {} : { instructions }),
    },
    signal,
  );
  return { outcome, notices };
}

/** Resolves with the operation's result, or "interrupted" if it did not settle in time after an abort. */
async function settleBounded(
  operation: Promise<OneShotResult>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<OneShotResult | "interrupted"> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const gaveUp = new Promise<"interrupted">((resolve) => {
    onAbort = () => {
      timer = setTimeout(() => {
        resolve("interrupted");
      }, timeoutMs);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([operation, gaveUp]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
    // Never leave a late rejection unhandled once we stopped waiting.
    operation.catch(() => undefined);
  }
}

async function present(result: OneShotResult, invocation: PromptInvocation, io: Io, signal: AbortSignal): Promise<number> {
  if (signal.aborted) {
    return interrupted(io); // no answer output after cancellation
  }
  const { outcome, notices } = result;
  for (const note of notices) {
    await write(io.stderr, `${PROGRAM_NAME}: note: ${note}\n`);
  }
  if (outcome.kind === "completed") {
    await write(io.stdout, `${outcome.result.text}\n`);
    if (invocation.usage) {
      await write(io.stderr, `${formatUsage(outcome.result.usage)}\n`);
    }
    return EXIT_OK;
  }
  if (outcome.partialText !== "") {
    await write(io.stdout, `${outcome.partialText}\n`);
  }
  await write(io.stderr, `${PROGRAM_NAME}: warning: response incomplete: ${outcome.reason}.\n`);
  if (invocation.usage && outcome.usage !== undefined) {
    await write(io.stderr, `${formatUsage(outcome.usage)}\n`);
  }
  return EXIT_INCOMPLETE;
}

async function write(writer: Writer, text: string): Promise<void> {
  try {
    await writer(text);
  } catch (error: unknown) {
    throw new OutputError(error);
  }
}

async function outputFailureCode(cause: unknown, io: Io): Promise<number> {
  if (hasErrorCode(cause, "EPIPE")) {
    return EXIT_BROKEN_PIPE;
  }
  try {
    await io.stderr(`${PROGRAM_NAME}: error: cannot write output\n`);
  } catch {
    // stderr is unusable as well; the exit code is the only remaining signal.
  }
  return EXIT_FAILURE;
}

async function reportInternalError(error: unknown, io: Io): Promise<number> {
  const reason = error instanceof Error ? error.message : "unknown failure";
  try {
    await io.stderr(`${PROGRAM_NAME}: error: ${reason}\n`);
  } catch (writeError: unknown) {
    return hasErrorCode(writeError, "EPIPE") ? EXIT_BROKEN_PIPE : EXIT_FAILURE;
  }
  return EXIT_FAILURE;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
