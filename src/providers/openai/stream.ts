/**
 * OpenAI Responses streaming: turns the SDK's raw events into domain
 * `StreamEvent`s, one SDK event per pull.
 *
 * Mapped events (checked against openai 7.45.0 `ResponseStreamEvent`):
 * - `response.output_text.delta`   -> text (the delta must be a string);
 * - `response.reasoning_text.delta`, `response.reasoning_summary_text.delta`
 *                                  -> reasoning (never answer text);
 * - `response.completed`           -> completed (usage, tier, id, model);
 * - `response.incomplete`          -> incomplete (readable reason);
 * - `response.failed`, `error`     -> failed (sanitized);
 * - everything else (lifecycle, output-item, refusal and `*.done` events) is
 *   ignored, so no text is taken twice. When no answer delta arrived, the
 *   answer text of a valid `response.completed` body is emitted once.
 *
 * The idle timer runs only while opening and while waiting for the next SDK
 * event; the SDK reports progress per event, so that is its granularity.
 */
import { ProviderError, createAbortError } from "../../domain/errors.js";
import type { GenerationRequest, StreamEvent, StreamMetadata } from "../../domain/generation.js";
import { IdleTimer, StreamScope } from "../event-stream.js";
import type { EventSource } from "../event-stream.js";
import { safeText } from "../redact.js";
import { buildParams, convertUsage, incompleteReason, isRecord, outputText } from "./convert.js";
import { apiError, providerErrorFor, rejectsReasoning } from "./errors.js";
import type { SdkFailure } from "./errors.js";
import { describeSdkError } from "./sdk.js";
import type { OpenAiApi, RawEventStream } from "./sdk.js";

export interface OpenAiSourceOptions {
  readonly api: OpenAiApi;
  readonly key: string;
  readonly request: GenerationRequest;
  /** The effort of the first attempt (already adjusted for a remembered rejection). */
  readonly effort: string | undefined;
  readonly idleMs: number;
  readonly signal: AbortSignal;
  /** Called when the model rejected the built-in reasoning default. */
  readonly onReasoningRejected: () => void;
}

export class OpenAiSource implements EventSource {
  private readonly scope: StreamScope;
  private readonly idle: IdleTimer;
  private raw: RawEventStream | undefined;
  private effort: string | undefined;
  private text = "";
  private published = false;
  private ended = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly queue: StreamEvent[] = [];

  constructor(private readonly options: OpenAiSourceOptions) {
    this.scope = new StreamScope(options.signal);
    this.idle = new IdleTimer(options.idleMs, () => {
      this.scope.abort();
    });
    this.effort = options.effort;
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
      if (this.raw === undefined) {
        await this.open();
      } else {
        await this.readOne(this.raw);
      }
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      this.idle.pause();
      this.scope.abort();
      try {
        await this.raw?.close();
      } finally {
        this.scope.dispose();
      }
    })();
    return this.closing;
  }

  // ----- opening (with the one allowed reasoning fallback) -----

  private async open(): Promise<void> {
    const { api, request } = this.options;
    for (let attempt = 0; ; attempt += 1) {
      this.idle.start();
      let failure: SdkFailure;
      try {
        const raw = await api.streamResponse(buildParams(request, this.effort), {
          signal: this.scope.signal,
          openTimeoutMs: this.options.idleMs,
        });
        if (this.closed || this.scope.signal.aborted) {
          await raw.close();
          this.throwIfStopped();
        }
        this.raw = raw;
        return;
      } catch (error: unknown) {
        failure = this.classify(error);
      } finally {
        this.idle.pause();
      }
      const effort = this.effort;
      if (attempt === 0 && effort !== undefined && !this.published && rejectsReasoning(failure)) {
        if (request.reasoning.explicit) {
          const detail = providerErrorFor(failure, [this.options.key]).message;
          this.fail(
            apiError(
              `${request.model} does not accept reasoning effort '${effort}' (${detail}). Choose another value with --reasoning-effort.`,
            ),
          );
          return;
        }
        // A built-in default the model rejects: remember it and retry once without it.
        this.options.onReasoningRejected();
        this.effort = undefined;
        continue;
      }
      this.fail(providerErrorFor(failure, [this.options.key]));
      return;
    }
  }

  // ----- reading -----

  private async readOne(raw: RawEventStream): Promise<void> {
    this.idle.start();
    let next: { readonly done: boolean; readonly value?: unknown };
    try {
      next = await raw.next();
    } catch (error: unknown) {
      this.fail(providerErrorFor(this.classify(error), [this.options.key]));
      return;
    } finally {
      this.idle.pause();
    }
    this.throwIfStopped();
    if (next.done) {
      // The SDK ends quietly when its request was aborted; the idle timer is the only such abort left here.
      this.fail(
        this.idle.expired
          ? new ProviderError("Request to OpenAI timed out.", "timeout")
          : apiError("OpenAI stream ended before the response was complete."),
      );
      return;
    }
    this.handle(next.value);
  }

  private handle(value: unknown): void {
    if (!isRecord(value)) {
      this.fail(apiError("Invalid stream event from OpenAI: event is not an object."));
      return;
    }
    switch (value.type) {
      case "response.output_text.delta":
        this.delta(value.delta, "text");
        return;
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta":
        this.delta(value.delta, "reasoning");
        return;
      case "response.completed":
        this.completed(value.response);
        return;
      case "response.incomplete":
        this.incomplete(value.response);
        return;
      case "response.failed": {
        const response = isRecord(value.response) ? value.response : {};
        const message = isRecord(response.error) && typeof response.error.message === "string" ? response.error.message : "";
        this.fail(apiError(`OpenAI response failed: ${this.safe(message)}`));
        return;
      }
      case "error": {
        const nested = isRecord(value.error) ? value.error : {};
        const message = typeof value.message === "string" ? value.message : typeof nested.message === "string" ? nested.message : "";
        this.fail(apiError(`OpenAI stream error: ${this.safe(message)}`));
        return;
      }
      default:
        return; // unrelated progress events
    }
  }

  private delta(delta: unknown, kind: "text" | "reasoning"): void {
    if (typeof delta !== "string") {
      this.fail(apiError(`Invalid stream event from OpenAI: ${kind} delta is not a string.`));
      return;
    }
    if (delta === "") {
      return;
    }
    this.published = true;
    if (kind === "text") {
      this.text += delta;
    }
    this.queue.push({ kind, text: delta });
  }

  private completed(response: unknown): void {
    if (!isRecord(response)) {
      this.fail(apiError("Invalid stream event from OpenAI: the completed event has no response."));
      return;
    }
    if (this.text === "") {
      const { text, refusal } = Array.isArray(response.output) ? outputText(response.output as unknown[]) : { text: "", refusal: "" };
      if (text === "") {
        this.fail(
          apiError(
            refusal === ""
              ? "OpenAI returned a completed response with no answer text."
              : `OpenAI refused the request: ${this.safe(refusal)}`,
          ),
        );
        return;
      }
      this.text = text;
      this.queue.push({ kind: "text", text }); // the fallback is shown exactly once
    }
    const usage = convertUsage(response.usage);
    const serviceTier = typeof response.service_tier === "string" ? response.service_tier : undefined;
    this.finish({
      kind: "completed",
      result: {
        text: this.text,
        ...(usage === undefined ? {} : { usage }),
        ...(serviceTier === undefined ? {} : { serviceTier }),
      },
      metadata: metadataOf(response),
    });
  }

  private incomplete(response: unknown): void {
    const body = isRecord(response) ? response : {};
    const details = body.incomplete_details;
    const reason = isRecord(details) && typeof details.reason === "string" ? details.reason : "";
    const usage = convertUsage(body.usage);
    const serviceTier = typeof body.service_tier === "string" ? body.service_tier : undefined;
    this.finish({
      kind: "incomplete",
      reason: incompleteReason(reason, [this.options.key]),
      partialText: this.text,
      ...(usage === undefined ? {} : { usage }),
      ...(serviceTier === undefined ? {} : { serviceTier }),
      metadata: metadataOf(body),
    });
  }

  // ----- helpers -----

  private finish(event: StreamEvent): void {
    this.ended = true;
    this.queue.push(event);
  }

  private fail(error: ProviderError): void {
    this.queue.length = 0; // nothing queued from this event may follow a failure
    this.finish({ kind: "failed", error, partialText: this.text });
  }

  private safe(message: string): string {
    const shown = safeText(message, [this.options.key]);
    return shown === "" ? "no details" : shown;
  }

  /** Caller cancellation or our own close: an AbortError, never an event. */
  private throwIfStopped(): void {
    if (this.scope.cancelled || this.closed) {
      throw createAbortError();
    }
  }

  /** Cancellation beats every other classification; then the idle deadline; then the SDK's description. */
  private classify(error: unknown): SdkFailure {
    this.throwIfStopped();
    return this.idle.expired ? { kind: "timeout" } : describeSdkError(error);
  }
}

function metadataOf(response: Readonly<Record<string, unknown>>): StreamMetadata {
  return {
    ...(typeof response.model === "string" ? { model: response.model } : {}),
    ...(typeof response.id === "string" ? { responseId: response.id } : {}),
  };
}
