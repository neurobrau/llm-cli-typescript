import { ProviderError, createAbortError, ensureNotAborted } from "../../domain/errors.js";
import { eventStream } from "../event-stream.js";
import { snapshotRequest } from "../../domain/generation.js";
import type { GenerationOutcome, GenerationRequest, ProviderId, StreamEvent } from "../../domain/generation.js";
import type { Availability, ModelInfo, Provider } from "../../domain/provider.js";
import type { ModelCapabilities } from "../../domain/settings.js";
import { safeText } from "../redact.js";
import { HttpStatusError, errorDetail, explainNotFound, pullHint } from "./errors.js";
import { invalidResponse, isCloudName, isSelectable, parseChatResponse, parseShow, parseTags } from "./parse.js";
import type { ShowInfo, TagEntry } from "./parse.js";
import { reasoningSupport, thinkField } from "./thinking.js";
import { OllamaSource, MAX_FRAME_BYTES } from "./stream.js";
import { nodeStreamTransport, nodeTransport } from "./transport.js";
import type { StreamTransport, Transport } from "./transport.js";

export const CHAT_TIMEOUT_MS = 300_000;
export const DISCOVERY_TIMEOUT_MS = 3_000;

export interface OllamaProviderOptions {
  /** Normalized base URL without a trailing slash (see `resolveBaseUrl`). No default: the composition supplies it. */
  readonly baseUrl: string;
  readonly chatTimeoutMs?: number;
  readonly discoveryTimeoutMs?: number;
  /** Test seam; default: Node's built-in HTTP client with direct connections. */
  readonly transport?: Transport;
  /** Test seam for streaming replies; default: Node's built-in client, read incrementally. */
  readonly streamTransport?: StreamTransport;
  /** Longest accepted NDJSON frame in bytes. Default 16 MiB; tests inject a small value. */
  readonly maxFrameBytes?: number;
}

interface Prepared {
  readonly entry: ModelInfo;
  readonly capabilities: ModelCapabilities;
}

const NO_LOCAL_MODELS =
  "No local Ollama models are installed (cloud models are not used). Install one with: ollama pull <model>";


/**
 * Native Ollama provider (/api/tags, /api/show, /api/chat; non-streaming).
 * Caches live for this instance only and requests are assumed sequential;
 * concurrent use is not supported yet. Models are never pulled or created.
 */
export class OllamaProvider implements Provider {
  readonly id: ProviderId = "ollama";
  readonly label = "Ollama";

  private readonly chatTimeoutMs: number;
  private readonly discoveryTimeoutMs: number;
  private readonly transport: Transport;
  private readonly streamTransport: StreamTransport;
  private tags: readonly TagEntry[] | undefined;
  private readonly shows = new Map<string, ShowInfo>();

  constructor(private readonly options: OllamaProviderOptions) {
    this.chatTimeoutMs = options.chatTimeoutMs ?? CHAT_TIMEOUT_MS;
    this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS;
    this.transport = options.transport ?? nodeTransport;
    this.streamTransport = options.streamTransport ?? nodeStreamTransport;
  }

  async generate(request: GenerationRequest, signal: AbortSignal): Promise<GenerationOutcome> {
    const snapshot = snapshotRequest(request); // before the first await
    ensureNotAborted(signal);
    const prepared = await this.prepare(snapshot.model, signal);
    const payload = chatPayload(snapshot, prepared, false);
    let data: unknown;
    try {
      data = await this.requestJson("POST", "/api/chat", payload, this.chatTimeoutMs, signal);
    } catch (error: unknown) {
      throw explainNotFound(error, prepared.entry.id);
    }
    const outcome = parseChatResponse(data);
    ensureNotAborted(signal); // before returning
    return outcome;
  }

  /**
   * Incremental `/api/chat` (`stream: true`). The request is captured now;
   * model discovery, checks and the network wait for the first `next()`. The
   * chat timeout is an idle deadline (connecting, headers and each wait for
   * body bytes), not a limit on the whole answer. A single consumer is assumed.
   */
  stream(request: GenerationRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const snapshot = snapshotRequest(request);
    return eventStream(
      signal,
      () =>
        new OllamaSource({
          begin: async (own) => {
            const prepared = await this.prepare(snapshot.model, own);
            return {
              url: `${this.options.baseUrl}/api/chat`,
              body: JSON.stringify(chatPayload(snapshot, prepared, true)),
              model: prepared.entry.id,
            };
          },
          transport: this.streamTransport,
          idleMs: this.chatTimeoutMs,
          signal,
          maxFrameBytes: this.options.maxFrameBytes ?? MAX_FRAME_BYTES,
        }),
    );
  }

  /** Installed local chat models in Ollama's order. */
  async listModels(signal: AbortSignal): Promise<readonly ModelInfo[]> {
    const tags = await this.discover(false, signal);
    return tags.map((entry) => entry.info).filter(isSelectable);
  }

  async checkAvailability(signal: AbortSignal): Promise<Availability> {
    try {
      const tags = await this.discover(true, signal);
      if (!tags.some((entry) => isSelectable(entry.info))) {
        return { available: false, message: NO_LOCAL_MODELS };
      }
    } catch (error: unknown) {
      if (error instanceof ProviderError) {
        return { available: false, message: error.message };
      }
      throw error;
    }
    return { available: true, message: "" };
  }

  /** The first selectable model in /api/tags order (not alphabetical). */
  async defaultModel(signal: AbortSignal): Promise<string> {
    const [first] = await this.listModels(signal);
    if (first === undefined) {
      throw new ProviderError(NO_LOCAL_MODELS, "api");
    }
    return first.id;
  }

  async getCapabilities(model: string, signal: AbortSignal): Promise<ModelCapabilities> {
    const { capabilities } = await this.prepare(model, signal);
    return capabilities;
  }

  // ----- discovery -----

  /** All tags entries, including remote ones. Failed or cancelled work never touches the cache. */
  private async discover(refresh: boolean, signal: AbortSignal): Promise<readonly TagEntry[]> {
    ensureNotAborted(signal);
    if (this.tags !== undefined && !refresh) {
      await Promise.resolve();
      ensureNotAborted(signal);
      return this.tags;
    }
    const data = await this.requestJson("GET", "/api/tags", undefined, this.discoveryTimeoutMs, signal);
    const parsed = parseTags(data);
    ensureNotAborted(signal); // before the cache write
    this.forgetStaleShows(parsed);
    this.tags = parsed;
    return parsed;
  }

  /** Cached show replies stay only for models whose tags entry is unchanged. */
  private forgetStaleShows(next: readonly TagEntry[]): void {
    const current = new Map(next.map((entry) => [entry.info.id, entry.fingerprint]));
    const previous = new Map((this.tags ?? []).map((entry) => [entry.info.id, entry.fingerprint]));
    for (const id of [...this.shows.keys()]) {
      if (current.get(id) === undefined || current.get(id) !== previous.get(id)) {
        this.shows.delete(id);
      }
    }
  }

  /**
   * Resolves a requested ID to an installed, local, chat-capable model (cloud
   * IDs are refused before any request) and derives its capabilities.
   */
  private async prepare(model: string, signal: AbortSignal): Promise<Prepared> {
    ensureNotAborted(signal);
    const shown = safeText(model);
    if (isCloudName(model)) {
      throw cloudError(shown);
    }
    let entry = findEntry(await this.discover(false, signal), model);
    entry ??= findEntry(await this.discover(true, signal), model); // maybe installed since
    if (entry === undefined) {
      throw new ProviderError(`Ollama model '${shown}' is not installed locally. ${pullHint(shown)}`, "api");
    }
    if (entry.remote) {
      throw cloudError(shown);
    }
    return { entry, capabilities: await this.capabilitiesOf(entry, signal) };
  }

  private async capabilitiesOf(entry: ModelInfo, signal: AbortSignal): Promise<ModelCapabilities> {
    requireChat(entry.id, entry.capabilities); // before any /api/show request
    const tagCapabilities = entry.capabilities;
    let support;
    if (tagCapabilities !== undefined && !tagCapabilities.includes("thinking")) {
      // Tags capabilities win when reported; nothing more is needed.
      support = reasoningSupport(tagCapabilities, undefined);
    } else {
      const show = await this.show(entry, signal);
      requireChat(entry.id, tagCapabilities ?? show.capabilities);
      support = reasoningSupport(tagCapabilities ?? show.capabilities, show);
    }
    // Project ceiling for num_predict: the context length from /api/tags, when reported.
    return { reasoning: support, ...(entry.contextLength === undefined ? {} : { maxOutputTokensLimit: entry.contextLength }) };
  }

  private async show(entry: ModelInfo, signal: AbortSignal): Promise<ShowInfo> {
    const cached = this.shows.get(entry.id);
    if (cached !== undefined) {
      await Promise.resolve();
      ensureNotAborted(signal);
      return cached;
    }
    const data = await this.requestJson("POST", "/api/show", { model: entry.id }, this.discoveryTimeoutMs, signal);
    const parsed = parseShow(data);
    ensureNotAborted(signal); // before the cache write
    this.shows.set(entry.id, parsed);
    return parsed;
  }

  // ----- transport -----

  private async requestJson(
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    ensureNotAborted(signal);
    let response;
    try {
      response = await this.transport({
        method,
        url: `${this.options.baseUrl}${path}`,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        timeoutMs,
        signal,
      });
    } catch (error: unknown) {
      if (signal.aborted) {
        throw createAbortError();
      }
      throw error;
    }
    ensureNotAborted(signal);
    if (response.status < 200 || response.status > 299) {
      throw new HttpStatusError(response.status, errorDetail(response.body));
    }
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw invalidResponse("reply is not valid JSON");
    }
  }
}

/** The `/api/chat` body, identical for both modes apart from `stream`. */
function chatPayload(snapshot: GenerationRequest, prepared: Prepared, stream: boolean): Record<string, unknown> {
  const think = thinkField(snapshot.reasoning.effort, snapshot.reasoning.explicit, prepared.capabilities.reasoning, snapshot.model);
  const messages = [
    ...(snapshot.instructions === undefined || snapshot.instructions === ""
      ? []
      : [{ role: "system", content: snapshot.instructions }]),
    ...snapshot.messages.map((message) => ({ role: message.role, content: message.content })),
  ];
  return {
    model: prepared.entry.id,
    messages,
    stream,
    ...(think === undefined ? {} : { think }),
    ...(snapshot.maxOutputTokens === undefined ? {} : { options: { num_predict: snapshot.maxOutputTokens } }),
  };
}

function findEntry(tags: readonly TagEntry[], id: string): ModelInfo | undefined {
  return tags.find((entry) => entry.info.id === id)?.info;
}

/** Confirmed capabilities without `completion` (e.g. embedding-only models) cannot chat. */
function requireChat(id: string, capabilities: readonly string[] | undefined): void {
  if (capabilities !== undefined && !capabilities.includes("completion")) {
    throw new ProviderError(`'${safeText(id)}' is not a chat model (it does not report text generation). Choose another model.`, "api");
  }
}

function cloudError(shownModel: string): ProviderError {
  return new ProviderError(
    `'${shownModel}' is an Ollama cloud model that runs on a remote service. Choose a local model.`,
    "api",
  );
}
