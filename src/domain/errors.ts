/**
 * Normalized provider failures and their exit-code mapping
 * (Python docs/tui-spec.md section 16).
 */

export type ProviderErrorKind =
  | "api"
  | "missing_api_key"
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "connection";

/** Exit code for an invalid CLI setting (reported by the future CLI boundary). */
export const EXIT_SETTINGS = 2;
/** Exit code for cancellation (SIGINT convention); distinct from every provider kind. */
export const EXIT_CANCELLED = 130;

/**
 * A user-facing provider failure.
 *
 * The message must already be safe to print: this type cannot sanitize
 * arbitrary upstream text. Future adapters must normalize and redact it
 * (never include credentials or raw request data) before constructing the error.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;

  constructor(message: string, kind: ProviderErrorKind = "api", options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderError";
    this.kind = kind;
  }
}

/** A command-line setting that the selected model is known not to support. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export function exitCodeForKind(kind: ProviderErrorKind): number {
  switch (kind) {
    case "api":
      return 1;
    case "missing_api_key":
      return 3;
    case "authentication":
      return 4;
    case "rate_limit":
      return 5;
    case "timeout":
      return 6;
    case "connection":
      return 7;
  }
}

/** Cancellation is never a provider failure: operations reject with an AbortError. */
export function createAbortError(message = "The operation was aborted"): Error {
  return new DOMException(message, "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Throws an AbortError if the signal is aborted, regardless of `signal.reason`. */
export function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError();
  }
}
