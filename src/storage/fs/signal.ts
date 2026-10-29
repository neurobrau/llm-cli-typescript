import { ensureNotAborted } from "../../domain/errors.js";

/** Throws the project's AbortError (never `signal.reason`) when a signal is given and aborted. */
export function ensureNotAbortedSignal(signal: AbortSignal | undefined): void {
  if (signal !== undefined) {
    ensureNotAborted(signal);
  }
}
