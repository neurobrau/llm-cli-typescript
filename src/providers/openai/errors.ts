import { ProviderError } from "../../domain/errors.js";
import { API_KEY_ENV_VAR } from "./capabilities.js";
import { safeText } from "../redact.js";

/** SDK-independent description of a failed request, produced at the SDK boundary. */
export type SdkFailure =
  | { readonly kind: "timeout" }
  | { readonly kind: "connection" }
  | {
      readonly kind: "status";
      readonly status: number;
      readonly param?: string;
      /** Server-supplied message; untrusted, sanitized before display. */
      readonly detail?: string;
    }
  | { readonly kind: "other" };

export function missingApiKeyError(): ProviderError {
  return new ProviderError(`${API_KEY_ENV_VAR} is not set. Export it in your environment and try again.`, "missing_api_key");
}

export function apiError(message: string): ProviderError {
  return new ProviderError(message, "api");
}

/**
 * Maps a failure to a categorized, credential-free ProviderError. Messages
 * never include request data, headers, URLs or raw SDK text.
 */
export function providerErrorFor(failure: SdkFailure, secrets: readonly string[]): ProviderError {
  switch (failure.kind) {
    case "timeout":
      return new ProviderError("Request to OpenAI timed out.", "timeout");
    case "connection":
      return new ProviderError("Could not connect to OpenAI. Check your network connection.", "connection");
    case "other":
      return apiError("Invalid response from OpenAI.");
    case "status":
      return statusError(failure, secrets);
  }
}

function statusError(failure: Extract<SdkFailure, { kind: "status" }>, secrets: readonly string[]): ProviderError {
  const { status } = failure;
  if (status === 401) {
    return new ProviderError(`OpenAI authentication failed. Check that ${API_KEY_ENV_VAR} is valid.`, "authentication");
  }
  if (status === 403) {
    return new ProviderError(
      `OpenAI denied access (HTTP 403). Check that ${API_KEY_ENV_VAR} is valid and allowed to use this model.`,
      "authentication",
    );
  }
  if (status === 429) {
    return new ProviderError(
      "OpenAI rate limit or quota exceeded. Wait and try again, or check your plan and billing.",
      "rate_limit",
    );
  }
  if (status === 408) {
    return new ProviderError("Request to OpenAI timed out.", "timeout");
  }
  const detail = safeText(failure.detail ?? "", secrets);
  return apiError(`OpenAI API error (HTTP ${String(status)}): ${detail === "" ? "no details" : detail}`);
}

/**
 * True only for an HTTP 400 whose structured `param` names the reasoning
 * parameter or one of its subfields. A message merely mentioning "reasoning"
 * is not enough.
 */
export function rejectsReasoning(failure: SdkFailure): boolean {
  return (
    failure.kind === "status" &&
    failure.status === 400 &&
    failure.param !== undefined &&
    (failure.param === "reasoning" || failure.param.startsWith("reasoning.") || failure.param.startsWith("reasoning["))
  );
}

