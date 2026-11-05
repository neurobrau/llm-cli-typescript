/** Fakes for the fullscreen interface: terminal, timers and signals. No real terminal is ever touched. */
import { frameLines } from "../../src/tui/frame.js";
import type { Frame } from "../../src/tui/frame.js";
import { computeLayout } from "../../src/tui/layout.js";
import type { Size } from "../../src/tui/layout.js";
import { TerminalError } from "../../src/tui/terminal.js";
import type {
  SignalSource,
  Terminal,
  TerminalEnvironment,
  TerminalHandlers,
  TerminationSignal,
  TimerHandle,
  Timers,
  TuiHost,
} from "../../src/tui/terminal.js";
import type { RunDependencies } from "../../src/main.js";
import { emptySettings } from "../../src/storage/settings.js";
import { ManualInput, MemoryHistory, ScriptedProvider, runChat } from "./chat.js";
import type { ChatOptions, ChatRun } from "./chat.js";
import { deferred } from "./deferred.js";
import type { Tree } from "./storage-fs.js";

export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Lets queued work run; deterministic (macrotask turns), not wall-clock waiting. */
export async function settleAll(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) await settle();
}

export async function until(condition: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 4000; i += 1) {
    if (condition()) return;
    // Macrotask turns first (fast); real file-system work needs a little wall-clock time.
    if (i < 400) await settle();
    else await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Like `until` for conditions that need real I/O to finish (file contents). */
export async function eventually(condition: () => Promise<boolean>, what = "condition"): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    if (await condition()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error(`timed out waiting for ${what}`);
}

export class ManualTimers implements Timers {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; every: number | undefined; callback: () => void }>();

  now(): number {
    return this.time;
  }

  after(ms: number, callback: () => void): TimerHandle {
    return this.add(ms, undefined, callback);
  }

  every(ms: number, callback: () => void): TimerHandle {
    return this.add(ms, ms, callback);
  }

  /** Number of timers that are still scheduled. */
  get pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const timer = this.timers.get(nextId);
      if (timer === undefined) break;
      this.time = Math.max(this.time, timer.at);
      if (timer.every === undefined) this.timers.delete(nextId);
      else timer.at += timer.every;
      timer.callback();
    }
    this.time = target;
  }

  private add(ms: number, every: number | undefined, callback: () => void): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.time + ms, every, callback });
    return { cancel: () => { this.timers.delete(id); } };
  }
}

export class FakeSignals implements SignalSource {
  private readonly handlers = new Set<(signal: TerminationSignal) => void>();
  registrations = 0;

  register(onSignal: (signal: TerminationSignal) => void): () => void {
    this.registrations += 1;
    this.handlers.add(onSignal);
    return () => { this.handlers.delete(onSignal); };
  }

  get active(): number {
    return this.handlers.size;
  }

  fire(signal: TerminationSignal): void {
    for (const handler of [...this.handlers]) handler(signal);
  }
}

export class FakeTerminal implements Terminal {
  readonly log: string[] = [];
  readonly frames: Frame[] = [];
  handlers: TerminalHandlers | undefined;
  rows: number;
  cols: number;
  openError: Error | undefined;
  drawError: Error | undefined;
  /** While set, `draw` does not complete: terminal output backpressure. */
  drawGate: Promise<void> | undefined;
  /** While set, `close` does not complete: a restoring write that never flushes. */
  closeGate: Promise<void> | undefined;
  closeCount = 0;
  openCount = 0;
  drawsStarted = 0;
  readonly opened = deferred();

  constructor(size: Size = { rows: 25, cols: 80 }) {
    this.rows = size.rows;
    this.cols = size.cols;
  }

  open(handlers: TerminalHandlers): void {
    this.openCount += 1;
    this.log.push("open");
    if (this.openError !== undefined) {
      this.log.push("open-failed");
      throw new TerminalError({ cause: this.openError });
    }
    this.handlers = handlers;
    this.opened.resolve();
  }

  size(): Size {
    return { rows: this.rows, cols: this.cols };
  }

  async draw(frame: Frame): Promise<void> {
    this.drawsStarted += 1;
    if (this.drawError !== undefined) throw this.drawError;
    if (this.drawGate !== undefined) await this.drawGate;
    if (this.closeCount > 0) this.log.push("draw-after-close");
    this.frames.push(frame);
    this.log.push("draw");
  }

  close(): Promise<void> {
    this.closeCount += 1;
    if (this.closeCount === 1) this.log.push("close");
    this.handlers = undefined;
    return this.closeGate ?? Promise.resolve();
  }

  // ----- driving -----

  feed(data: string | Uint8Array): void {
    this.handlers?.onData(data);
  }

  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    this.handlers?.onResize();
  }

  end(): void {
    this.handlers?.onEnd();
  }

  // ----- reading -----

  get frame(): Frame {
    const last = this.frames.at(-1);
    if (last === undefined) throw new Error("nothing was drawn yet");
    return last;
  }

  lines(): string[] {
    return frameLines(this.frame);
  }

  text(): string {
    return this.lines().join("\n");
  }

  /** The conversation rows (between the borders), right-trimmed, without the settings panel. */
  conversation(): string[] {
    const layout = computeLayout({ rows: this.rows, cols: this.cols });
    if (layout === undefined) return [];
    return this.lines()
      .slice(1, this.rows - 6)
      .map((line) => Array.from(line).slice(2, layout.conversationLimit).join("").replace(/\s+$/u, ""));
  }

  /** The conversation as one whitespace-normalized string (wrapping removed). */
  flat(): string {
    return this.conversation().join(" ").replace(/\s+/gu, " ").trim();
  }

  status(): string {
    return (this.lines()[this.rows - 5] ?? "").replace(/^\| /u, "").replace(/\s*\|?\s*$/u, "");
  }

  inputLine(): string {
    return this.lines()[this.rows - 3] ?? "";
  }

  get drawn(): number {
    return this.log.filter((entry) => entry === "draw").length;
  }
}

export const SUPPORTED: TerminalEnvironment = { stdinIsTTY: true, stdoutIsTTY: true, term: "xterm-256color", rawModeSupported: true, color: true };

export interface FakeHost {
  readonly host: TuiHost;
  readonly terminal: FakeTerminal;
  readonly timers: ManualTimers;
  readonly signals: FakeSignals;
  created: number;
  environmentReads: number;
}

export function fakeHost(terminal: FakeTerminal = new FakeTerminal(), environment: TerminalEnvironment = SUPPORTED): FakeHost {
  const timers = new ManualTimers();
  const signals = new FakeSignals();
  const state = {
    host: undefined as unknown as TuiHost,
    terminal,
    timers,
    signals,
    created: 0,
    environmentReads: 0,
  };
  state.host = {
    environment: () => {
      state.environmentReads += 1;
      return environment;
    },
    createTerminal: () => {
      state.created += 1;
      return terminal;
    },
    signals,
    timers,
  };
  return state;
}

// Key sequences as a terminal sends them.
export const KEYS = {
  enter: "\r",
  backspace: "\x7f",
  delete: "\x1b[3~",
  left: "\x1b[D",
  right: "\x1b[C",
  up: "\x1b[A",
  down: "\x1b[B",
  home: "\x1b[H",
  end: "\x1b[F",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  ctrlA: "\x01",
  ctrlC: "\x03",
  ctrlD: "\x04",
  ctrlE: "\x05",
  ctrlU: "\x15",
} as const;

// ----- a whole fullscreen run through run(), with synthetic everything -----


export interface TuiSession {
  readonly term: FakeTerminal;
  readonly timers: ManualTimers;
  readonly signals: FakeSignals;
  readonly host: FakeHost;
  readonly provider: ScriptedProvider;
  readonly history: MemoryHistory;
  /** Settles when run() returns. */
  readonly result: Promise<ChatRun>;
  /** The run's stdout/stderr writes in order, interleaved with the terminal log. */
  readonly order: string[];
  type(text: string): Promise<void>;
  key(sequence: string): Promise<void>;
  screen(): string;
}

export interface TuiOptions {
  readonly argv?: readonly string[];
  readonly provider?: ScriptedProvider;
  readonly history?: MemoryHistory;
  readonly terminal?: FakeTerminal;
  readonly tree?: Tree;
  readonly deps?: Partial<RunDependencies>;
  readonly environment?: TerminalEnvironment;
  readonly onWrite?: ChatOptions["onWrite"];
  /** Do not wait for the terminal to open (startup failures). */
  readonly noWait?: boolean;
}

export async function startTui(options: TuiOptions = {}): Promise<TuiSession> {
  const term = options.terminal ?? new FakeTerminal();
  const host = fakeHost(term, options.environment ?? SUPPORTED);
  const provider = options.provider ?? new ScriptedProvider("ollama");
  const history = options.history ?? new MemoryHistory();
  const order: string[] = term.log;
  const result = runChat(options.argv ?? [], provider, new ManualInput(), {
    ...(options.tree === undefined ? { env: { XDG_STATE_HOME: "/virtual/state", XDG_CONFIG_HOME: "/virtual/config" } } : { tree: options.tree }),
    home: "/virtual/home",
    onWrite: async (stream, text) => {
      order.push(`${stream}:${text}`);
      await options.onWrite?.(stream, text);
    },
    deps: { tui: host.host, createHistoryStore: () => history, createSettingsStore: () => ({ load: () => Promise.resolve({ settings: emptySettings(), warnings: [] }) }), ...options.deps },
  });
  if (options.noWait !== true) {
    await Promise.race([term.opened.promise, result]);
    await until(() => term.frames.length > 0 || term.closeCount > 0, "the first frame");
  }
  return {
    term,
    timers: host.timers,
    signals: host.signals,
    host,
    provider,
    history,
    result,
    order,
    type: async (text) => {
      term.feed(text);
      await settleAll(4);
    },
    key: async (sequence) => {
      term.feed(sequence);
      await settleAll(4);
    },
    screen: () => term.text(),
  };
}

/**
 * Waits for run() to finish while the injected clock advances, so bounds that run on the injected
 * timers (drawing, restoring) fire. Fails instead of hanging when the run never ends.
 */
export async function finishWithClock(session: TuiSession, stepMs = 50, steps = 200): Promise<ChatRun> {
  const outcome: { value: ChatRun | undefined } = { value: undefined };
  void session.result.then((value) => { outcome.value = value; });
  for (let i = 0; i < steps; i += 1) {
    await settleAll(3); // pending promise work first: a bound must not fire before work that is about to settle
    if (outcome.value !== undefined) return outcome.value;
    session.timers.advance(stepMs);
  }
  throw new Error("run() did not finish although the clock advanced");
}
