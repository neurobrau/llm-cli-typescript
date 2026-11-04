/**
 * The production terminal adapter: a small ANSI/VT writer and reader for the
 * tested terminal families (xterm, screen, tmux, rxvt and variants).
 *
 * It owns everything that changes the terminal - alternate screen, raw mode,
 * autowrap, cursor visibility, styles - and undoes exactly what it did, once,
 * on `close()`. Importing this module changes nothing; only `open()` does.
 * The streams are injected so a test can drive it with in-memory streams.
 */
import type { Frame, Style } from "./frame.js";
import type { Size } from "./layout.js";
import { TerminalError } from "./terminal.js";
import type { Terminal, TerminalHandlers } from "./terminal.js";

/** The input side the adapter needs (a Node `tty.ReadStream`). */
export interface TerminalInput {
  setRawMode?(mode: boolean): unknown;
  readonly isRaw?: boolean;
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
  removeListener(event: "end" | "close", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  /** `true` while the stream is flowing, `null`/`false` otherwise. */
  readonly readableFlowing?: boolean | null;
}

/** The output side (a Node `tty.WriteStream`). */
export interface TerminalOutput {
  readonly columns?: number;
  readonly rows?: number;
  write(text: string, callback: (error?: Error | null) => void): boolean;
  once(event: "drain", listener: () => void): unknown;
  on(event: "resize", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "resize", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}

export interface AnsiTerminalOptions {
  readonly input: TerminalInput;
  readonly output: TerminalOutput;
  /** Color escape sequences; false renders bold/reverse only. */
  readonly color: boolean;
}

const ESC = "\x1b";
const ENTER_SCREEN = `${ESC}[?1049h${ESC}[?7l${ESC}[0m${ESC}[2J`;
const LEAVE_SCREEN = `${ESC}[0m${ESC}[?7h${ESC}[?25h${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

const COLORS: Readonly<Record<Style, string>> = {
  text: "0;37;40",
  border: "0;1;32;40",
  user: "0;1;34;40",
  ai: "0;1;32;40",
  info: "0;32;40",
  error: "0;1;31;40",
  waiting: "0;1;33;40",
};

const MONOCHROME: Readonly<Record<Style, string>> = {
  text: "0",
  border: "0;1",
  user: "0;1",
  ai: "0;1",
  info: "0",
  error: "0;1",
  waiting: "0;7",
};

export class AnsiTerminal implements Terminal {
  private opened = false;
  private closing: Promise<void> | undefined;
  private handlers: TerminalHandlers | undefined;
  private changedRaw = false;
  private wasRaw = false;
  private resumed = false;
  private entered = false;
  private previous: string[] = [];
  private previousCols = 0;
  private readonly listeners = {
    data: (chunk: Uint8Array | string): void => { this.handlers?.onData(chunk); },
    resize: (): void => { this.handlers?.onResize(); },
    end: (): void => { this.handlers?.onEnd(); },
    error: (): void => { this.handlers?.onEnd(); },
    outputError: (): void => { /* the failure is reported through the pending write callback */ },
  };

  constructor(private readonly options: AnsiTerminalOptions) {}

  open(handlers: TerminalHandlers): void {
    if (this.opened || this.closing !== undefined) throw new TerminalError();
    this.opened = true;
    this.handlers = handlers;
    const { input, output } = this.options;
    try {
      if (input.setRawMode === undefined) throw new Error("raw mode is not supported");
      // Decided before the first listener: adding a "data" listener already starts the flow.
      this.resumed = input.readableFlowing !== true;
      this.wasRaw = input.isRaw === true;
      input.setRawMode(true);
      this.changedRaw = !this.wasRaw;
      output.on("error", this.listeners.outputError);
      output.on("resize", this.listeners.resize);
      input.on("data", this.listeners.data);
      input.on("end", this.listeners.end);
      input.on("close", this.listeners.end);
      input.on("error", this.listeners.error);
      input.resume();
      this.entered = true;
      output.write(ENTER_SCREEN, () => undefined);
    } catch (cause: unknown) {
      this.closing = this.restore();
      throw new TerminalError({ cause });
    }
  }

  size(): Size {
    const { output } = this.options;
    return { rows: output.rows ?? 24, cols: output.columns ?? 80 };
  }

  draw(frame: Frame): Promise<void> {
    if (this.closing !== undefined) return Promise.resolve();
    const text = this.compose(frame);
    if (text === "") return Promise.resolve();
    return this.write(text);
  }

  close(): Promise<void> {
    this.closing ??= this.restore();
    return this.closing;
  }

  // ----- internals -----

  private write(text: string): Promise<void> {
    const { output } = this.options;
    return new Promise<void>((resolve, reject) => {
      output.write(text, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  /** Undoes only what `open` did, in reverse order; never throws. */
  private restore(): Promise<void> {
    const { input, output } = this.options;
    this.handlers = undefined;
    if (this.opened) {
      this.safely(() => { input.removeListener("data", this.listeners.data); });
      this.safely(() => { input.removeListener("end", this.listeners.end); });
      this.safely(() => { input.removeListener("close", this.listeners.end); });
      this.safely(() => { input.removeListener("error", this.listeners.error); });
      this.safely(() => { output.removeListener("resize", this.listeners.resize); });
    }
    if (this.changedRaw) this.safely(() => { input.setRawMode?.(false); });
    if (this.resumed) this.safely(() => { input.pause(); });
    this.changedRaw = false;
    this.resumed = false;
    let flushed: Promise<void> = Promise.resolve();
    if (this.entered) {
      this.entered = false;
      flushed = new Promise<void>((resolve) => {
        try {
          output.write(LEAVE_SCREEN, () => { resolve(); });
        } catch {
          resolve(); // a closed output cannot be restored by writing; there is nothing more to do
        }
      });
    }
    this.safely(() => { output.removeListener("error", this.listeners.outputError); });
    return flushed;
  }

  private safely(action: () => void): void {
    try {
      action();
    } catch {
      // Restoration is best effort and must continue with the remaining steps.
    }
  }

  /** Escape sequences for the rows that changed since the last frame (all rows after a size change). */
  private compose(frame: Frame): string {
    const palette = this.options.color ? COLORS : MONOCHROME;
    const full = this.previous.length !== frame.rows || this.previousCols !== frame.cols;
    let out = HIDE_CURSOR;
    if (full) out += `${ESC}[0m${ESC}[2J`;
    const next: string[] = [];
    for (let row = 0; row < frame.rows; row += 1) {
      const chars = frame.chars[row] ?? [];
      const styles = frame.styles[row] ?? [];
      // The bottom-right cell is never written: it would scroll many terminals.
      const width = row === frame.rows - 1 ? frame.cols - 1 : frame.cols;
      let line = "";
      let current: Style | undefined;
      for (let col = 0; col < width; col += 1) {
        const style = styles[col] ?? "text";
        if (style !== current) {
          line += `${ESC}[${palette[style]}m`;
          current = style;
        }
        line += chars[col] ?? " ";
      }
      next.push(line);
      if (full || this.previous[row] !== line) out += `${ESC}[${String(row + 1)};1H${line}`;
    }
    this.previous = next;
    this.previousCols = frame.cols;
    out += `${ESC}[0m`;
    if (frame.cursor !== undefined) {
      out += `${ESC}[${String(frame.cursor.row + 1)};${String(frame.cursor.col + 1)}H${SHOW_CURSOR}`;
    }
    return out;
  }
}
