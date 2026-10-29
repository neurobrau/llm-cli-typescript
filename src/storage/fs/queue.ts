import { createAbortError } from "../../domain/errors.js";

/**
 * Runs operations strictly one after another in invocation order. A queued
 * operation whose signal aborts before it started rejects with an AbortError
 * at once and never runs; one that already started is not interrupted here.
 */
export class OperationQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted === true) {
      return Promise.reject(createAbortError());
    }
    return new Promise<T>((resolve, reject) => {
      let started = false;
      let skipped = false;
      const onAbort = (): void => {
        if (!started) {
          skipped = true;
          reject(createAbortError());
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // `tail` never rejects: every link settles after the task, whatever its outcome.
      this.tail = this.tail.then(async () => {
        if (skipped) {
          return;
        }
        started = true;
        signal?.removeEventListener("abort", onAbort);
        try {
          resolve(await task());
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error("operation failed", { cause: error }));
        }
      });
    });
  }
}
