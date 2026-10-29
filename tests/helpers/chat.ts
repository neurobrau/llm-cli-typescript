/** Helpers for chat tests: scripted provider/input/interrupts and a runner with synthetic state only. */
import { PassThrough } from "node:stream";

import { ProviderError, createAbortError } from "../../src/domain/errors.js";
import { snapshotRequest } from "../../src/domain/generation.js";
import type { GenerationOutcome, GenerationRequest, ProviderId, TokenUsage } from "../../src/domain/generation.js";
import type { Availability, ModelInfo, Provider } from "../../src/domain/provider.js";
import type { ModelCapabilities } from "../../src/domain/settings.js";
import type { HistoryPort } from "../../src/application/chat-startup.js";
import type { InterruptSource } from "../../src/io.js";
import { StorageIoError } from "../../src/storage/fs/errors.js";
import type { ActiveSelection, StoredConversation } from "../../src/storage/types.js";
import { InputError } from "../../src/line-input.js";
import type { LineInput } from "../../src/line-input.js";
import { run } from "../../src/main.js";
import type { RunDependencies } from "../../src/main.js";
import type { Tree } from "./storage-fs.js";

export type Handler = (request: GenerationRequest, signal: AbortSignal) => Promise<GenerationOutcome>;

export const NO_REASONING: ModelCapabilities = { reasoning: { known: false, values: [], allowsModelDefault: true } };

export function completed(text: string, usage?: TokenUsage, serviceTier?: string): GenerationOutcome {
  return { kind: "completed", result: { text, ...(usage === undefined ? {} : { usage }), ...(serviceTier === undefined ? {} : { serviceTier }) } };
}

export function incomplete(partialText: string, usage?: TokenUsage, reason = "the max output token limit was reached"): GenerationOutcome {
  return { kind: "incomplete", reason, partialText, ...(usage === undefined ? {} : { usage }) };
}

export const answer = (text: string, usage?: TokenUsage): Handler => () => Promise.resolve(completed(text, usage));
export const outcome = (value: GenerationOutcome): Handler => () => Promise.resolve(value);
export const failure = (message: string, kind: ConstructorParameters<typeof ProviderError>[1] = "api"): Handler => () =>
  Promise.reject(new ProviderError(message, kind));

/** A provider whose generate() follows a queue of handlers; it records snapshots and concurrency. */
export class ScriptedProvider implements Provider {
  readonly label = "Scripted";
  readonly requests: GenerationRequest[] = [];
  readonly capabilityCalls: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  calls = 0;
  defaultModelCalls = 0;
  private readonly queue: Handler[];

  constructor(
    readonly id: ProviderId,
    handlers: readonly Handler[] = [],
    private readonly options: { readonly defaultModel?: string; readonly capabilities?: ModelCapabilities; readonly capabilityError?: ProviderError } = {},
  ) {
    this.queue = [...handlers];
  }

  push(...handlers: Handler[]): void {
    this.queue.push(...handlers);
  }

  async generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationOutcome> {
    this.calls += 1;
    this.requests.push(snapshotRequest(request));
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const handler = this.queue.shift() ?? answer(`reply ${String(this.calls)}`);
      return await handler(request, signal);
    } finally {
      this.inFlight -= 1;
    }
  }

  stream(): never {
    throw new Error("streaming is not part of this task");
  }

  listModels(): Promise<readonly ModelInfo[]> {
    return Promise.resolve([]);
  }

  checkAvailability(): Promise<Availability> {
    return Promise.resolve({ available: true, message: "" });
  }

  defaultModel(): Promise<string> {
    this.defaultModelCalls += 1;
    return Promise.resolve(this.options.defaultModel ?? "default-model");
  }

  getCapabilities(model: string, signal?: AbortSignal): Promise<ModelCapabilities> {
    if (signal?.aborted === true) return Promise.reject(createAbortError());
    this.capabilityCalls.push(model);
    if (this.options.capabilityError !== undefined) return Promise.reject(this.options.capabilityError);
    return Promise.resolve(this.options.capabilities ?? NO_REASONING);
  }

  /** The message contents of request `index` as `role: content` strings. */
  sent(index: number): string[] {
    return (this.requests[index]?.messages ?? []).map((message) => `${message.role}: ${message.content}`);
  }
}

/** A handler that waits for `gate` (or an abort) before answering. */
export function gated(gate: Promise<void>, value: GenerationOutcome, onReached?: () => void): Handler {
  return async (_request, signal) => {
    onReached?.();
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        reject(createAbortError());
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      void gate.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
    return value;
  };
}

/** A provider operation that ignores the abort signal completely. */
export function deaf(gate: Promise<void>, value: GenerationOutcome, onReached?: () => void): Handler {
  return async () => {
    onReached?.();
    await gate;
    return value;
  };
}

/** Manually driven line input. */
export class ManualInput implements LineInput {
  disposed = false;
  readCalls = 0;
  private readonly lines: string[] = [];
  private ended = false;
  private error: Error | undefined;
  private wake: (() => void) | undefined;

  constructor(initial: readonly string[] = [], end = false) {
    this.lines.push(...initial);
    this.ended = end;
  }

  push(...lines: string[]): void {
    this.lines.push(...lines);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  fail(): void {
    this.error = new InputError("read", { cause: new Error("synthetic read failure") });
    this.wake?.();
  }

  async readLine(signal?: AbortSignal): Promise<string | undefined> {
    this.readCalls += 1;
    for (;;) {
      if (signal?.aborted === true) throw createAbortError();
      const line = this.lines.shift();
      if (line !== undefined) return line;
      if (this.error !== undefined) throw this.error;
      if (this.ended) return undefined;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.wake = undefined;
          signal?.removeEventListener("abort", done);
          resolve();
        };
        this.wake = done;
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

export interface FakeInterrupts {
  readonly source: InterruptSource;
  fire(): void;
  readonly registered: () => number;
  readonly active: () => number;
}

export function fakeInterrupts(): FakeInterrupts {
  const handlers = new Set<() => void>();
  let registered = 0;
  return {
    source: {
      register(handler) {
        registered += 1;
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
    },
    fire: () => {
      for (const handler of [...handlers]) handler();
    },
    registered: () => registered,
    active: () => handlers.size,
  };
}

/** Time advances by one second per call, starting at 2026-10-23T10:00:00Z. */
export function stepClock(startIso = "2026-10-23T10:00:00.000Z"): () => Date {
  let next = new Date(startIso).getTime();
  return () => {
    const now = new Date(next);
    next += 1000;
    return now;
  };
}

export function sequentialIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

export function sinkWriter(log: string[], onWrite?: (text: string) => void | Promise<void>): (text: string) => Promise<void> {
  return async (text) => {
    log.push(text);
    await onWrite?.(text);
  };
}

export interface ChatRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  /** Ordered log of `out:`/`err:` chunks. */
  readonly log: readonly string[];
}

export interface ChatOptions {
  readonly tree?: Tree;
  readonly env?: Record<string, string | undefined>;
  readonly home?: string | undefined;
  readonly deps?: Partial<RunDependencies>;
  readonly onWrite?: (stream: "out" | "err", text: string) => void | Promise<void>;
}

/** Runs the real `run()` with injected, synthetic everything. */
export async function runChat(argv: readonly string[], provider: Provider, input: LineInput, options: ChatOptions = {}): Promise<ChatRun> {
  const log: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const env: Record<string, string | undefined> =
    options.env ?? (options.tree === undefined ? {} : { XDG_STATE_HOME: options.tree.state, XDG_CONFIG_HOME: options.tree.config.replace(/\/neurobrau$/, "") });
  const code = await run(
    argv,
    {
      stdout: async (text) => {
        out.push(text);
        log.push(`out:${text}`);
        await options.onWrite?.("out", text);
      },
      stderr: async (text) => {
        err.push(text);
        log.push(`err:${text}`);
        await options.onWrite?.("err", text);
      },
    },
    {
      createProvider: () => provider,
      createInput: () => input,
      storageEnvironment: { env, home: options.home },
      clock: stepClock(),
      newId: sequentialIds(),
      cleanupTimeoutMs: 50,
      ...options.deps,
    },
  );
  return { code, out: out.join(""), err: err.join(""), log };
}

export function streamInput(): PassThrough {
  return new PassThrough();
}

/** In-memory history with failure injection and gates; it records every call in order. */
export class MemoryHistory implements HistoryPort {
  directory = "/virtual/state/neurobrau/conversations";
  readonly calls: string[] = [];
  readonly saved: StoredConversation[] = [];
  readonly activeSaved: ActiveSelection[] = [];
  files = 0;
  saveError: Error | undefined;
  activeError: Error | undefined;
  deleteResult: { deleted: number; error: { message: string } | undefined } | undefined;
  saveGate: Promise<void> | undefined;
  onSave: (() => void) | undefined;
  latest: StoredConversation | undefined;
  active: ActiveSelection | undefined;

  async save(conversation: StoredConversation): Promise<unknown> {
    this.calls.push("save");
    this.onSave?.();
    await this.saveGate;
    if (this.saveError !== undefined) throw this.saveError;
    this.saved.push(conversation);
    return {};
  }

  saveActive(selection: ActiveSelection): Promise<unknown> {
    this.calls.push("saveActive");
    if (this.activeError !== undefined) return Promise.reject(this.activeError);
    this.activeSaved.push(selection);
    return Promise.resolve({});
  }

  countConversations(): Promise<number> {
    this.calls.push("count");
    return Promise.resolve(this.files);
  }

  deleteAll(): Promise<{ deleted: number; error: { message: string } | undefined }> {
    this.calls.push("deleteAll");
    return Promise.resolve(this.deleteResult ?? { deleted: this.files, error: undefined });
  }

  loadActive(): Promise<{ selection: ActiveSelection | undefined; warning: string | undefined }> {
    this.calls.push("loadActive");
    return Promise.resolve({ selection: this.active, warning: undefined });
  }

  loadLatest(accepts: (conversation: StoredConversation) => boolean): Promise<{ conversation: StoredConversation | undefined; warnings: string[] }> {
    this.calls.push("loadLatest");
    const found = this.latest !== undefined && accepts(this.latest) ? this.latest : undefined;
    return Promise.resolve({ conversation: found, warnings: [] });
  }
}

export function ioError(operation: "save" | "read" | "delete" = "save", code = "EACCES"): StorageIoError {
  return new StorageIoError({ operation, subject: "conversation history", path: "/virtual/state/neurobrau/x.json", cause: Object.assign(new Error("e"), { code }) });
}

/** Counts `YOU > ` prompts written to stdout so tests can wait for a deterministic point, not a delay. */
export function promptWatcher(): { readonly onWrite: (stream: "out" | "err", text: string) => void; reached(count: number): Promise<void> } {
  let count = 0;
  const waiters: { count: number; resolve: () => void }[] = [];
  return {
    onWrite: (stream, text) => {
      if (stream !== "out" || text !== "YOU > ") return;
      count += 1;
      for (const waiter of waiters) if (waiter.count <= count) waiter.resolve();
    },
    reached: (target) =>
      new Promise<void>((resolve) => {
        if (count >= target) resolve();
        else waiters.push({ count: target, resolve });
      }),
  };
}
