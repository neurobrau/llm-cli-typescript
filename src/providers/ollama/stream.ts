/**
 * Ollama `/api/chat` streaming: NDJSON framing, the leading `<think>` filter,
 * record validation and the event source built from them.
 *
 * Counts and durations come from the final `done: true` record only. A
 * record's content is processed before the terminal event it carries. Bytes
 * after the first terminal are never parsed: the response is closed.
 *
 * The idle timer covers opening (connect, headers) and each wait for body
 * bytes; any received chunk is progress, even a partial line.
 */
import { ProviderError, createAbortError, isAbortError } from "../../domain/errors.js";
import type { StreamEvent, StreamMetadata, StreamTiming } from "../../domain/generation.js";
import { IdleTimer, StreamScope } from "../event-stream.js";
import type { EventSource } from "../event-stream.js";
import { safeText } from "../redact.js";
import { HttpStatusError, errorDetail, explainNotFound } from "./errors.js";
import { INCOMPLETE_REASON, asObject, invalidResponse, parseUsage } from "./parse.js";
import type { JsonObject } from "./parse.js";
import type { StreamResponse, StreamTransport } from "./transport.js";

/** Longest accepted NDJSON frame (without its line terminator), as in the Go edition. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** How much of a non-2xx body is read for the diagnostic. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

// ----- framing -----

export class FrameTooLongError extends Error {
  constructor() {
    super("stream line is too long");
    this.name = "FrameTooLongError";
  }
}

/**
 * Splits bytes at LF into frames. The limit applies to the bytes of a frame
 * (a trailing CR is not counted) and is checked for complete lines and for
 * the unfinished tail alike, so chunk boundaries cannot change the verdict.
 * Splitting at 0x0A is safe for UTF-8, so characters split across chunks stay
 * intact until a whole frame is decoded.
 */
export class NdjsonFramer {
  private parts: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly maxBytes: number) {}

  /**
   * The frames completed by `chunk`. If a line exceeds the limit, the frames
   * before it are still returned and `tooLong` is set; nothing after it is.
   */
  push(chunk: Uint8Array): { readonly frames: Uint8Array[]; readonly tooLong: boolean } {
    const frames: Uint8Array[] = [];
    try {
      let start = 0;
      for (let index = chunk.indexOf(0x0a, start); index !== -1; index = chunk.indexOf(0x0a, start)) {
        this.append(chunk.subarray(start, index));
        frames.push(this.take());
        start = index + 1;
      }
      this.append(chunk.subarray(start));
    } catch (error: unknown) {
      if (error instanceof FrameTooLongError) {
        return { frames, tooLong: true };
      }
      throw error;
    }
    return { frames, tooLong: false };
  }

  /** The unterminated last line at end of input, if any. */
  finish(): Uint8Array | undefined {
    return this.size === 0 ? undefined : this.take();
  }

  private append(piece: Uint8Array): void {
    if (piece.length === 0) {
      return;
    }
    this.parts.push(piece);
    this.size += piece.length;
    const last = piece[piece.length - 1];
    if (this.size - (last === 0x0d ? 1 : 0) > this.maxBytes) {
      this.parts = [];
      this.size = 0;
      throw new FrameTooLongError();
    }
  }

  private take(): Uint8Array {
    const frame = this.parts.length === 1 ? (this.parts[0] ?? new Uint8Array()) : Buffer.concat(this.parts);
    this.parts = [];
    this.size = 0;
    return frame;
  }
}

// ----- leading <think> block -----

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

interface Pieces {
  readonly answer: string;
  readonly reasoning: string;
}

const NOTHING: Pieces = { answer: "", reasoning: "" };

/**
 * Separates one leading `<think>…</think>` block from answer content as it
 * streams, matching the non-streaming rules: whitespace before the opening
 * tag and after the closing tag is dropped, later tags stay in the answer.
 * Only an undecided prefix (`<th`) or a possible start of the closing tag is
 * held back; reasoning inside the block is passed on as it arrives.
 */
export class ThinkFilter {
  private state: "undecided" | "thinking" | "after" | "answer" = "undecided";
  private pending = "";

  feed(text: string): Pieces {
    switch (this.state) {
      case "answer":
        return { answer: text, reasoning: "" };
      case "after": {
        const answer = text.trimStart();
        if (answer !== "") {
          this.state = "answer";
        }
        return { answer, reasoning: "" };
      }
      case "undecided": {
        this.pending += text;
        const trimmed = this.pending.trimStart();
        if (THINK_OPEN.startsWith(trimmed)) {
          return NOTHING; // could still become the opening tag
        }
        if (!trimmed.startsWith(THINK_OPEN)) {
          this.state = "answer";
          const answer = this.pending;
          this.pending = "";
          return { answer, reasoning: "" };
        }
        this.state = "thinking";
        this.pending = trimmed.slice(THINK_OPEN.length);
        return this.inside("");
      }
      case "thinking":
        return this.inside(text);
    }
  }

  /** At the end of the record stream: held-back text, and whether a think block never closed. */
  flush(): { readonly answer: string; readonly reasoning: string; readonly unclosed: boolean } {
    const rest = this.pending;
    this.pending = "";
    if (this.state === "thinking") {
      return { answer: "", reasoning: rest, unclosed: true };
    }
    // A partial tag such as "<th", or only whitespace, was ordinary text.
    return { answer: this.state === "undecided" ? rest : "", reasoning: "", unclosed: false };
  }

  private inside(text: string): Pieces {
    this.pending += text;
    const end = this.pending.indexOf(THINK_CLOSE);
    if (end >= 0) {
      const reasoning = this.pending.slice(0, end);
      const rest = this.pending.slice(end + THINK_CLOSE.length);
      this.pending = "";
      this.state = "after";
      return { answer: this.feed(rest).answer, reasoning };
    }
    let hold = Math.min(THINK_CLOSE.length - 1, this.pending.length);
    while (hold > 0 && !THINK_CLOSE.startsWith(this.pending.slice(this.pending.length - hold))) {
      hold -= 1;
    }
    const emit = this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    return { answer: "", reasoning: emit };
  }
}

// ----- the source -----

export interface OllamaSourceOptions {
  /** Discovery and request building; runs on the first pull. Rejects like any provider operation. */
  readonly begin: (signal: AbortSignal) => Promise<{ readonly url: string; readonly body: string; readonly model: string }>;
  readonly transport: StreamTransport;
  readonly idleMs: number;
  readonly signal: AbortSignal;
  readonly maxFrameBytes: number;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isBlank(frame: Uint8Array): boolean {
  return frame.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d);
}

export class OllamaSource implements EventSource {
  private readonly scope: StreamScope;
  private readonly idle: IdleTimer;
  private readonly framer: NdjsonFramer;
  private readonly filter = new ThinkFilter();
  private readonly queue: StreamEvent[] = [];
  private response: StreamResponse | undefined;
  private model = "";
  private answer = "";
  private thinking = "";
  private inline = "";
  private ended = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: OllamaSourceOptions) {
    this.scope = new StreamScope(options.signal);
    this.idle = new IdleTimer(options.idleMs, () => {
      this.scope.abort();
    });
    this.framer = new NdjsonFramer(options.maxFrameBytes);
  }

  async pull(): Promise<StreamEvent | undefined> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        return queued;
      }
      if (this.ended) {
        return undefined;
      }
      this.throwIfStopped();
      if (this.response === undefined) {
        await this.open();
      } else {
        await this.readOne(this.response);
      }
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      this.idle.pause();
      this.scope.abort();
      try {
        await this.response?.close();
      } finally {
        this.scope.dispose();
      }
    })();
    return this.closing;
  }

  // ----- opening -----

  private async open(): Promise<void> {
    let request;
    try {
      request = await this.options.begin(this.scope.signal);
    } catch (error: unknown) {
      this.throwIfStopped();
      if (isAbortError(error)) {
        throw error;
      }
      if (error instanceof ProviderError) {
        this.fail(error);
        return;
      }
      throw error;
    }
    this.model = request.model;
    this.idle.start();
    try {
      const response = await this.options.transport({ url: request.url, body: request.body, signal: this.scope.signal });
      if (this.closed || this.scope.signal.aborted) {
        await response.close();
        this.throwIfStopped();
      }
      this.response = response;
      if (response.status < 200 || response.status > 299) {
        await this.failStatus(response, request.model);
      }
    } catch (error: unknown) {
      this.failTransport(error);
    } finally {
      this.idle.pause();
    }
  }

  private async failStatus(response: StreamResponse, model: string): Promise<void> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_ERROR_BODY_BYTES) {
      const chunk = await response.read().catch((error: unknown) => {
        if (isAbortError(error)) {
          throw error;
        }
        return undefined; // the status is what matters; a broken body only shortens the detail
      });
      if (chunk === undefined) {
        break;
      }
      chunks.push(chunk);
      size += chunk.length;
    }
    const body = new TextDecoder("utf-8").decode(Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES));
    const error = explainNotFound(new HttpStatusError(response.status, errorDetail(body)), model);
    this.fail(error instanceof ProviderError ? error : invalidResponse("unexpected error"));
  }

  // ----- reading -----

  private async readOne(response: StreamResponse): Promise<void> {
    this.idle.start();
    let chunk: Uint8Array | undefined;
    try {
      chunk = await response.read();
    } catch (error: unknown) {
      this.failTransport(error);
      return;
    } finally {
      this.idle.pause();
    }
    this.throwIfStopped();
    if (chunk === undefined) {
      const tail = this.framer.finish();
      if (tail !== undefined) {
        this.frame(tail);
      }
      if (!this.ended) {
        this.fail(new ProviderError("Ollama stream ended before the response was complete.", "connection"));
      }
      return;
    }
    const { frames, tooLong } = this.framer.push(chunk);
    for (const frame of frames) {
      this.frame(frame);
      if (this.ended) {
        return; // the rest of the chunk (and the response) is ignored
      }
    }
    if (tooLong) {
      this.fail(invalidResponse("stream line is too long"));
    }
  }

  private frame(bytes: Uint8Array): void {
    if (isBlank(bytes)) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(strictUtf8.decode(bytes));
    } catch (error: unknown) {
      this.fail(invalidResponse(error instanceof TypeError ? "stream line is not valid UTF-8" : "stream line is not valid JSON"));
      return;
    }
    const record = asObject(value);
    if (record === undefined) {
      this.fail(invalidResponse("stream line is not a JSON object"));
      return;
    }
    this.record(record);
  }

  private record(record: JsonObject): void {
    if ("error" in record && record.error !== null && record.error !== undefined) {
      const detail = typeof record.error === "string" ? safeText(record.error) : "unspecified error";
      this.fail(new ProviderError(`Ollama error: ${detail === "" ? "no details" : detail}`, "api"));
      return;
    }
    let content = "";
    let thinking = "";
    if ("message" in record) {
      const message = asObject(record.message);
      if (message === undefined) {
        this.fail(invalidResponse("stream line has an invalid 'message'"));
        return;
      }
      if ("content" in message) {
        if (typeof message.content !== "string") {
          this.fail(invalidResponse("stream line has no valid 'message.content'"));
          return;
        }
        content = message.content;
      }
      if ("thinking" in message) {
        if (typeof message.thinking !== "string") {
          this.fail(invalidResponse("stream line has an invalid 'message.thinking'"));
          return;
        }
        thinking = message.thinking;
      }
    }
    if ("done" in record && typeof record.done !== "boolean") {
      this.fail(invalidResponse("stream line has an invalid 'done'"));
      return;
    }
    // Order: explicit thinking, then reasoning found inline, then the answer.
    this.emitReasoning(thinking, "thinking");
    const pieces = this.filter.feed(content);
    this.emitReasoning(pieces.reasoning, "inline");
    this.emitAnswer(pieces.answer);
    if (record.done === true) {
      this.finishRecord(record);
    }
  }

  private finishRecord(record: JsonObject): void {
    const rest = this.filter.flush();
    this.emitReasoning(rest.reasoning, "inline");
    this.emitAnswer(rest.answer);
    const usage = parseUsage(record);
    const model = typeof record.model === "string" && record.model !== "" ? record.model : this.model;
    const timing = timingOf(record);
    const metadata: StreamMetadata = {
      model,
      ...(typeof record.done_reason === "string" ? { doneReason: record.done_reason } : {}),
      ...(timing === undefined ? {} : { timing }),
    };
    if (record.done_reason === "length") {
      this.end({
        kind: "incomplete",
        reason: INCOMPLETE_REASON,
        partialText: this.answer,
        ...(usage === undefined ? {} : { usage }),
        metadata,
      });
      return;
    }
    if (rest.unclosed) {
      this.fail(invalidResponse("the model's reasoning block never ended, so there is no answer"));
      return;
    }
    // Reasoning is kept apart from the answer; an explicit field wins over an inline block (as when not streaming).
    const reasoning = (this.thinking.trim() !== "" ? this.thinking : this.inline).trim();
    this.end({
      kind: "completed",
      result: {
        text: this.answer,
        ...(usage === undefined ? {} : { usage }),
        ...(reasoning === "" ? {} : { reasoning }),
      },
      metadata,
    });
  }

  // ----- helpers -----

  private emitReasoning(text: string, source: "thinking" | "inline"): void {
    if (text === "") {
      return;
    }
    if (source === "thinking") {
      this.thinking += text;
    } else {
      this.inline += text;
    }
    this.queue.push({ kind: "reasoning", text });
  }

  private emitAnswer(text: string): void {
    if (text === "") {
      return;
    }
    this.answer += text;
    this.queue.push({ kind: "text", text });
  }

  private end(event: StreamEvent): void {
    this.ended = true;
    this.queue.push(event);
  }

  private fail(error: ProviderError): void {
    this.end({ kind: "failed", error, partialText: this.answer });
  }

  /** Caller cancellation or our own close: an AbortError, never an event. */
  private throwIfStopped(): void {
    if (this.scope.cancelled || this.closed) {
      throw createAbortError();
    }
  }

  private failTransport(error: unknown): void {
    this.throwIfStopped();
    if (this.idle.expired) {
      this.fail(new ProviderError("Request to Ollama timed out.", "timeout"));
      return;
    }
    if (error instanceof ProviderError) {
      this.fail(error);
      return;
    }
    if (isAbortError(error)) {
      this.fail(new ProviderError("The connection to Ollama was interrupted.", "connection"));
      return;
    }
    throw error;
  }
}

/** Seconds from the final record's `*_duration` nanoseconds; only finite, non-negative numbers. */
function timingOf(record: JsonObject): StreamTiming | undefined {
  const seconds = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value / 1e9 : undefined;
  const fields = {
    totalSeconds: seconds(record.total_duration),
    loadSeconds: seconds(record.load_duration),
    promptEvalSeconds: seconds(record.prompt_eval_duration),
    evalSeconds: seconds(record.eval_duration),
  };
  const present = Object.entries(fields).filter((entry): entry is [string, number] => entry[1] !== undefined);
  return present.length === 0 ? undefined : Object.fromEntries(present);
}
