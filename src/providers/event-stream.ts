/**
 * Lifecycle shared by the provider streams.
 *
 * A provider supplies an `EventSource`: a pull-based producer that does its
 * I/O only inside `pull()` and can be shut down with `close()`. `eventStream`
 * wraps it into the `AsyncIterable<StreamEvent>` of the domain contract:
 *
 * - nothing is created or started before the first `next()`;
 * - one `pull()` is active at a time (a stream has a single consumer);
 * - after a terminal event the source is closed and the iterator ends;
 * - `return()` closes the source first, which aborts a blocked network read,
 *   so a pending pull never delays it (an async generator could not do this:
 *   its `return()` waits behind the pending `next()`);
 * - cancellation of the caller's signal is an AbortError, never an event.
 *
 * The iterator is hand-written for that reason; it is not an async generator.
 */
import { createAbortError, isAbortError, isAborted } from "../domain/errors.js";
import { ProviderError } from "../domain/errors.js";
import { isTerminalEvent } from "../domain/generation.js";
import type { StreamEvent } from "../domain/generation.js";

export interface EventSource {
  /**
   * The next event, or `undefined` once the source has nothing more. Throws an
   * AbortError when it was cancelled or closed; every other failure is a
   * `failed` event.
   */
  pull(): Promise<StreamEvent | undefined>;
  /** Aborts pending work and releases every resource. Idempotent; settles when released. */
  close(): Promise<void>;
}

const DONE: IteratorResult<StreamEvent> = { done: true, value: undefined };

class EventStream implements AsyncIterable<StreamEvent>, AsyncIterator<StreamEvent> {
  private source: EventSource | undefined;
  private finished = false;
  private closing: Promise<void> | undefined;
  private inflight: Promise<IteratorResult<StreamEvent>> | undefined;

  constructor(
    private readonly signal: AbortSignal,
    private readonly create: () => EventSource,
  ) {}

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return this;
  }

  next(): Promise<IteratorResult<StreamEvent>> {
    const previous = this.inflight;
    const run = previous === undefined ? this.step() : previous.then(() => this.step(), () => this.step());
    this.inflight = run;
    return run;
  }

  async return(): Promise<IteratorResult<StreamEvent>> {
    await this.release();
    const pending = this.inflight;
    if (pending !== undefined) {
      await pending.then(
        () => undefined,
        () => undefined, // an intentional close may reject the pull it interrupted
      );
    }
    return DONE;
  }

  private async step(): Promise<IteratorResult<StreamEvent>> {
    if (this.finished) {
      return DONE;
    }
    if (this.signal.aborted) {
      await this.release();
      throw createAbortError();
    }
    let event: StreamEvent | undefined;
    try {
      this.source ??= this.create();
      event = await this.source.pull();
    } catch (error: unknown) {
      await this.release();
      throw isAbortError(error) || isAborted(this.signal) ? createAbortError() : error;
    }
    if (isAborted(this.signal)) {
      await this.release();
      throw createAbortError(); // cancellation wins over whatever arrived with it
    }
    if (event === undefined) {
      await this.release();
      return {
        done: false,
        value: {
          kind: "failed",
          error: new ProviderError("The response stream ended without a result.", "api"),
          partialText: "",
        },
      };
    }
    if (isTerminalEvent(event)) {
      await this.release();
    }
    return { done: false, value: event };
  }

  private release(): Promise<void> {
    this.finished = true;
    this.closing ??= (async () => {
      try {
        await this.source?.close();
      } catch {
        // Cleanup must not replace the stream's own outcome.
      }
    })();
    return this.closing;
  }
}

/** Wraps a lazily created source into the domain stream contract. */
export function eventStream(signal: AbortSignal, create: () => EventSource): AsyncIterable<StreamEvent> {
  return new EventStream(signal, create);
}

/**
 * A deadline for waiting. It runs only between `start()` and `pause()`, so
 * time spent with the consumer (or an output writer) never counts. `start()`
 * always begins a full period, which is how read progress resets it.
 */
export class IdleTimer {
  private timer: NodeJS.Timeout | undefined;
  private fired = false;

  constructor(
    private readonly ms: number,
    private readonly onExpire: () => void,
  ) {}

  get expired(): boolean {
    return this.fired;
  }

  start(): void {
    this.pause();
    if (this.fired) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.fired = true;
      this.onExpire();
    }, this.ms);
  }

  pause(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Forwards the caller's cancellation to an owned controller. `dispose()`
 * removes the listener; the owned controller is what the transport observes,
 * so the stream can also abort itself (idle timeout, close).
 */
export class StreamScope {
  readonly controller = new AbortController();
  private readonly onAbort = (): void => {
    this.controller.abort();
  };

  constructor(private readonly caller: AbortSignal) {
    if (caller.aborted) {
      this.controller.abort();
    } else {
      caller.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The caller (not the stream itself) cancelled. */
  get cancelled(): boolean {
    return this.caller.aborted;
  }

  abort(): void {
    this.controller.abort();
  }

  dispose(): void {
    this.caller.removeEventListener("abort", this.onAbort);
  }
}

/** A source whose only event is a failure (e.g. a missing key found when iteration starts). */
export function failedSource(error: ProviderError): EventSource {
  let delivered = false;
  return {
    pull: () => {
      if (delivered) {
        return Promise.resolve(undefined);
      }
      delivered = true;
      return Promise.resolve({ kind: "failed", error, partialText: "" });
    },
    close: () => Promise.resolve(),
  };
}
