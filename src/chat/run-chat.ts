/** Composition of one interactive chat run: startup, the loop, and the mapping of failures to exit codes. */
import { PROGRAM_NAME } from "../args.js";
import type { ChatInvocation } from "../args.js";
import { startChat } from "../application/chat-startup.js";
import type { ChatStartupDependencies } from "../application/chat-startup.js";
import { EXIT_CANCELLED, ProviderError, SettingsError, exitCodeForKind, isAbortError } from "../domain/errors.js";
import { EXIT_FAILURE, EXIT_USAGE, OutputError, write } from "../io.js";
import type { InterruptSource, Io } from "../io.js";
import { InputError } from "../line-input.js";
import type { LineInput } from "../line-input.js";
import { PlainChat } from "./plain-chat.js";

export interface ChatRunDependencies extends ChatStartupDependencies {
  readonly title: string;
  readonly interrupt?: InterruptSource | undefined;
  readonly cleanupTimeoutMs: number;
  /** Called once when the chat starts (after argument validation); the run disposes the result. */
  readonly createInput: () => LineInput;
}

export async function runChat(invocation: ChatInvocation, io: Io, deps: ChatRunDependencies): Promise<number> {
  const startup = new AbortController();
  let chat: PlainChat | undefined;
  const unregister = deps.interrupt?.register(() => {
    if (chat === undefined) startup.abort();
    else chat.interrupt();
  });
  let input: LineInput | undefined;
  try {
    input = deps.createInput();
    let started;
    try {
      started = await startChat(invocation, deps, startup.signal);
    } catch (error: unknown) {
      return await startupFailure(error, startup.signal, io);
    }
    if (startup.signal.aborted) {
      return await interrupted(io); // no banner and no request after an interrupt during startup
    }
    chat = new PlainChat({
      title: deps.title,
      session: started.session,
      provider: started.provider,
      settings: started.settings,
      warnings: started.warnings,
      io,
      input,
      showUsage: invocation.usage,
      cleanupTimeoutMs: deps.cleanupTimeoutMs,
    });
    return await chat.run();
  } catch (error: unknown) {
    if (error instanceof OutputError) throw error;
    return await fixedFailure(error, io);
  } finally {
    unregister?.();
    input?.dispose();
  }
}

async function startupFailure(error: unknown, signal: AbortSignal, io: Io): Promise<number> {
  if (isAbortError(error) || signal.aborted) return interrupted(io);
  if (error instanceof SettingsError) {
    await write(io.stderr, `${PROGRAM_NAME}: error: ${error.message}\n`);
    return EXIT_USAGE;
  }
  if (error instanceof ProviderError) {
    await write(io.stderr, `${PROGRAM_NAME}: error: ${error.message}\n`);
    return exitCodeForKind(error.kind);
  }
  throw error;
}

async function interrupted(io: Io): Promise<number> {
  await write(io.stderr, `${PROGRAM_NAME}: interrupted\n`);
  return EXIT_CANCELLED;
}

/** Input failures and unexpected internal errors: fixed, safe text; nothing from the exception is printed. */
async function fixedFailure(error: unknown, io: Io): Promise<number> {
  const text = error instanceof InputError ? "could not read input" : "an internal error occurred";
  await write(io.stderr, `${PROGRAM_NAME}: error: ${text}\n`);
  return EXIT_FAILURE;
}
