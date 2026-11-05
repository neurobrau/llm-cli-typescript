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
import { SwitchRefusal } from "../application/workspace.js";
import type { PreparedSwitch, Workspace } from "../application/workspace.js";
import { ProviderError, SettingsError, isAbortError } from "../domain/errors.js";
import { snapshotRequest } from "../domain/generation.js";
import type {
  GenerationOutcome,
  GenerationRequest,
  GenerationResult,
  IncompleteGeneration,
  StreamMetadata,
  TerminalStreamEvent,
} from "../domain/generation.js";
import { ANSWER_STYLES, styleInstructions } from "../domain/settings.js";
import type { AnswerStyle, ModelCapabilities } from "../domain/settings.js";
import type { Provider } from "../domain/provider.js";
import { EXIT_FAILURE, EXIT_OK, OutputError, hasErrorCode } from "../io.js";
import { displayPath } from "../storage/fs/errors.js";
import { computeLayout } from "./layout.js";
import { CUSTOM_ID, modelMenu, providerMenu, reasoningChoiceLabel, reasoningMenu, reasoningValueOf, styleMenu, tokensMenu } from "./menu-builders.js";
import { menuVisible } from "./menu.js";
import type { Menu } from "./menu.js";
import { parseTokenInput } from "./token-input.js";
import { KeyDecoder } from "./keys.js";
import type { Key } from "./keys.js";
import { TuiModel } from "./model.js";
import type { Entry } from "./model.js";
import { panelStats } from "./panel.js";
import { renderFrame } from "./render.js";
import { READY, doneStatus, ready, warning } from "./status.js";
import type { RuntimeStatus } from "./status.js";
import { TerminalError } from "./terminal.js";
import type { Terminal, Timers, TimerHandle } from "./terminal.js";
import {
  NOTICE_BUSY,
  NOTICE_BUSY_SETTINGS,
  NOTICE_INPUT_FULL,
  NOTICE_WAIT_CHECK,
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
  readonly workspace: Workspace;
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

type Phase = "idle" | "generating" | "cancelling" | "saving" | "working" | "checking";

/** A running discovery/preparation check; like a request it is retired before it is aborted. */
interface CheckOp {
  readonly abort: AbortController;
  retired: boolean;
}

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

type Settled<T> =
  | { readonly kind: "value"; readonly value: T }
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
  private check: CheckOp | undefined;
  /** Capabilities read for the open F4/F5 menu or custom prompt, used when the choice is applied. */
  private menuCapabilities: ModelCapabilities | undefined;
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

  private get workspace(): Workspace {
    return this.options.workspace;
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
      await this.boundedClose(terminal);
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
      await this.boundedClose(terminal);
    }
    return result;
  }

  /**
   * Restores the terminal, waiting for its flushed output at most the cleanup bound. The adapter
   * restores raw input and removes its listeners synchronously; only the final write can stall.
   */
  private async boundedClose(terminal: Terminal): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = this.options.timers.after(this.options.cleanupTimeoutMs, resolve);
      terminal.close().then(
        () => { timer.cancel(); resolve(); },
        () => { timer.cancel(); resolve(); }, // restoring is best effort; a failure is not reported twice
      );
    });
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
    if (this.check !== undefined && !this.check.retired) this.retireCheck(this.check);
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
        this.guard(() => {
          this.escapeTimer = undefined;
          for (const key of this.decoder.dropEscape()) {
            if (this.exiting()) return;
            this.handleKey(key);
          }
          this.requestDraw(true);
        });
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
    if (this.model.menu !== undefined) {
      this.handleMenuKey(this.model.menu, key); // modal: nothing reaches the draft
      return;
    }
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
        this.settingsKey(key.name);
        break;
      case "escape":
        if (this.model.prompt !== undefined) this.cancelPrompt();
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
      case "checking":
        if (this.check !== undefined) this.cancelCheck(this.check);
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
    if (this.model.prompt !== undefined) {
      this.submitPrompt(text);
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
      this.append("info", command === "help" ? TUI_HELP : usageReport(this.workspace.session.snapshot().requests));
      this.model.scroll = 0;
    } else if (text !== "") {
      this.flash(warning(this.busyNotice(NOTICE_BUSY)));
    }
  }

  private command(name: string): void {
    const { session } = this.workspace;
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
    const { session } = this.workspace;
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
      const outcome = await this.workspace.session.cleanup();
      if (outcome.kind === "deleted") {
        this.workspace.forgetOthers(); // nothing remembered in memory may come back after the files are gone
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
    const { session, settings, provider } = this.workspace;
    const { timers } = this.options;
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
      () => this.onReasoning(request),
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
  private settleBounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<Settled<T>> {
    const finished: Promise<Settled<T>> = operation.then(
      (value): Settled<T> => ({ kind: "value", value }),
      (error: unknown): Settled<T> => ({ kind: "error", error }),
    );
    return new Promise<Settled<T>>((resolve) => {
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
    await this.budget(request);
  }

  private async onReasoning(request: ActiveRequest): Promise<void> {
    if (request.retired || this.exit !== undefined) return;
    if (this.model.live !== undefined) this.model.live.thinking = true; // status only; the text never reaches us
    this.requestDraw(false);
    await this.budget(request);
  }

  /**
   * Every provider event, text or reasoning, spends the same budget. After EVENTS_PER_YIELD of them the
   * loop is yielded to so queued keys, signals, timers and resizes run, and the frame in flight is awaited -
   * but never past a cancellation: a stalled terminal must not keep a retired request from being closed.
   */
  private async budget(request: ActiveRequest): Promise<void> {
    this.sinceYield += 1;
    if (this.sinceYield < EVENTS_PER_YIELD) return;
    this.sinceYield = 0;
    await this.untilRetired(request, this.flushDraws());
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }

  /** Resolves when `work` settles or the request is retired, whichever comes first. */
  private untilRetired(request: ActiveRequest, work: Promise<void>): Promise<void> {
    const { signal } = request.abort;
    return new Promise<void>((resolve) => {
      const release = (): void => {
        signal.removeEventListener("abort", release);
        resolve();
      };
      if (signal.aborted) release();
      else signal.addEventListener("abort", release, { once: true });
      void work.then(release, release);
    });
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

  private finishGenerate(request: ActiveRequest, settled: Settled<GenerationOutcome>): Promise<void> | undefined {
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
    const outcome = settled.value;
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
    const { session } = this.workspace;
    const { timers } = this.options;
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
    const { session } = this.workspace;
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

  // ----- menus and checks (F2-F6) -----

  /** Which notice explains why an action is refused in the current phase. */
  private busyNotice(generating: string): string {
    switch (this.phase) {
      case "generating":
        return generating;
      case "checking":
        return NOTICE_WAIT_CHECK;
      case "cancelling":
        return NOTICE_STILL_CLOSING;
      default:
        return NOTICE_WORKING;
    }
  }

  private settingsKey(name: "f2" | "f3" | "f4" | "f5" | "f6"): void {
    if (this.model.prompt !== undefined) return; // the custom prompt ignores function keys
    if (this.busy()) {
      this.flash(warning(this.busyNotice(NOTICE_BUSY_SETTINGS)));
      return;
    }
    this.model.scroll = 0;
    const { provider, selection } = this.workspace;
    switch (name) {
      case "f2":
        this.startCheck(`Loading ${provider.label} models`, (signal) => provider.listModels(signal), (models) => {
          const menu = modelMenu(selection.provider, models, selection.model);
          if (menu === undefined) this.append("error", `No selectable ${provider.label} models were found.`);
          else this.model.menu = menu;
        });
        break;
      case "f3":
        this.model.menu = providerMenu(provider.id);
        break;
      case "f4":
        this.startCheck("Checking reasoning support", (signal) => provider.getCapabilities(selection.model, signal), (capabilities) => {
          const opened = reasoningMenu(selection.model, capabilities, this.workspace.settings.reasoning);
          this.menuCapabilities = capabilities;
          if (opened.kind === "none") {
            this.append("info", opened.message);
            return;
          }
          if (opened.info !== undefined) this.append("info", opened.info);
          this.model.menu = opened.menu;
        });
        break;
      case "f5":
        this.startCheck("Checking model limits", (signal) => provider.getCapabilities(selection.model, signal), (capabilities) => {
          this.menuCapabilities = capabilities;
          this.model.menu = tokensMenu(this.workspace.settings.maxOutputTokens, capabilities.maxOutputTokensLimit);
        });
        break;
      case "f6":
        this.model.menu = styleMenu(this.workspace.settings.answerStyle.value);
        break;
    }
  }

  private handleMenuKey(menu: Menu, key: Key): void {
    if (key.kind !== "key") return;
    if (key.name === "ctrl-c") {
      this.requestExit({ code: EXIT_SIGINT }); // an idle open menu exits like an idle prompt
      return;
    }
    const layout = computeLayout(this.model.size);
    const action = menu.handle(key.name, layout === undefined ? 1 : menuVisible(layout));
    if (action === "cancel") {
      this.model.menu = undefined;
    } else if (action === "select") {
      this.model.menu = undefined;
      this.selectMenuItem(menu);
    }
  }

  private selectMenuItem(menu: Menu): void {
    const item = menu.selected;
    const { provider, selection } = this.workspace;
    switch (menu.kind) {
      case "provider": {
        const target = item.id === "openai" || item.id === "ollama" ? item.id : undefined;
        if (target !== undefined && target !== selection.provider) this.startSwitch({ provider: target }, `Checking ${item.label}`);
        break;
      }
      case "model":
        if (item.id !== selection.model) this.startSwitch({ provider: provider.id, model: item.id }, "Checking model settings");
        break;
      case "reasoning": {
        const value = reasoningValueOf(item.id);
        const capabilities = this.menuCapabilities;
        if (value === undefined || capabilities === undefined) break;
        const change = this.workspace.chooseReasoning(capabilities, value);
        if (change.changed) {
          this.append("info", `Reasoning for ${selection.model}: ${reasoningChoiceLabel(item.id)}. Applies from the next message.`);
          this.persistChange(change.save);
        }
        break;
      }
      case "max-tokens":
        if (item.id === CUSTOM_ID) this.startPrompt(this.menuCapabilities?.maxOutputTokensLimit);
        else this.applyMaxTokens(item.id === "default" ? null : BigInt(item.id));
        break;
      case "style": {
        const style: AnswerStyle | undefined = ANSWER_STYLES.find((candidate) => candidate === item.id);
        if (style === undefined) break;
        const change = this.workspace.chooseAnswerStyle(style);
        if (change.changed) {
          this.append("info", `Answer style: ${item.label}. Applies from the next message.`);
          this.persistChange(change.save);
        }
        break;
      }
    }
  }

  private applyMaxTokens(value: bigint | null): void {
    const capabilities = this.menuCapabilities;
    if (capabilities === undefined) return;
    const { selection } = this.workspace;
    const change = this.workspace.chooseMaxOutputTokens(capabilities, value);
    if (!change.changed) return;
    this.append("info", `Max output tokens for ${selection.model}: ${value === null ? "model default" : value.toString(10)}. Applies from the next message.`);
    this.persistChange(change.save);
  }

  /** The runtime choice is already effective; the write is awaited (and a failure only warns). */
  private persistChange(save: Promise<string | undefined> | undefined): void {
    if (save === undefined) return;
    this.work(async () => {
      const failure = await save;
      if (failure !== undefined) {
        this.append("error", `Warning: ${failure}`);
        this.model.status = warning("Settings not saved");
      }
    });
  }

  // ----- the custom max-output-tokens prompt -----

  private startPrompt(limit: number | undefined): void {
    const { editor } = this.model;
    this.model.prompt = { model: this.workspace.selection.model, limit, savedText: editor.text, savedCursor: editor.cursor };
    editor.clear();
    this.append("info", `Type the max output tokens${limit === undefined ? "" : ` (1-${String(limit)})`} and press Enter; Esc cancels.`);
  }

  private endPrompt(): void {
    const { prompt, editor } = this.model;
    if (prompt === undefined) return;
    this.model.prompt = undefined;
    editor.restore(prompt.savedText, prompt.savedCursor);
  }

  private cancelPrompt(): void {
    this.endPrompt();
    this.append("info", "Max output tokens unchanged.");
  }

  private submitPrompt(text: string): void {
    const { prompt, editor } = this.model;
    if (prompt === undefined) return;
    editor.clear();
    const parsed = parseTokenInput(text, prompt.limit, prompt.model);
    if (!parsed.ok) {
      this.append("error", parsed.message); // the prompt stays open, nothing changed
      return;
    }
    this.endPrompt();
    this.applyMaxTokens(parsed.value);
  }

  // ----- checks: asynchronous, cancellable, never mutating before their result is accepted -----

  private startCheck<T>(
    label: string,
    work: (signal: AbortSignal, progress: (label: string) => void) => Promise<T>,
    done: (value: T) => Promise<void> | void,
  ): void {
    const op: CheckOp = { abort: new AbortController(), retired: false };
    this.check = op;
    this.phase = "checking";
    this.model.checking = label;
    const progress = (next: string): void => {
      if (op.retired || this.exiting()) return;
      this.model.checking = next;
      this.requestDraw(false);
    };
    this.requestDraw(true);
    this.inflight = this.runCheck(op, work, done, progress).then(undefined, (error: unknown) => { this.fail(error); });
  }

  private async runCheck<T>(
    op: CheckOp,
    work: (signal: AbortSignal, progress: (label: string) => void) => Promise<T>,
    done: (value: T) => Promise<void> | void,
    progress: (label: string) => void,
  ): Promise<void> {
    const settled = await this.settleBounded(Promise.resolve().then(() => work(op.abort.signal, progress)), op.abort.signal);
    // No await from this identity check to the end of `done`'s synchronous part: a retired check applies nothing.
    if (this.check === op) this.check = undefined;
    this.model.checking = undefined;
    if (op.retired || this.exiting() || settled.kind === "stuck") {
      this.endCancelledCheck(settled.kind === "stuck");
      return;
    }
    if (settled.kind === "error") {
      this.phase = "idle";
      this.checkFailed(settled.error);
      this.requestDraw(true);
      return;
    }
    this.phase = "idle";
    const writing = done(settled.value);
    this.requestDraw(true);
    if (writing === undefined) return;
    this.phase = "working";
    try {
      await writing;
    } finally {
      this.phase = "idle";
      this.refreshStats();
      this.requestDraw(true);
    }
  }

  private cancelCheck(op: CheckOp): void {
    this.retireCheck(op);
    this.phase = "cancelling";
    this.append("error", "Cancelled.");
    this.model.status = { state: "CANCELLED", parts: [] };
    this.model.afterTransient = undefined;
  }

  /** Retires first, then aborts: nothing of this check is applied any more. */
  private retireCheck(op: CheckOp): void {
    op.retired = true;
    this.model.checking = undefined;
    op.abort.abort();
  }

  private endCancelledCheck(stuck: boolean): void {
    if (stuck) {
      this.stuck = true;
      this.phase = "idle";
      this.requestExit({ code: EXIT_SIGINT });
      return;
    }
    if (this.phase === "cancelling" || this.phase === "checking") this.phase = "idle";
    this.requestDraw(true);
  }

  private checkFailed(error: unknown): void {
    if (error instanceof SwitchRefusal) {
      this.append("error", error.message);
    } else if (error instanceof ProviderError || error instanceof SettingsError) {
      this.append("error", `Error: ${error.message}`);
      this.model.status = { state: "ERROR", parts: [error.message] };
      this.model.afterTransient = undefined;
    } else if (isAbortError(error)) {
      this.append("error", "Error: The request was aborted.");
    } else {
      throw error; // unexpected: the fixed internal-error handling
    }
  }

  // ----- switching provider or model -----

  private startSwitch(target: { readonly provider: "openai" | "ollama"; readonly model?: string }, label: string): void {
    this.startCheck(label, (signal, progress) => this.workspace.prepareSwitch(target, signal, progress), (prepared) => this.applySwitch(prepared));
  }

  /** Accepts the prepared switch (synchronously) and shows the target; the storage writes it started are awaited. */
  private applySwitch(prepared: PreparedSwitch): Promise<void> {
    const result = this.workspace.accept(prepared);
    this.model.clearEntries();
    this.model.confirmingCleanup = false;
    for (const message of result.session.snapshot().messages) this.model.add(message.role === "user" ? "user" : "ai", message.content);
    this.model.add("info", result.notice);
    for (const notice of prepared.notices) this.model.add("info", notice);
    for (const message of prepared.warnings) this.model.add("error", `Warning: ${message}`);
    this.model.scroll = 0;
    this.model.status = READY;
    this.model.afterTransient = undefined;
    this.refreshStats();
    return result.writes.then((warnings) => {
      for (const message of warnings) this.append("error", `Warning: ${message}`);
      if (warnings.length > 0) this.model.status = warning("Conversation not saved");
    });
  }

  // ----- entries and screen -----

  private populate(): void {
    const { warnings } = this.options;
    const { session } = this.workspace;
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
    this.model.stats = panelStats(this.workspace.session.snapshot().requests);
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
      const frame = renderFrame(this.model, { title: this.options.title, settings: this.workspace.settings, now: this.options.timers.now() });
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

