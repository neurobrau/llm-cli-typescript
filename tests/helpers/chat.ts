/** Helpers for chat tests: scripted provider/input/interrupts and a runner with synthetic state only. */
import { PassThrough } from "node:stream";

import { ProviderError, createAbortError } from "../../src/domain/errors.js";
import { snapshotRequest } from "../../src/domain/generation.js";
import { isTerminalEvent } from "../../src/domain/generation.js";
import type { GenerationOutcome, GenerationRequest, ProviderId, StreamEvent, StreamTiming, TokenUsage } from "../../src/domain/generation.js";
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

export type StreamHandler = (request: GenerationRequest, signal: AbortSignal) => AsyncIterable<StreamEvent>;

/** Text deltas followed by the completed terminal event. */
export function streamAnswer(text: string, usage?: TokenUsage, pieces = 1): StreamEvent[] {
  const size = Math.max(1, Math.ceil(text.length / pieces));
  const deltas: StreamEvent[] = [];
  for (let at = 0; at < text.length; at += size) deltas.push({ kind: "text", text: text.slice(at, at + size) });
  return [...deltas, { kind: "completed", result: { text, ...(usage === undefined ? {} : { usage }) } }];
}

/** A cooperative stream that yields the events in order, one microtask apart. */
export function streamOf(...events: StreamEvent[]): StreamHandler {
  return (_request, signal) => ({
    [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => {
      let index = 0;
      return {
        next: async () => {
          await Promise.resolve();
          if (signal.aborted) throw createAbortError();
          const event = events[index];
          index += 1;
          return event === undefined ? { done: true, value: undefined } : { done: false, value: event };
        },
        return: () => Promise.resolve({ done: true, value: undefined }),
      };
    },
  });
}

/**
 * A hand-driven stream: the test pushes events (and an end or a failure) when
 * it wants them delivered. `cooperative: false` models a provider that ignores
 * both the abort signal and `return()` (a pending pull never settles).
 */
export class ControlledStream {
  readonly handler: StreamHandler;
  pulls = 0;
  returned = false;
  private readonly queue: StreamEvent[] = [];
  private ended = false;
  private wake: (() => void) | undefined;

  constructor(private readonly options: { readonly cooperative?: boolean } = {}) {
    this.handler = (_request, signal) => ({
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => ({
        next: async () => {
          this.pulls += 1;
          for (;;) {
            if (this.options.cooperative !== false && signal.aborted) throw createAbortError();
            const event = this.queue.shift();
            if (event !== undefined) return { done: false, value: event };
            if (this.ended) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const done = (): void => {
                this.wake = undefined;
                signal.removeEventListener("abort", done);
                resolve();
              };
              this.wake = done;
              if (this.options.cooperative !== false) signal.addEventListener("abort", done, { once: true });
            });
          }
        },
        return: () => {
          this.returned = true;
          this.ended = true;
          this.wake?.();
          if (this.options.cooperative === false) return new Promise<IteratorResult<StreamEvent>>(() => undefined);
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    });
  }

  push(...events: StreamEvent[]): void {
    this.queue.push(...events);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }
}

export const text = (value: string): StreamEvent => ({ kind: "text", text: value });
export const reasoning = (value: string): StreamEvent => ({ kind: "reasoning", text: value });
export const completedEvent = (value: string, usage?: TokenUsage, timing?: StreamTiming): StreamEvent => ({
  kind: "completed",
  result: { text: value, ...(usage === undefined ? {} : { usage }) },
  ...(timing === undefined ? {} : { metadata: { timing } }),
});
export const failedEvent = (message: string, partialText = "", kind: ConstructorParameters<typeof ProviderError>[1] = "api"): StreamEvent => ({
  kind: "failed",
  error: new ProviderError(message, kind),
  partialText,
});
export const incompleteEvent = (partialText: string, usage?: TokenUsage, reason = "the max output token limit was reached"): StreamEvent => ({
  kind: "incomplete",
  reason,
  partialText,
  ...(usage === undefined ? {} : { usage }),
});

/** A provider whose generate() follows a queue of handlers; it records snapshots and concurrency. */
export class ScriptedProvider implements Provider {
  label = "Scripted";
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

  /** Queue of stream scripts, consumed one per `stream()` call. The default replies `stream reply N`. */
  private readonly streams: StreamHandler[] = [];
  streamCalls = 0;
  /** Streams that were started (first pull) and have not ended yet. */
  streamsOpen = 0;
  maxStreamsOpen = 0;

  pushStream(...handlers: StreamHandler[]): void {
    this.streams.push(...handlers);
  }

  stream(request: GenerationRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    this.streamCalls += 1;
    this.requests.push(snapshotRequest(request));
    const handler = this.streams.shift() ?? streamOf(...streamAnswer(`stream reply ${String(this.streamCalls)}`));
    const inner = handler(request, signal);
    // Tracks overlap: a stream is open from its first pull until it ends or is returned.
    const open = (): void => {
      this.streamsOpen += 1;
      this.maxStreamsOpen = Math.max(this.maxStreamsOpen, this.streamsOpen);
    };
    const close = (): void => {
      this.streamsOpen -= 1;
    };
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<StreamEvent> => {
        const iterator = inner[Symbol.asyncIterator]();
        let started = false;
        let ended = false;
        const finish = (): void => {
          if (started && !ended) {
            ended = true;
            close();
          }
        };
        return {
          next: async () => {
            if (!started) {
              started = true;
              open();
            }
            try {
              const result = await iterator.next();
              if (result.done === true) finish();
              else if (isTerminalEvent(result.value)) finish();
              return result;
            } catch (error: unknown) {
              finish();
              throw error;
            }
          },
          return: async () => {
            try {
              return (await iterator.return?.()) ?? { done: true, value: undefined };
            } finally {
              finish();
            }
          },
        };
      },
    };
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
  /** Conversations "on disk": everything saved so far plus whatever a test puts here. */
  readonly disk = new Map<string, StoredConversation>();
  /** Every `loadLatest` filter result is recorded as the id picked (or undefined). */
  readonly picked: (string | undefined)[] = [];

  async save(conversation: StoredConversation): Promise<unknown> {
    this.calls.push("save");
    this.onSave?.();
    await this.saveGate;
    if (this.saveError !== undefined) throw this.saveError;
    this.saved.push(conversation);
    this.disk.set(conversation.id, conversation);
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
    const result = this.deleteResult ?? { deleted: this.files, error: undefined };
    if (result.error === undefined) {
      this.disk.clear();
      this.latest = undefined;
    }
    return Promise.resolve(result);
  }

  loadActive(): Promise<{ selection: ActiveSelection | undefined; warning: string | undefined }> {
    this.calls.push("loadActive");
    return Promise.resolve({ selection: this.active, warning: undefined });
  }

  loadLatest(accepts: (conversation: StoredConversation) => boolean): Promise<{ conversation: StoredConversation | undefined; warnings: string[] }> {
    this.calls.push("loadLatest");
    const candidates = [...(this.latest === undefined ? [] : [this.latest]), ...this.disk.values()].filter((conversation) => accepts(conversation));
    let found: StoredConversation | undefined;
    for (const candidate of candidates) {
      if (found === undefined || candidate.updatedAt.getTime() >= found.updatedAt.getTime()) found = candidate;
    }
    this.picked.push(found?.id);
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
