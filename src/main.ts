import { PROGRAM_NAME, parseCliArgs } from "./args.js";
import type { PromptInvocation } from "./args.js";
import { resolveSettings } from "./application/resolve-settings.js";
import type { HistoryPort, SettingsPort } from "./application/chat-startup.js";
import { runChat } from "./chat/run-chat.js";
import { EXIT_CANCELLED, ProviderError, SettingsError, exitCodeForKind, isAbortError } from "./domain/errors.js";
import type { ProviderId } from "./domain/generation.js";
import type { Provider } from "./domain/provider.js";
import { styleInstructions } from "./domain/settings.js";
import { EDITION_TITLE, formatUsage, helpText, usageHint, versionText } from "./help.js";
import { OpenAIProvider } from "./providers/openai/provider.js";
import { EXIT_BROKEN_PIPE, EXIT_FAILURE, EXIT_INCOMPLETE, EXIT_OK, EXIT_USAGE, OutputError, hasErrorCode, write } from "./io.js";
import type { InterruptSource, Io } from "./io.js";
import { EMPTY_INPUT } from "./line-input.js";
import type { LineInput } from "./line-input.js";
import { HistoryStore } from "./storage/fs/history-store.js";
import { newConversationId } from "./storage/fs/paths.js";
import type { StorageEnvironment } from "./storage/fs/paths.js";
import { SettingsStore } from "./storage/fs/settings-store.js";
import { readPackageVersion } from "./version.js";

export { EXIT_BROKEN_PIPE, EXIT_FAILURE, EXIT_INCOMPLETE, EXIT_OK, EXIT_USAGE };
export type { InterruptSource, Io, Writer } from "./io.js";

export interface RunDependencies {
  /**
   * Creates the provider the user selected for a one-shot prompt. Called only
   * for that provider, after argument validation. May throw a SettingsError
   * for invalid configuration (exit 2). Must not do I/O or read credentials
   * until an operation runs. Default: an OpenAI provider that has no key
   * source (prompts fail with a missing-key error) and no Ollama at all; the
   * executable composition supplies the real environment-backed factory.
   */
  readonly createProvider?: (id: ProviderId) => Provider;
  readonly interrupt?: InterruptSource;
  /** Upper bound for waiting on an aborted operation to settle. Default 2000 ms. */
  readonly cleanupTimeoutMs?: number;

  // ----- interactive chat only (never used by a one-shot prompt) -----

  /**
   * Where conversations and settings live. Only these injected values are
   * consulted: default is an empty environment without a home, which disables
   * history and settings (with warnings) instead of guessing a location.
   */
  readonly storageEnvironment?: { readonly env: StorageEnvironment; readonly home?: string | undefined };
  /** Creates the line input when the chat starts; the run disposes it. Default: input that is already at its end. */
  readonly createInput?: () => LineInput;
  /** Throws a ProviderError when the selected provider cannot run (e.g. no key). Must not use the network. */
  readonly checkProviderReady?: (id: ProviderId) => void;
  /** Time source for conversation and usage timestamps. Default: the system clock. */
  readonly clock?: () => Date;
  /** Conversation ID source. Default: random UUIDs. */
  readonly newId?: () => string;
  /** Stores are built only from paths resolved out of `storageEnvironment`. Defaults: the filesystem stores. */
  readonly createHistoryStore?: (conversationsDirectory: string) => HistoryPort;
  readonly createSettingsStore?: (path: string) => SettingsPort;
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 2000;

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
    case "chat":
      return runChat(parsed.invocation, io, {
        title: `${EDITION_TITLE} ${readPackageVersion()}`,
        interrupt: deps.interrupt,
        cleanupTimeoutMs: deps.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
        createInput: deps.createInput ?? (() => EMPTY_INPUT),
        environment: deps.storageEnvironment ?? { env: {} },
        clock: deps.clock ?? (() => new Date()),
        newId: deps.newId ?? newConversationId,
        createProvider: deps.createProvider ?? defaultProvider,
        checkProviderReady: deps.checkProviderReady,
        createHistoryStore: deps.createHistoryStore ?? ((directory) => new HistoryStore(directory)),
        createSettingsStore: deps.createSettingsStore ?? ((path) => new SettingsStore(path)),
      });
  }
}

async function runPrompt(invocation: PromptInvocation, io: Io, deps: RunDependencies): Promise<number> {
  const controller = new AbortController();
  const unregister = deps.interrupt?.register(() => {
    controller.abort();
  });
  try {
    const provider = (deps.createProvider ?? defaultProvider)(invocation.provider);
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

function defaultProvider(id: ProviderId): Provider {
  if (id === "ollama") {
    // Never reach a real server from a composition that was not given one.
    throw new ProviderError("Ollama is not configured in this composition.", "api");
  }
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
