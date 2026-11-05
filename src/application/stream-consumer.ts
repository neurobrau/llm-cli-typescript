/**
 * Consumes one provider stream for the one-shot and chat front ends.
 *
 * The consumer owns a child AbortController: the caller's signal cancels it,
 * and the consumer itself aborts it when output fails, so "the user
 * cancelled" stays distinguishable from "we stopped". It pulls one event at a
 * time and awaits `onText` before pulling again, so a slow writer applies
 * backpressure all the way to the network and pauses the providers' idle
 * deadlines. It stops at the first terminal event and never looks at anything
 * after it.
 *
 * Whatever the outcome, the iterator is closed (`return()`) exactly once and
 * the request is aborted first. Waiting for a provider that does not react is
 * bounded by `cleanupMs` on every path. When the caller cancelled, the result
 * is `stuck`; otherwise a terminal or failed stream becomes `unclosed` (an
 * output failure keeps its original error). No late event is ever processed.
 */
import { ProviderError, isAbortError, isAborted } from "../domain/errors.js";
import { isTerminalEvent } from "../domain/generation.js";
import type { StreamEvent, TerminalStreamEvent } from "../domain/generation.js";

/** Fixed, safe diagnostic when a finished stream could not be closed. */
export const STREAM_UNCLOSED = "the response stream could not be closed";

export type StreamEnd =
  | { readonly kind: "terminal"; readonly event: TerminalStreamEvent }
  /** The caller's signal was aborted; whatever the provider still had is discarded. */
  | { readonly kind: "cancelled" }
  /** As `cancelled`, but the provider did not settle within the bound. */
  | { readonly kind: "stuck" }
  /** `onText` threw; the request was aborted and the original error is kept. */
  | { readonly kind: "output-error"; readonly error: unknown }
  /** The stream ended on its own but `return()` did not settle within the bound; nothing may be committed. */
  | { readonly kind: "unclosed" };

export interface StreamConsumption {
  readonly end: StreamEnd;
  /** What was handed to `onText`, concatenated. */
  readonly text: string;
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** A promise that never rejects: late rejections of abandoned work cannot become unhandled. */
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  );
}

function failed(error: ProviderError, partialText: string): TerminalStreamEvent {
  return { kind: "failed", error, partialText };
}

export async function consumeStream(
  open: (signal: AbortSignal) => AsyncIterable<StreamEvent>,
  parent: AbortSignal,
  onText: (text: string) => Promise<void>,
  cleanupMs: number,
  /** Told only *that* the model is thinking, never what; failures count as output failures like `onText`. */
  onReasoning?: () => void | Promise<void>,
): Promise<StreamConsumption> {
  const own = new AbortController();
  const abortOwn = (): void => {
    own.abort();
  };
  let onParentAbort: (() => void) | undefined;
  const parentAborted = new Promise<"abort">((resolve) => {
    onParentAbort = () => {
      abortOwn();
      resolve("abort");
    };
    if (parent.aborted) {
      onParentAbort();
    } else {
      parent.addEventListener("abort", onParentAbort, { once: true });
    }
  });
  let text = "";
  let iterator: AsyncIterator<StreamEvent> | undefined;
  let timer: NodeJS.Timeout | undefined;

  /** Closes the iterator and waits, bounded, for it and for `pending` work. */
  const close = async (pending: Promise<Settled<unknown>> | undefined): Promise<boolean> => {
    abortOwn();
    const returned = settle(Promise.resolve().then(() => iterator?.return?.()));
    const bound = new Promise<"late">((resolve) => {
      timer = setTimeout(() => {
        resolve("late");
      }, cleanupMs);
    });
    const outcome = await Promise.race([Promise.all([returned, pending]), bound]);
    clearTimeout(timer);
    return outcome !== "late";
  };

  /** The outcome of a path that ended on its own: only a clean close lets it stand. */
  const concluded = async (end: StreamEnd, pending?: Promise<Settled<unknown>>): Promise<StreamConsumption> => {
    if (await close(pending)) return { end, text };
    if (isAborted(parent)) return { end: { kind: "stuck" }, text };
    return { end: end.kind === "output-error" ? end : { kind: "unclosed" }, text };
  };

  try {
    try {
      iterator = open(own.signal)[Symbol.asyncIterator]();
    } catch (error: unknown) {
      if (error instanceof ProviderError) {
        return { end: { kind: "terminal", event: failed(error, "") }, text };
      }
      throw error;
    }
    for (;;) {
      if (parent.aborted) {
        return { end: { kind: (await close(undefined)) ? "cancelled" : "stuck" }, text };
      }
      // A synchronous throw of next() is a rejection like any other and still reaches the guarded close.
      const current = iterator;
      const pulled = settle(Promise.resolve().then(() => current.next()));
      const first = await Promise.race([pulled, parentAborted]);
      if (first === "abort" || isAborted(parent)) {
        return { end: { kind: (await close(pulled)) ? "cancelled" : "stuck" }, text };
      }
      if (!first.ok) {
        const error = first.error;
        if (error instanceof ProviderError) {
          return await concluded({ kind: "terminal", event: failed(error, text) });
        }
        if (isAbortError(error)) {
          return await concluded({ kind: "terminal", event: failed(new ProviderError("The response stream was interrupted.", "api"), text) });
        }
        await close(undefined);
        throw error; // an unexpected failure keeps the existing fixed internal-error handling
      }
      const result = first.value;
      if (result.done === true) {
        return await concluded({ kind: "terminal", event: failed(new ProviderError("The response stream ended without a result.", "api"), text) });
      }
      const event = result.value;
      if (isTerminalEvent(event)) {
        return await concluded({ kind: "terminal", event });
      }
      if (event.kind === "reasoning" && onReasoning !== undefined) {
        try {
          await onReasoning();
        } catch (error: unknown) {
          return await concluded({ kind: "output-error", error });
        }
      }
      if (event.kind === "text" && event.text !== "") {
        try {
          await onText(event.text);
        } catch (error: unknown) {
          return await concluded({ kind: "output-error", error });
        }
        text += event.text;
      }
    }
  } finally {
    clearTimeout(timer);
    if (onParentAbort !== undefined) {
      parent.removeEventListener("abort", onParentAbort);
    }
  }
}
