/**
 * The line-oriented chat loop: reads lines, runs commands, sends messages one
 * at a time and renders the results. Session state lives in `ChatSession`;
 * this module composes provider generation with it and decides what to print.
 *
 * Concurrency rules (see docs/architecture.md):
 * - at most one provider request exists at any time, and a new one starts
 *   only after the previous one settled or the bounded cleanup gave up (then
 *   the chat ends);
 * - the decision "accepted or cancelled" and the in-memory commit happen in
 *   the same synchronous step; afterwards storage is awaited to completion
 *   before the chat can exit, so an interrupt during persistence only
 *   requests the exit;
 * - lines that arrive meanwhile wait in the input and are processed in order.
 */
import { PROGRAM_NAME } from "../args.js";
import { describeStorageFailure } from "../application/session.js";
import type { ChatSession } from "../application/session.js";
import { usageReport } from "../application/usage-report.js";
import { EXIT_CANCELLED, ProviderError, isAbortError } from "../domain/errors.js";
import { snapshotRequest } from "../domain/generation.js";
import type { GenerationOutcome, TokenUsage } from "../domain/generation.js";
import type { Provider } from "../domain/provider.js";
import type { ResolvedSettings } from "../domain/settings.js";
import { styleInstructions } from "../domain/settings.js";
import { formatUsage } from "../help.js";
import { EXIT_OK, write } from "../io.js";
import type { Io } from "../io.js";
import type { LineInput } from "../line-input.js";
import { displayPath } from "../storage/fs/errors.js";
import {
  AI_PREFIX,
  NOTICE_CLEANUP_CANCELLED,
  NOTICE_GOODBYE,
  NOTICE_HISTORY_DISABLED,
  NOTICE_NO_SAVED,
  NOTICE_REQUEST_CANCELLED,
  NOTICE_RESET_MEMORY,
  NOTICE_RESET_SAVED,
  USER_PROMPT,
  cleanupQuestion,
  helpText,
  isCleanupConfirmation,
  localMinute,
  parseCommand,
} from "./commands.js";



export interface PlainChatOptions {
  /** First banner line, e.g. `NeuroBräu TypeScript CLI 0.2.0-dev`. */
  readonly title: string;
  readonly session: ChatSession;
  readonly provider: Provider;
  readonly settings: ResolvedSettings;
  readonly warnings: readonly string[];
  readonly io: Io;
  readonly input: LineInput;
  readonly showUsage: boolean;
  /** Longest wait for a cancelled request to settle before the chat ends. */
  readonly cleanupTimeoutMs: number;
}

type Phase = "busy" | "idle" | "confirming" | "generating" | "cancelling";

type Next = { readonly kind: "line"; readonly text: string } | { readonly kind: "eof" } | { readonly kind: "interrupted" };

type Settled =
  | { readonly kind: "outcome"; readonly outcome: GenerationOutcome }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "stuck" };

export class PlainChat {
  private phase: Phase = "busy";
  private exitRequested = false;
  private waiter: AbortController | undefined;
  private generation: AbortController | undefined;

  constructor(private readonly options: PlainChatOptions) {}

  /** Read through a method: the flag changes across awaits, which control-flow analysis cannot see. */
  private exitWanted(): boolean {
    return this.exitRequested;
  }

  /** Called by the executable's interrupt wiring; safe at any time. */
  interrupt(): void {
    switch (this.phase) {
      case "generating":
        this.phase = "cancelling";
        this.generation?.abort();
        break;
      case "idle":
      case "confirming":
        this.exitRequested = true;
        this.waiter?.abort();
        break;
      case "cancelling":
        break; // already cancelling; repeats are absorbed
      case "busy":
        this.exitRequested = true;
        break;
    }
  }

  async run(): Promise<number> {
    await this.printBanner();
    for (;;) {
      if (this.exitWanted()) return this.interrupted();
      await this.out(USER_PROMPT);
      if (this.exitWanted()) return this.interrupted();
      const next = await this.nextLine("idle");
      if (next.kind === "interrupted") return this.interrupted();
      if (next.kind === "eof") {
        await this.out(`\n${NOTICE_GOODBYE}\n`);
        return EXIT_OK;
      }
      const text = next.text.trim();
      if (text === "") continue;
      const command = parseCommand(text);
      const result = command === undefined ? await this.send(text) : await this.command(command);
      if (result !== undefined) return result;
      if (this.exitWanted()) return this.interrupted();
    }
  }

  private async printBanner(): Promise<void> {
    const { session, settings, title } = this.options;
    await this.out(
      `${title}\nProvider: ${settings.provider} | Model: ${settings.model}\nType /help for commands, /exit to quit.\n\n`,
    );
    for (const warning of this.options.warnings) await this.warn(warning);
    const restored = session.restoredNotice;
    if (restored !== undefined) {
      await this.out(
        `Restored conversation from ${localMinute(restored.updatedAt)} (${String(restored.messageCount)} messages). Type /reset to start a new one.\n\n`,
      );
    }
  }

  // ----- commands -----

  /** Runs a command; a number ends the chat with that exit code. */
  private async command(name: string): Promise<number | undefined> {
    const { session } = this.options;
    switch (name) {
      case "exit":
        await this.out(`${NOTICE_GOODBYE}\n`);
        return EXIT_OK;
      case "help":
        await this.out(`${helpText(session.persistent)}\n`);
        return undefined;
      case "usage":
        await this.out(`${usageReport(session.snapshot().requests)}\n`);
        return undefined;
      case "reset": {
        const { warnings } = await session.reset();
        await this.out(`${session.persistent ? NOTICE_RESET_SAVED : NOTICE_RESET_MEMORY}\n`);
        for (const warning of warnings) await this.warn(warning);
        return undefined;
      }
      case "cleanup":
        return this.cleanup();
      default:
        await this.out(`Unknown command: /${displayPath(name)}. Type /help for commands.\n`);
        return undefined;
    }
  }

  /** Deletes saved conversations after the next line confirms; that line is never sent or run. */
  private async cleanup(): Promise<number | undefined> {
    const { session } = this.options;
    const directory = session.historyDirectory;
    if (directory === undefined) {
      await this.out(`${NOTICE_HISTORY_DISABLED}\n`);
      return undefined;
    }
    let count: number;
    try {
      count = await session.countSaved();
    } catch (error: unknown) {
      return this.storageError(error);
    }
    if (count === 0) {
      await this.out(`${NOTICE_NO_SAVED}\n`);
      return undefined;
    }
    await this.out(cleanupQuestion(count, displayPath(directory)));
    const answer = await this.nextLine("confirming");
    if (answer.kind === "interrupted") {
      await this.out(`\n${NOTICE_CLEANUP_CANCELLED}\n`);
      return this.interrupted();
    }
    if (answer.kind === "eof") {
      // Cancels; the main loop then meets the same end of input and exits 0.
      await this.out(`\n${NOTICE_CLEANUP_CANCELLED}\n`);
      return undefined;
    }
    if (!isCleanupConfirmation(answer.text)) {
      await this.out(`${NOTICE_CLEANUP_CANCELLED}\n`);
      return undefined;
    }
    const outcome = await session.cleanup();
    if (outcome.kind === "deleted") {
      await this.out(`Deleted ${String(outcome.deleted)} saved conversation(s). Started a new conversation.\n`);
    } else if (outcome.kind === "failed") {
      await this.err(
        `error: ${outcome.warning} Deleted ${String(outcome.deleted)} saved conversation(s) before the failure; they cannot be restored.\n`,
      );
    }
    return undefined;
  }

  // ----- messages -----

  private async send(text: string): Promise<number | undefined> {
    const { session, provider, settings, io } = this.options;
    const controller = new AbortController();
    const instructions = styleInstructions(settings.answerStyle.value);
    const request = snapshotRequest({
      model: settings.model,
      messages: session.messagesFor(text),
      reasoning: settings.reasoning,
      ...(settings.maxOutputTokens.value === undefined ? {} : { maxOutputTokens: settings.maxOutputTokens.value }),
      ...(instructions === undefined ? {} : { instructions }),
    });
    this.generation = controller;
    this.phase = "generating";
    let settled: Settled;
    try {
      // `Promise.resolve().then` keeps a synchronous throw of the provider a rejection like any other.
      settled = await this.settle(
        Promise.resolve().then(() => provider.generate(request, controller.signal)),
        controller.signal,
      );
    } finally {
      this.generation = undefined;
    }
    // From here to the commit there is no await: cancellation either already won or cannot any more.
    if (settled.kind === "stuck") {
      await write(io.stderr, `${PROGRAM_NAME}: interrupted\n`);
      return EXIT_CANCELLED;
    }
    if (controller.signal.aborted) {
      this.phase = "busy";
      // A leading newline, as the references: the terminal echoes ^C without one.
      await this.err(`\n${NOTICE_REQUEST_CANCELLED}\n`);
      return undefined;
    }
    if (settled.kind === "error") {
      this.phase = "busy";
      return this.requestError(settled.error);
    }
    const { outcome } = settled;
    this.phase = "busy";
    if (outcome.kind === "completed") {
      session.applyCompleted(text, outcome.result);
      const warnings = await session.persist();
      await this.out(`${AI_PREFIX}${outcome.result.text}\n`);
      await this.reportUsage(outcome.result.usage);
      for (const warning of warnings) await this.warn(warning);
      return undefined;
    }
    const persist = session.applyIncomplete(outcome);
    const warnings = persist ? await session.persist() : [];
    if (outcome.partialText !== "") await this.out(`${AI_PREFIX}${outcome.partialText}\n`);
    const unsaved = outcome.partialText === "" ? "" : " The partial response was not saved.";
    await this.warn(`Response incomplete: ${outcome.reason}.${unsaved}`);
    await this.reportUsage(outcome.usage);
    for (const warning of warnings) await this.warn(warning);
    return undefined;
  }

  /**
   * Waits for the request. After an abort it waits at most the cleanup bound;
   * a provider that ignores the abort ends the chat. The returned promise
   * never rejects, so a late settlement can never surface as an unhandled one.
   */
  private async settle(operation: Promise<GenerationOutcome>, signal: AbortSignal): Promise<Settled> {
    const finished: Promise<Settled> = operation.then(
      (outcome): Settled => ({ kind: "outcome", outcome }),
      (error: unknown): Settled => ({ kind: "error", error }),
    );
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const gaveUp = new Promise<Settled>((resolve) => {
      onAbort = () => {
        timer = setTimeout(() => {
          resolve({ kind: "stuck" });
        }, this.options.cleanupTimeoutMs);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([finished, gaveUp]);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  private async requestError(error: unknown): Promise<number | undefined> {
    if (error instanceof ProviderError) {
      await this.err(`error: ${error.message}\n`);
      return undefined;
    }
    if (isAbortError(error)) {
      await this.err("error: The request was aborted.\n");
      return undefined;
    }
    throw error;
  }

  private async reportUsage(usage: TokenUsage | undefined): Promise<void> {
    if (this.options.showUsage) await this.err(`${formatUsage(usage)}\n`);
  }

  private async storageError(error: unknown): Promise<undefined> {
    const description = describeStorageFailure(error);
    if (description === undefined) throw error;
    await this.err(`error: ${description}\n`);
    return undefined;
  }

  // ----- input and output -----

  private async nextLine(phase: "idle" | "confirming"): Promise<Next> {
    if (this.exitRequested) return { kind: "interrupted" };
    const controller = new AbortController();
    this.waiter = controller;
    this.phase = phase;
    try {
      const line = await this.options.input.readLine(controller.signal);
      // A Ctrl+C that arrived together with the line wins: the chat is exiting anyway.
      if (controller.signal.aborted) return { kind: "interrupted" };
      return line === undefined ? { kind: "eof" } : { kind: "line", text: line };
    } catch (error: unknown) {
      if (isAbortError(error) && controller.signal.aborted) return { kind: "interrupted" };
      throw error;
    } finally {
      this.waiter = undefined;
      this.phase = "busy";
    }
  }

  private async interrupted(): Promise<number> {
    await this.out(`\n${NOTICE_GOODBYE}\n`);
    return EXIT_CANCELLED;
  }

  private out(text: string): Promise<void> {
    return write(this.options.io.stdout, text);
  }

  private err(text: string): Promise<void> {
    return write(this.options.io.stderr, text);
  }

  private warn(message: string): Promise<void> {
    return this.err(`warning: ${message}\n`);
  }
}
