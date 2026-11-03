/** Failures of the Ollama HTTP exchange shared by the one-shot and streaming paths. */
import { ProviderError } from "../../domain/errors.js";
import { safeText } from "../redact.js";

export function pullHint(model: string): string {
  return `Install it yourself with: ollama pull ${model}`;
}

/** A non-2xx reply; always a ProviderError so callers need no special case. */
export class HttpStatusError extends ProviderError {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Ollama API error (HTTP ${String(status)}): ${detail}`, "api");
    this.name = "ProviderError";
  }
}

/** Ollama's `{"error": "..."}` text, else the start of the body; always safe to print. */
export function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed && typeof parsed.error === "string") {
      return safeText(parsed.error) || "no details";
    }
  } catch {
    // not JSON: fall through to the raw text
  }
  return safeText(body) || "no details";
}

export function explainNotFound(error: unknown, model: string): unknown {
  if (error instanceof HttpStatusError && error.status === 404) {
    const shown = safeText(model);
    return new ProviderError(`Ollama model '${shown}' was not found: ${error.detail}. ${pullHint(shown)}`, "api");
  }
  return error;
}
