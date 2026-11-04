/**
 * Ports of the fullscreen interface: the terminal, timers and signals. The
 * controller sees only these interfaces; the production implementations live
 * in `ansi-terminal.ts` and `src/cli.ts`, tests inject fakes.
 */
import type { Frame } from "./frame.js";
import type { Size } from "./layout.js";

export interface TerminalHandlers {
  /** Raw input bytes (or already decoded text) from the keyboard. */
  onData(chunk: Uint8Array | string): void;
  /** The window size may have changed. */
  onResize(): void;
  /** Input ended or the terminal went away. */
  onEnd(): void;
}

/**
 * One fullscreen terminal session. `open` takes the terminal over (alternate
 * screen, raw input) and must undo any partial work itself if it fails;
 * `close` restores what this run changed, exactly once, and may be called at
 * any time, also without a successful `open`.
 */
export interface Terminal {
  open(handlers: TerminalHandlers): void;
  size(): Size;
  /** Draws a complete frame; resolves when the terminal accepted it (backpressure). */
  draw(frame: Frame): Promise<void>;
  /** Restores the terminal; resolves when the restoring output was flushed. Idempotent. */
  close(): Promise<void>;
}

/** Opening the terminal failed; nothing of it is left changed. */
export class TerminalError extends Error {
  constructor(options?: ErrorOptions) {
    super("could not initialize the terminal", options);
    this.name = "TerminalError";
  }
}

export interface TimerHandle {
  cancel(): void;
}

export interface Timers {
  /** Monotonic milliseconds. */
  now(): number;
  after(ms: number, callback: () => void): TimerHandle;
  every(ms: number, callback: () => void): TimerHandle;
}

export type TerminationSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/** One handler for every signal the interface reacts to; the returned function removes it. */
export interface SignalSource {
  register(onSignal: (signal: TerminationSignal) => void): () => void;
}

/** What the executable knows about the terminal it runs in. */
export interface TerminalEnvironment {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly term: string | undefined;
  /** The input stream can be switched to raw mode. */
  readonly rawModeSupported: boolean;
  /** Colors may be used (false: monochrome rendering). */
  readonly color: boolean;
}

export interface TuiHost {
  environment(): TerminalEnvironment;
  createTerminal(environment: TerminalEnvironment): Terminal;
  readonly signals: SignalSource;
  readonly timers: Timers;
}

export const systemTimers: Timers = {
  now: () => performance.now(),
  after: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return { cancel: () => { clearTimeout(timer); } };
  },
  every: (ms, callback) => {
    const timer = setInterval(callback, ms);
    return { cancel: () => { clearInterval(timer); } };
  },
};
