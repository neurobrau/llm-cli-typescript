/**
 * The fullscreen chat controller: owns the visible entries, the request
 * identity and every state change. All of it runs on the one JavaScript
 * thread; "serialized" here means that decisions which must not interleave
 * (retire a request / commit its result) are made in synchronous code with no
 * `await` in between.
 *
 * Request ownership
 * - At most one provider operation exists. A new one can start only when the
 *   phase is `idle`, i.e. the previous operation settled (or its bounded
 *   cleanup gave up, which ends the program with exit 130).
 * - Cancelling retires the request first (`retired`), then aborts it. A
 *   retired request can no longer display text or commit anything.
 * - A result is accepted only after the stream was closed successfully
 *   (`consumeStream` guarantees it); acceptance and `applyCompleted` happen in
 *   one synchronous step. Storage is awaited afterwards in phase `saving`;
 *   exiting waits for it.
 *
 * Nothing here touches process, fs or terminal APIs: the terminal, timers and
 * the provider are injected.
 */
import { STREAM_UNCLOSED, consumeStream } from "../application/stream-consumer.js";
import type { StreamConsumption } from "../application/stream-consumer.js";
import { describeStorageFailure } from "../application/session.js";
import type { ChatSession } from "../application/session.js";
import { usageReport } from "../application/usage-report.js";
import {
  NOTICE_CLEANUP_CANCELLED,
  NOTICE_HISTORY_DISABLED,
  NOTICE_NO_SAVED,
  NOTICE_RESET_MEMORY,
  NOTICE_RESET_SAVED,
  cleanupQuestion,
  isCleanupConfirmation,
  localMinute,
  parseCommand,
} from "../chat/commands.js";
import { ProviderError, isAbortError } from "../domain/errors.js";
import { snapshotRequest } from "../domain/generation.js";
import type {
  GenerationOutcome,
  GenerationRequest,
  GenerationResult,
  IncompleteGeneration,
  StreamMetadata,
  TerminalStreamEvent,
} from "../domain/generation.js";
import type { Provider } from "../domain/provider.js";
import type { ResolvedSettings } from "../domain/settings.js";
import { styleInstructions } from "../domain/settings.js";
import { EXIT_FAILURE, EXIT_OK, OutputError, hasErrorCode } from "../io.js";
import { displayPath } from "../storage/fs/errors.js";
import { KeyDecoder } from "./keys.js";
import type { Key } from "./keys.js";
import { TuiModel } from "./model.js";
import type { Entry } from "./model.js";
import { panelStats } from "./panel.js";
import { renderFrame } from "./render.js";
import { doneStatus, ready, warning } from "./status.js";
import type { RuntimeStatus } from "./status.js";
import { TerminalError } from "./terminal.js";
import type { Terminal, Timers, TimerHandle } from "./terminal.js";
import {
  NOTICE_BUSY,
  NOTICE_BUSY_SETTINGS,
  NOTICE_INPUT_FULL,
  NOTICE_MENUS_PENDING,
  NOTICE_NOT_SAVED,
  NOTICE_STILL_CLOSING,
  NOTICE_WORKING,
  TUI_HELP,
} from "./texts.js";

/** Exit codes of the interactive interface. */
export const EXIT_SIGINT = 130;
export const EXIT_SIGHUP = 129;
export const EXIT_SIGTERM = 143;
export const EXIT_BROKEN_PIPE = 141;

/** Events applied before the loop is yielded to (the bounded handoff of the reference). */
export const EVENTS_PER_YIELD = 256;

const EXIT_NOW_DIAGNOSTIC = "an internal error occurred";

export interface TuiOptions {
  /** `NeuroBräu TypeScript CLI <version>`. */
  readonly title: string;
  readonly session: ChatSession;
  readonly provider: Provider;
  readonly settings: ResolvedSettings;
  readonly warnings: readonly string[];
  readonly terminal: Terminal;
  readonly timers: Timers;
  readonly stream: boolean;
  /** Longest wait for a cancelled or finished operation to close before the program exits. */
  readonly cleanupTimeoutMs: number;
  readonly maxInput?: number;
  readonly flashMs?: number;
  readonly escapeMs?: number;
  readonly tickMs?: number;
}

/** How the interface ended; the diagnostic (safe fixed text) is printed after the terminal is restored. */
export interface TuiResult {
  readonly code: number;
  readonly diagnostic?: string;
}

type Phase = "idle" | "generating" | "cancelling" | "saving" | "working";

interface ActiveRequest {
  readonly id: number;
  readonly prompt: string;
  readonly streaming: boolean;
  readonly abort: AbortController;
  readonly startedAt: number;
  /** Set (synchronously, before the abort) when the user or the program gave the request up. */
  retired: boolean;
  text: string;
  firstTextAt: number | undefined;
  entry: Entry | undefined;
}

type Settled =
  | { readonly kind: "outcome"; readonly outcome: GenerationOutcome }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "stuck" };

type Finished =
  | { readonly kind: "completed"; readonly result: GenerationResult; readonly metadata?: StreamMetadata | undefined }
  | ({ readonly kind: "incomplete"; readonly metadata?: StreamMetadata | undefined } & IncompleteGeneration)
  | { readonly kind: "failed"; readonly error: ProviderError };

export class TuiController {
  private readonly model: TuiModel;
  private readonly decoder = new KeyDecoder();
  private phase: Phase = "idle";
  private request: ActiveRequest | undefined;
  private requestSeq = 0;
  private inflight: Promise<void> | undefined;
  private exit: TuiResult | undefined;
  private stuck = false;
  private disposed = false;
  private finish: (result: TuiResult) => void = () => undefined;
  private readonly done: Promise<TuiResult>;
  private dirty = false;
  private scheduled = false;
  private drawing: Promise<void> | undefined;
  private sinceYield = 0;
  private ticker: TimerHandle | undefined;
  private flashTimer: TimerHandle | undefined;
  private escapeTimer: TimerHandle | undefined;

  constructor(private readonly options: TuiOptions) {
    this.model = new TuiModel({ rows: 0, cols: 0 }, options.maxInput);
    this.done = new Promise<TuiResult>((resolve) => {
      this.finish = resolve;
    });
  }

  /** Runs until the interface exits; the terminal is restored before this resolves. */
  async run(): Promise<TuiResult> {
    const { terminal } = this.options;
    try {
      terminal.open({
        onData: (chunk) => { this.guard(() => { this.onData(chunk); }); },
        onResize: () => { this.guard(() => { this.onResize(); }); },
        onEnd: () => { this.guard(() => { this.requestExit({ code: EXIT_OK }); }); },
      });
    } catch (error: unknown) {
      this.disposed = true;
      await terminal.close();
      return { code: EXIT_FAILURE, diagnostic: error instanceof TerminalError ? error.message : "could not initialize the terminal" };
    }
    let result: TuiResult;
    try {
      this.guard(() => {
        this.model.size = terminal.size();
        this.populate();
        this.requestDraw(true);
      });
      result = await this.done;
    } finally {
      this.dispose();
      await this.settleDrawing();
      await terminal.close();
    }
    return result;
  }

  // ----- external events -----

  /** An externally delivered SIGINT: the same rules as the Ctrl+C key. */
  interrupt(): void {
    this.guard(() => { this.ctrlC(); });
  }

  /** SIGTERM / SIGHUP: leave at once (cancelling any request), with the conventional code. */
  terminate(code: number): void {
    this.guard(() => { this.requestExit({ code }); });
  }

  // ----- guards and exit -----

  private guard(action: () => void): void {
    if (this.disposed) return;
    try {
      action();
    } catch (error: unknown) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (error instanceof OutputError) {
      if (hasErrorCode(error.cause, "EPIPE")) {
        this.requestExit({ code: EXIT_BROKEN_PIPE });
      } else {
        this.requestExit({ code: EXIT_FAILURE, diagnostic: "cannot write output" });
      }
      return;
    }
    if (error instanceof TerminalError) {
      this.requestExit({ code: EXIT_FAILURE, diagnostic: error.message });
      return;
    }
    this.requestExit({ code: EXIT_FAILURE, diagnostic: EXIT_NOW_DIAGNOSTIC });
  }

  /** The first request wins; everything else is shut down in order and then the run resolves. */
  private requestExit(result: TuiResult): void {
    if (this.exit !== undefined) return;
    this.exit = result;
    const request = this.request;
    if (request !== undefined && !request.retired) this.retire(request);
    this.escapeTimer?.cancel();
    void this.shutdown();
  }

  private async shutdown(): Promise<void> {
    // The operation in flight (a cancelled request, a save, a storage command) settles first:
    // a save that was already committed is finished, never abandoned.
    await this.inflight;
    const planned = this.exit ?? { code: EXIT_FAILURE };
    const code = this.stuck && planned.code === EXIT_OK ? EXIT_SIGINT : planned.code;
    this.finish({ ...planned, code });
  }

  private dispose(): void {
    this.disposed = true;
    this.ticker?.cancel();
    this.flashTimer?.cancel();
    this.escapeTimer?.cancel();
  }

  // ----- input -----

  private onData(chunk: Uint8Array | string): void {
    if (this.exit !== undefined) return;
    this.escapeTimer?.cancel();
    this.escapeTimer = undefined;
    for (const key of this.decoder.feed(chunk)) {
      if (this.exiting()) return;
      this.handleKey(key);
    }
    if (this.decoder.pendingEscape && !this.exiting()) {
      this.escapeTimer = this.options.timers.after(this.options.escapeMs ?? 25, () => {
        this.guard(() => { this.decoder.dropEscape(); });
      });
    }
    this.requestDraw(true);
  }

  private onResize(): void {
    if (this.exit !== undefined) return;
    this.model.size = this.options.terminal.size();
    this.requestDraw(true);
  }

  /** Read through a method: the exit is requested while keys are handled, which control-flow analysis cannot see. */
  private exiting(): boolean {
    return this.exit !== undefined;
  }

  private busy(): boolean {
    return this.phase !== "idle";
  }

  private handleKey(key: Key): void {
    this.model.releaseTransient();
    if (key.kind === "ignored") return;
    if (key.kind === "text") {
      if (!this.model.editor.insert(key.text)) this.flash(warning(NOTICE_INPUT_FULL));
      return;
    }
    const { editor } = this.model;
    switch (key.name) {
      case "enter": this.submit(); break;
      case "backspace": editor.backspace(); break;
      case "delete": editor.delete(); break;
      case "left": editor.left(); break;
      case "right": editor.right(); break;
      case "home":
      case "ctrl-a": editor.home(); break;
      case "end":
      case "ctrl-e": editor.end(); break;
      case "ctrl-u": editor.clear(); break;
      case "up": this.model.scrollBy(1); break;
      case "down": this.model.scrollBy(-1); break;
      case "pageup": this.model.scrollBy(this.model.pageSize()); break;
      case "pagedown": this.model.scrollBy(-this.model.pageSize()); break;
      case "f1": this.append("info", TUI_HELP); this.model.scroll = 0; break;
      case "f2":
      case "f3":
      case "f4":
      case "f5":
      case "f6":
        if (this.busy()) this.flash(warning(NOTICE_BUSY_SETTINGS));
        else this.model.status = warning(NOTICE_MENUS_PENDING);
        break;
      case "ctrl-c": this.ctrlC(); break;
      case "ctrl-d":
        if (!this.busy() && editor.isEmpty) this.requestExit({ code: EXIT_OK });
        break;
    }
  }

  private ctrlC(): void {
    if (this.exit !== undefined) return;
    switch (this.phase) {
      case "generating":
        if (this.request !== undefined) this.cancelRequest(this.request);
        break;
      case "cancelling":
        break; // already cancelling; repeats are absorbed
      case "idle":
      case "saving":
      case "working":
        this.requestExit({ code: EXIT_SIGINT });
        break;
    }
  }

  private flash(status: RuntimeStatus): void {
    const { timers } = this.options;
    const duration = this.options.flashMs ?? 2000;
    this.model.flashStatus(status, timers.now(), duration);
    this.flashTimer?.cancel();
    this.flashTimer = timers.after(duration, () => {
      this.guard(() => {
        this.model.flash = undefined;
        this.requestDraw(true);
      });
    });
  }

  // ----- submitting -----

  private submit(): void {
    const text = this.model.editor.text.trim();
    if (this.busy()) {
      this.submitWhileBusy(text);
      return;
    }
    this.model.editor.clear();
    if (text === "") return;
    this.model.scroll = 0;
    if (this.model.confirmingCleanup) {
      this.confirmCleanup(text);
      return;
    }
    const command = parseCommand(text);
    if (command === undefined) this.send(text);
    else this.command(command);
  }

  /** Only /exit, /help and /usage work during a request; anything else keeps the draft and warns. */
  private submitWhileBusy(text: string): void {
    const command = parseCommand(text);
    if (command === "exit") {
      this.model.editor.clear();
      this.requestExit({ code: EXIT_OK });
    } else if (command === "help" || command === "usage") {
      this.model.editor.clear();
      this.append("info", command === "help" ? TUI_HELP : usageReport(this.options.session.snapshot().requests));
      this.model.scroll = 0;
    } else if (text !== "") {
      const notice = this.phase === "cancelling" ? NOTICE_STILL_CLOSING : this.phase === "generating" ? NOTICE_BUSY : NOTICE_WORKING;
      this.flash(warning(notice));
    }
  }

  private command(name: string): void {
    const { session } = this.options;
    switch (name) {
      case "exit":
        this.requestExit({ code: EXIT_OK });
        break;
      case "help":
        this.append("info", TUI_HELP);
        break;
      case "usage":
        this.append("info", usageReport(session.snapshot().requests));
        break;
      case "reset":
        this.work(async () => {
          const { warnings } = await session.reset();
          this.clearPanel(session.persistent ? NOTICE_RESET_SAVED : NOTICE_RESET_MEMORY);
          this.model.status = ready("New conversation started");
          this.showWarnings(warnings);
        });
        break;
      case "cleanup":
        this.work(() => this.startCleanup());
        break;
      default:
        this.append("error", `Unknown command: /${displayPath(name)}. Type /help for commands.`);
    }
  }

  private async startCleanup(): Promise<void> {
    const { session } = this.options;
    const directory = session.historyDirectory;
    if (directory === undefined) {
      this.append("info", NOTICE_HISTORY_DISABLED);
      return;
    }
    let count: number;
    try {
      count = await session.countSaved();
    } catch (error: unknown) {
      this.storageError(error);
      return;
    }
    if (count === 0) {
      this.append("info", NOTICE_NO_SAVED);
      return;
    }
    this.append("info", cleanupQuestion(count, displayPath(directory)));
    this.model.confirmingCleanup = true;
  }

  /** The line after a cleanup question is its answer: never a message and never a command. */
  private confirmCleanup(answer: string): void {
    this.model.confirmingCleanup = false;
    if (!isCleanupConfirmation(answer)) {
      this.append("info", NOTICE_CLEANUP_CANCELLED);
      return;
    }
    this.work(async () => {
      const outcome = await this.options.session.cleanup();
      if (outcome.kind === "deleted") {
        this.clearPanel(`Deleted ${String(outcome.deleted)} saved conversation(s). Started a new conversation.`);
        this.model.status = ready("Saved conversations deleted");
      } else if (outcome.kind === "failed") {
        const message = `${outcome.warning} Deleted ${String(outcome.deleted)} saved conversation(s) before the failure; they cannot be restored.`;
        this.append("error", `Error: ${message}`);
        this.model.status = { state: "ERROR", parts: [message] };
      } else {
        this.append("info", NOTICE_HISTORY_DISABLED);
      }
    });
  }

  private storageError(error: unknown): void {
    const description = describeStorageFailure(error);
    if (description === undefined) throw error;
    this.append("error", `Error: ${description}`);
    this.model.status = { state: "ERROR", parts: [description] };
  }

  private showWarnings(warnings: readonly string[]): void {
    for (const message of warnings) this.append("error", `Warning: ${message}`);
    if (warnings.length > 0) this.model.status = warning("Conversation not saved");
  }

  /** A storage command: blocks submissions until it is done; exiting waits for it. */
  private work(task: () => Promise<void>): void {
    this.phase = "working";
    const run = (async (): Promise<void> => {
      try {
        await task();
      } catch (error: unknown) {
        this.fail(error);
      } finally {
        if (this.phase === "working") this.phase = "idle";
        this.refreshStats();
        this.requestDraw(true);
      }
    })();
    this.inflight = run;
  }

  // ----- requests -----

  private send(text: string): void {
    const { session, settings, provider, timers } = this.options;
    const instructions = styleInstructions(settings.answerStyle.value);
    // The immutable snapshot is taken now, from committed history plus this prompt only.
    const snapshot = snapshotRequest({
      model: settings.model,
      messages: session.messagesFor(text),
      reasoning: settings.reasoning,
      ...(settings.maxOutputTokens.value === undefined ? {} : { maxOutputTokens: settings.maxOutputTokens.value }),
      ...(instructions === undefined ? {} : { instructions }),
    });
    this.requestSeq += 1;
    const request: ActiveRequest = {
      id: this.requestSeq,
      prompt: text,
      streaming: this.options.stream,
      abort: new AbortController(),
      startedAt: timers.now(),
      retired: false,
      text: "",
      firstTextAt: undefined,
      entry: undefined,
    };
    this.request = request;
    this.phase = "generating";
    this.sinceYield = 0;
    this.append("user", text);
    this.model.live = { startedAt: request.startedAt, streaming: request.streaming, firstTextAt: undefined, thinking: false };
    this.ticker?.cancel();
    this.ticker = timers.every(this.options.tickMs ?? 100, () => { this.guard(() => { this.requestDraw(true); }); });
    this.inflight = (request.streaming ? this.runStream(request, provider, snapshot) : this.runGenerate(request, provider, snapshot)).then(
      undefined,
      (error: unknown) => { this.fail(error); },
    );
  }

  private async runStream(request: ActiveRequest, provider: Provider, snapshot: GenerationRequest): Promise<void> {
    const consumed = await consumeStream(
      (own) => provider.stream(snapshot, own),
      request.abort.signal,
      (delta) => this.onDelta(request, delta),
      this.options.cleanupTimeoutMs,
      () => { this.onReasoning(request); },
    );
    // No await from the identity check to the commit inside `finishStream`.
    const saving = this.finishStream(request, consumed);
    this.requestDraw(true);
    if (saving !== undefined) await saving;
  }

  private async runGenerate(request: ActiveRequest, provider: Provider, snapshot: GenerationRequest): Promise<void> {
    const settled = await this.settleBounded(
      Promise.resolve().then(() => provider.generate(snapshot, request.abort.signal)),
      request.abort.signal,
    );
    const saving = this.finishGenerate(request, settled);
    this.requestDraw(true);
    if (saving !== undefined) await saving;
  }

  /** Waits for the operation; after an abort, at most the cleanup bound. Never rejects. */
  private settleBounded(operation: Promise<GenerationOutcome>, signal: AbortSignal): Promise<Settled> {
    const finished: Promise<Settled> = operation.then(
      (outcome): Settled => ({ kind: "outcome", outcome }),
      (error: unknown): Settled => ({ kind: "error", error }),
    );
    return new Promise<Settled>((resolve) => {
      let timer: TimerHandle | undefined;
      const onAbort = (): void => {
        timer = this.options.timers.after(this.options.cleanupTimeoutMs, () => { resolve({ kind: "stuck" }); });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      void finished.then((settled) => {
        timer?.cancel();
        signal.removeEventListener("abort", onAbort);
        resolve(settled);
      });
    });
  }

  private async onDelta(request: ActiveRequest, delta: string): Promise<void> {
    if (request.retired || this.exit !== undefined) return;
    if (request.firstTextAt === undefined) {
      request.firstTextAt = this.options.timers.now();
      if (this.model.live !== undefined) this.model.live.firstTextAt = request.firstTextAt;
    }
    request.text += delta;
    this.showAnswer(request);
    this.requestDraw(false);
    this.sinceYield += 1;
    if (this.sinceYield >= EVENTS_PER_YIELD) {
      this.sinceYield = 0;
      await this.flushDraws();
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
  }

  private onReasoning(request: ActiveRequest): void {
    if (request.retired || this.exit !== undefined) return;
    if (this.model.live !== undefined) this.model.live.thinking = true; // status only; the text never reaches us
    this.requestDraw(false);
  }

  /** The answer entry grows in place; a reader who scrolled up keeps their view. */
  private showAnswer(request: ActiveRequest, text: string = request.text): void {
    this.model.anchored(() => {
      if (request.entry === undefined) request.entry = this.model.add("ai", text);
      else request.entry.text = text;
    });
  }

  private cancelRequest(request: ActiveRequest): void {
    this.retire(request);
    this.phase = "cancelling";
    const shown = request.text !== "";
    this.append("error", `${request.streaming ? "Cancelled." : "Request cancelled."}${shown ? NOTICE_NOT_SAVED : ""}`);
    this.model.status = { state: "CANCELLED", parts: shown ? ["Partial response not saved"] : [] };
    this.model.afterTransient = undefined;
  }

  /** Retires the identity first, then aborts: nothing of this request is shown or committed any more. */
  private retire(request: ActiveRequest): void {
    request.retired = true;
    this.model.live = undefined;
    this.ticker?.cancel();
    this.ticker = undefined;
    request.abort.abort();
  }

  private finishStream(request: ActiveRequest, consumed: StreamConsumption): Promise<void> | undefined {
    const { end } = consumed;
    if (end.kind === "output-error") {
      this.endRequest(request);
      throw end.error; // nothing is committed; the interface ends with the output failure
    }
    if (request.retired || this.exit !== undefined || end.kind === "cancelled" || end.kind === "stuck") {
      return this.endCancelled(request, end.kind === "stuck");
    }
    if (end.kind === "unclosed") {
      this.endRequest(request);
      this.append("error", `Error: ${STREAM_UNCLOSED}`);
      this.requestExit({ code: EXIT_FAILURE, diagnostic: STREAM_UNCLOSED });
      return undefined;
    }
    return this.accept(request, end.event);
  }

  private finishGenerate(request: ActiveRequest, settled: Settled): Promise<void> | undefined {
    if (request.retired || this.exit !== undefined || settled.kind === "stuck") {
      return this.endCancelled(request, settled.kind === "stuck");
    }
    if (settled.kind === "error") {
      const { error } = settled;
      if (error instanceof ProviderError) return this.accept(request, { kind: "failed", error, partialText: "" });
      if (isAbortError(error)) {
        return this.accept(request, { kind: "failed", error: new ProviderError("The request was aborted.", "api"), partialText: "" });
      }
      this.endRequest(request);
      throw error;
    }
    const { outcome } = settled;
    if (outcome.kind === "completed") return this.accept(request, { kind: "completed", result: outcome.result });
    return this.accept(request, outcome);
  }

  private endRequest(request: ActiveRequest): void {
    this.model.live = undefined;
    this.ticker?.cancel();
    this.ticker = undefined;
    if (this.request === request) this.request = undefined;
  }

  private endCancelled(request: ActiveRequest, stuck: boolean): Promise<void> | undefined {
    this.endRequest(request);
    if (stuck) {
      this.stuck = true;
      this.phase = "idle";
      this.requestExit({ code: EXIT_SIGINT });
      return undefined;
    }
    if (this.phase === "cancelling" || this.phase === "generating") this.phase = "idle";
    this.requestDraw(true);
    return undefined;
  }

  /** Applies the single terminal result of a request. Synchronous; returns the save to await, if any. */
  private accept(request: ActiveRequest, finished: Finished | TerminalStreamEvent): Promise<void> | undefined {
    const { session, timers } = this.options;
    this.endRequest(request);
    const shown = request.text !== "" || (finished.kind === "incomplete" && finished.partialText !== "");
    const suffix = shown ? NOTICE_NOT_SAVED : "";
    const observed = (timers.now() - request.startedAt) / 1000;
    if (finished.kind === "completed") {
      session.applyCompleted(request.prompt, finished.result);
      this.showAnswer(request, finished.result.text);
      this.refreshStats();
      const first = request.streaming && request.firstTextAt !== undefined ? (request.firstTextAt - request.startedAt) / 1000 : undefined;
      // DONE is shown once the exchange is also saved, so it never invites a key press the save would refuse.
      const done = doneStatus(finished.metadata, finished.result.usage?.outputTokens, observed, first);
      this.phase = "saving";
      return this.save(done);
    }
    if (finished.kind === "incomplete") {
      if (!request.streaming && finished.partialText !== "") this.showAnswer(request, finished.partialText);
      const persist = session.applyIncomplete(finished);
      this.refreshStats();
      this.append("error", `Incomplete: ${finished.reason}.${suffix}`);
      const status = warning(`Response incomplete: ${finished.reason}`);
      this.model.afterTransient = undefined;
      if (persist) {
        this.phase = "saving";
        return this.save(status, true);
      }
      this.model.status = status;
      this.phase = "idle";
      return undefined;
    }
    this.append("error", `Error: ${finished.error.message}${suffix}`);
    this.model.status = { state: "ERROR", parts: [finished.error.message] };
    this.model.afterTransient = undefined;
    this.phase = "idle";
    return undefined;
  }

  /** Persists after a commit; a storage failure is a warning and never undoes the memory state. */
  private async save(final: RuntimeStatus, keepStatus = false): Promise<void> {
    const { session } = this.options;
    try {
      const warnings = await session.persist();
      this.model.status = final;
      if (warnings.length > 0) {
        for (const message of warnings) this.append("error", `Warning: ${message}`);
        if (!keepStatus) this.model.afterTransient = warning("Conversation not saved");
      } else if (session.persistent && !keepStatus) {
        this.model.afterTransient = ready("Conversation saved");
      }
    } finally {
      this.phase = "idle";
      this.requestDraw(true);
    }
  }

  // ----- entries and screen -----

  private populate(): void {
    const { session, warnings } = this.options;
    const snapshot = session.snapshot();
    for (const message of snapshot.messages) this.model.add(message.role === "user" ? "user" : "ai", message.content);
    for (const message of warnings) this.model.add("error", `Warning: ${message}`);
    const restored = session.restoredNotice;
    if (restored !== undefined) {
      this.model.add(
        "info",
        `Restored conversation from ${localMinute(restored.updatedAt)} (${String(restored.messageCount)} messages). Type /reset to start a new one.`,
      );
    }
    this.model.stats = panelStats(snapshot.requests);
  }

  private append(kind: "user" | "ai" | "info" | "error", text: string): void {
    this.model.anchored(() => { this.model.add(kind, text); });
  }

  private clearPanel(notice: string): void {
    this.model.clearEntries();
    this.model.add("info", notice);
    this.refreshStats();
  }

  private refreshStats(): void {
    this.model.stats = panelStats(this.options.session.snapshot().requests);
  }

  // ----- drawing: one frame at a time, coalesced, never more than one write pending -----

  private requestDraw(immediate: boolean): void {
    if (this.disposed) return;
    this.dirty = true;
    if (immediate) {
      this.startPump();
    } else if (!this.scheduled && this.drawing === undefined) {
      this.scheduled = true;
      setImmediate(() => {
        this.scheduled = false;
        this.guard(() => { this.startPump(); });
      });
    }
  }

  private startPump(): void {
    if (this.drawing !== undefined || this.disposed || !this.dirty) return;
    this.drawing = this.pump().then(undefined, (error: unknown) => { this.fail(error); }).finally(() => {
      this.drawing = undefined;
      if (this.dirty && !this.disposed) this.startPump();
    });
  }

  private async pump(): Promise<void> {
    while (this.dirty && !this.disposed) {
      this.dirty = false;
      const frame = renderFrame(this.model, { title: this.options.title, settings: this.options.settings, now: this.options.timers.now() });
      try {
        await this.options.terminal.draw(frame);
      } catch (error: unknown) {
        throw new OutputError(error); // so EPIPE ends quietly with 141 and other failures with a fixed text
      }
    }
  }

  private async flushDraws(): Promise<void> {
    if (this.dirty) this.startPump();
    while (this.drawing !== undefined) await this.drawing;
  }

  /** At the end: let a frame in progress finish, but never wait longer than the cleanup bound. */
  private async settleDrawing(): Promise<void> {
    const drawing = this.drawing;
    if (drawing === undefined) return;
    await new Promise<void>((resolve) => {
      const timer = this.options.timers.after(this.options.cleanupTimeoutMs, resolve);
      void drawing.then(() => { timer.cancel(); resolve(); });
    });
  }
}

