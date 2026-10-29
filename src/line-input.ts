/**
 * Line input over a Node readable stream.
 *
 * The reader pulls bytes only while lines are wanted: the stream is paused
 * once enough complete lines are buffered and resumed when they are consumed,
 * so nothing is read ahead without bound and nothing is lost while the caller
 * is busy (lines simply wait, in the buffer or in the stream). Decoding is
 * incremental UTF-8, so a character split across chunks is intact. Lines end
 * at LF or CRLF; a last line without a terminator is delivered at EOF.
 *
 * The reader attaches listeners to a stream it does not own and never
 * destroys it: `dispose()` removes every listener and pauses the stream.
 */
import { createAbortError } from "./domain/errors.js";

/** The part of a Node readable stream the reader uses. */
export interface ByteSource {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): this;
  on(event: "end" | "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "data", listener: (chunk: Uint8Array | string) => void): this;
  removeListener(event: "end" | "close", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  pause(): this;
  resume(): this;
  setEncoding?(encoding: BufferEncoding): this;
}

/** What the chat needs from its input: the next line, or the end. */
export interface LineInput {
  /** Resolves with the next line, `undefined` at the end of input. Rejects with `InputError` on a read failure and with an AbortError if `signal` aborts. */
  readLine(signal?: AbortSignal): Promise<string | undefined>;
  dispose(): void;
}

/** Reading failed (not a normal end of input). The cause is kept for debugging only. */
export class InputError extends Error {
  constructor(
    readonly reason: "read" | "line-too-long",
    options?: ErrorOptions,
  ) {
    super(reason === "read" ? "could not read input" : "an input line is too long");
    this.name = "InputError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export interface LineReaderOptions {
  /** Longest accepted line in UTF-16 code units. Default 8 Mi. */
  readonly maxLineLength?: number;
  /** Complete lines buffered before the stream is paused. Default 64. */
  readonly highWaterMark?: number;
}

const DEFAULT_MAX_LINE = 8 * 1024 * 1024;
const DEFAULT_HIGH_WATER = 64;

export class LineReader implements LineInput {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
  private readonly lines: string[] = [];
  private partial = "";
  private ended = false;
  private failure: InputError | undefined;
  private waiting: (() => void) | undefined;
  private disposed = false;
  private flowing = false;
  private readonly maxLine: number;
  private readonly highWater: number;

  private readonly onData = (chunk: Uint8Array | string): void => {
    if (this.failure !== undefined || this.ended) return;
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.feed(text);
    this.wake();
  };
  private readonly onEnd = (): void => {
    if (this.ended) return;
    if (this.failure === undefined) {
      const tail = this.partial + this.decoder.decode();
      this.partial = "";
      if (tail !== "") this.lines.push(stripCarriageReturn(tail));
    }
    this.ended = true;
    this.wake();
  };
  private readonly onError = (error: Error): void => {
    this.failure ??= new InputError("read", { cause: error });
    this.wake();
  };

  constructor(
    private readonly source: ByteSource,
    options: LineReaderOptions = {},
  ) {
    this.maxLine = options.maxLineLength ?? DEFAULT_MAX_LINE;
    this.highWater = options.highWaterMark ?? DEFAULT_HIGH_WATER;
    source.on("data", this.onData);
    source.on("end", this.onEnd);
    source.on("close", this.onEnd);
    source.on("error", this.onError);
    this.syncFlow();
  }

  async readLine(signal?: AbortSignal): Promise<string | undefined> {
    for (;;) {
      if (this.disposed) return undefined;
      if (signal?.aborted === true) throw createAbortError();
      const line = this.lines.shift();
      if (line !== undefined) {
        this.syncFlow();
        return line;
      }
      if (this.failure !== undefined) throw this.failure;
      if (this.ended) return undefined;
      this.syncFlow();
      await this.wait(signal);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.source.removeListener("data", this.onData);
    this.source.removeListener("end", this.onEnd);
    this.source.removeListener("close", this.onEnd);
    this.source.removeListener("error", this.onError);
    this.source.pause();
    this.lines.length = 0;
    this.wake();
  }

  private feed(text: string): void {
    let buffer = this.partial + text;
    let start = 0;
    for (let index = buffer.indexOf("\n", start); index !== -1; index = buffer.indexOf("\n", start)) {
      this.lines.push(stripCarriageReturn(buffer.slice(start, index)));
      start = index + 1;
    }
    buffer = buffer.slice(start);
    if (buffer.length > this.maxLine) {
      this.failure = new InputError("line-too-long");
      buffer = "";
    }
    this.partial = buffer;
    this.syncFlow();
  }

  /** Reads only when the consumer is waiting or the buffer is low. */
  private syncFlow(): void {
    if (this.disposed || this.ended || this.failure !== undefined) return;
    const wanted = this.lines.length < this.highWater;
    if (wanted && !this.flowing) {
      this.flowing = true;
      this.source.resume();
    } else if (!wanted && this.flowing) {
      this.flowing = false;
      this.source.pause();
    }
  }

  private wait(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        signal?.removeEventListener("abort", done);
        this.waiting = undefined;
        resolve();
      };
      this.waiting = done;
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private wake(): void {
    this.waiting?.();
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Input that is already at its end (the default for compositions without a stdin). */
export const EMPTY_INPUT: LineInput = {
  readLine: () => Promise.resolve(undefined),
  dispose: () => undefined,
};
