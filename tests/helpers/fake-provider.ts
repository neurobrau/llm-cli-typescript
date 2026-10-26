import { ProviderError, createAbortError } from "../../src/domain/errors.js";
import { snapshotRequest } from "../../src/domain/generation.js";
import type { GenerationOutcome, GenerationRequest, ProviderId, StreamEvent } from "../../src/domain/generation.js";
import type { Availability, ModelInfo, Provider } from "../../src/domain/provider.js";
import type { ModelCapabilities } from "../../src/domain/settings.js";
import { deferred } from "./deferred.js";
import type { Deferred } from "./deferred.js";

export interface FakeScript {
  /** Result of generate(): an outcome, or a ProviderError to reject with. */
  readonly outcome?: GenerationOutcome | ProviderError;
  /** Events yielded by stream(), in order. */
  readonly events?: readonly StreamEvent[];
  readonly models?: readonly ModelInfo[];
  readonly capabilities?: ModelCapabilities;
  readonly defaultModel?: string;
  readonly availability?: Availability;
  /** When set, generate()/stream() wait on it before producing anything. */
  readonly gate?: Deferred;
}

const NO_REASONING: ModelCapabilities = {
  reasoning: { known: false, values: [], allowsModelDefault: true },
};

/** Always rejects with our AbortError, never with an arbitrary `signal.reason`. */
function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError();
  }
}

/** Deterministic test-only provider. No timers, no I/O. */
export class FakeProvider implements Provider {
  readonly id: ProviderId = "openai";
  readonly label = "Fake";
  /** Frozen snapshots of every request received. */
  readonly requests: GenerationRequest[] = [];
  /** Resolves when an operation reached its pending point (the gate). */
  private readonly pendingReached = deferred();
  /** Abort listeners currently registered by pending operations. */
  activeAbortListeners = 0;
  /** Times a stream's cleanup ran (once per started stream). */
  streamCleanups = 0;

  constructor(private readonly script: FakeScript = {}) {}

  get reachedPending(): Promise<void> {
    return this.pendingReached.promise;
  }

  async generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationOutcome> {
    ensureNotAborted(signal);
    this.requests.push(snapshotRequest(request));
    await this.pending(signal);
    ensureNotAborted(signal); // an abort may arrive across the await
    const { outcome } = this.script;
    if (outcome instanceof ProviderError) {
      throw outcome;
    }
    return outcome ?? { kind: "completed", result: { text: "" } };
  }

  async *stream(request: GenerationRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    let cleaned = false;
    const cleanup = (): void => {
      if (!cleaned) {
        cleaned = true;
        this.streamCleanups += 1;
      }
    };
    try {
      ensureNotAborted(signal);
      this.requests.push(snapshotRequest(request));
      await this.pending(signal);
      ensureNotAborted(signal); // an abort may arrive across the await
      for (const event of this.script.events ?? []) {
        ensureNotAborted(signal);
        yield event;
      }
    } finally {
      cleanup();
    }
  }

  async listModels(signal: AbortSignal): Promise<readonly ModelInfo[]> {
    ensureNotAborted(signal);
    await Promise.resolve();
    ensureNotAborted(signal);
    return this.script.models ?? [];
  }

  async checkAvailability(signal: AbortSignal): Promise<Availability> {
    ensureNotAborted(signal);
    await Promise.resolve();
    ensureNotAborted(signal);
    return this.script.availability ?? { available: true, message: "" };
  }

  async defaultModel(signal: AbortSignal): Promise<string> {
    ensureNotAborted(signal);
    await Promise.resolve();
    ensureNotAborted(signal);
    return this.script.defaultModel ?? "fake-model";
  }

  async getCapabilities(_model: string, signal: AbortSignal): Promise<ModelCapabilities> {
    ensureNotAborted(signal);
    await Promise.resolve();
    ensureNotAborted(signal);
    return this.script.capabilities ?? NO_REASONING;
  }

  /** Waits for the gate or an abort; always removes its abort listener. */
  private async pending(signal: AbortSignal): Promise<void> {
    const { gate } = this.script;
    if (gate === undefined) {
      return;
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        reject(createAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.activeAbortListeners += 1;
    });
    this.pendingReached.resolve();
    try {
      await Promise.race([gate.promise, aborted]);
    } finally {
      if (onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
        this.activeAbortListeners -= 1;
      }
    }
  }
}
