/**
 * One JSON exchange over Node's built-in HTTP/HTTPS client.
 *
 * Each request uses a fresh, non-proxy agent, so HTTP_PROXY/HTTPS_PROXY/
 * ALL_PROXY/NODE_USE_ENV_PROXY and NO_PROXY never apply and nothing global is
 * touched. There are no redirects and no retries. One deadline covers
 * connecting, headers and the whole body. Every path releases the request,
 * socket, agent, timer and abort listener exactly once.
 */
import http from "node:http";
import https from "node:https";

import { ProviderError, createAbortError } from "../../domain/errors.js";

export interface HttpRequest {
  readonly method: "GET" | "POST";
  /** Absolute URL, already validated. */
  readonly url: string;
  /** JSON text for POST. */
  readonly body?: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

/** Larger replies are refused instead of buffered. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

function origin(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function connectionFailure(url: URL, error: unknown): ProviderError {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return new ProviderError(`Could not connect to Ollama at ${origin(url)}. Is the Ollama service running?`, "connection");
  }
  const safeCode = typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? ` (${code})` : "";
  return new ProviderError(`Connection to Ollama at ${origin(url)} failed${safeCode}.`, "connection");
}

export const nodeTransport: Transport = async (request) =>
  new Promise<HttpResponse>((resolve, reject) => {
    const { signal } = request;
    if (signal.aborted) {
      reject(createAbortError());
      return;
    }
    const url = new URL(request.url);
    const secure = url.protocol === "https:";
    const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
    const headers: Record<string, string> = { accept: "application/json" };
    if (request.body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(request.body));
    }
    let settled = false;

    const settle = (action: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      outgoing.destroy();
      agent.destroy();
      action();
    };
    const fail = (error: ProviderError): void => {
      // Cancellation wins over every other classification.
      settle(() => {
        reject(signal.aborted ? createAbortError() : error);
      });
    };
    function onAbort(): void {
      settle(() => {
        reject(createAbortError());
      });
    }

    const outgoing = (secure ? https : http).request(url, { method: request.method, agent, headers }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          fail(new ProviderError("Invalid response from Ollama: reply is too large.", "api"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", (error: Error) => {
        fail(connectionFailure(url, error));
      });
      response.on("close", () => {
        if (!response.complete) {
          fail(new ProviderError(`Connection to Ollama at ${origin(url)} ended before the reply was complete.`, "connection"));
          return;
        }
        settle(() => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
    });
    outgoing.on("error", (error: Error) => {
      fail(connectionFailure(url, error));
    });
    const timer = setTimeout(() => {
      fail(new ProviderError("Request to Ollama timed out.", "timeout"));
    }, request.timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    outgoing.end(request.body);
  });

// ----- streaming -----

export interface StreamRequest {
  /** Absolute URL, already validated; always a POST. */
  readonly url: string;
  /** JSON text. */
  readonly body: string;
  /** Aborting it destroys the connection, ends a pending `read()` and rejects an unfinished open. */
  readonly signal: AbortSignal;
}

/** An open reply whose body is read on demand, one chunk per `read()`. */
export interface StreamResponse {
  readonly status: number;
  /** The next body bytes, or `undefined` at a clean end. Rejects with AbortError after cancel/close, ProviderError (connection) otherwise. */
  read(): Promise<Uint8Array | undefined>;
  /** Destroys request, socket and agent now; idempotent; settles once released. */
  close(): Promise<void>;
}

/** Resolves once the response headers arrived. No timeout of its own: the caller's idle deadline aborts `signal`. */
export type StreamTransport = (request: StreamRequest) => Promise<StreamResponse>;

export const nodeStreamTransport: StreamTransport = async (request) =>
  new Promise<StreamResponse>((resolve, reject) => {
    const { signal } = request;
    if (signal.aborted) {
      reject(createAbortError());
      return;
    }
    const url = new URL(request.url);
    const secure = url.protocol === "https:";
    const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
    const headers = {
      accept: "application/x-ndjson, application/json",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(request.body)),
    };
    let incoming: http.IncomingMessage | undefined;
    let released = false;
    let failure: Error | undefined;
    let ended = false;
    let waiter: { readonly resolve: (chunk: Uint8Array | undefined) => void; readonly reject: (error: Error) => void } | undefined;
    const buffered: Buffer[] = [];
    let requestClosed = false;

    const outgoing = (secure ? https : http).request(url, { method: "POST", agent, headers });
    outgoing.once("close", () => {
      requestClosed = true;
    });

    const release = (): Promise<void> => {
      if (!released) {
        released = true;
        signal.removeEventListener("abort", onAbort);
        incoming?.destroy();
        outgoing.destroy();
        agent.destroy();
      }
      if (requestClosed) {
        return Promise.resolve();
      }
      return new Promise<void>((done) => {
        outgoing.once("close", () => {
          done();
        });
      });
    };
    const fail = (error: Error): void => {
      failure ??= signal.aborted ? createAbortError() : error;
      const pending = waiter;
      waiter = undefined;
      pending?.reject(failure);
    };
    function onAbort(): void {
      buffered.length = 0;
      fail(createAbortError());
      if (incoming === undefined) {
        reject(createAbortError()); // an unfinished open
      }
      void release();
    }
    const deliver = (): void => {
      const pending = waiter;
      if (pending === undefined) {
        return;
      }
      const chunk = buffered.shift();
      if (chunk !== undefined) {
        waiter = undefined;
        pending.resolve(chunk);
      } else if (failure !== undefined) {
        waiter = undefined;
        pending.reject(failure);
      } else if (ended) {
        waiter = undefined;
        pending.resolve(undefined);
      } else {
        incoming?.resume();
      }
    };

    outgoing.on("response", (response) => {
      incoming = response;
      response.pause();
      response.on("data", (chunk: Buffer) => {
        response.pause(); // one chunk at a time: the socket is read only while a pull waits
        buffered.push(chunk);
        deliver();
      });
      response.on("end", () => {
        ended = true;
        deliver();
      });
      response.on("error", (error: Error) => {
        fail(connectionFailure(url, error));
        deliver();
      });
      response.on("close", () => {
        if (!response.complete && !ended) {
          fail(new ProviderError(`Connection to Ollama at ${origin(url)} ended before the reply was complete.`, "connection"));
          deliver();
        }
      });
      resolve({
        status: response.statusCode ?? 0,
        read: () => {
          if (buffered.length > 0) {
            return Promise.resolve(buffered.shift());
          }
          if (failure !== undefined) {
            return Promise.reject(failure);
          }
          if (ended) {
            return Promise.resolve(undefined);
          }
          if (released) {
            return Promise.reject(createAbortError());
          }
          return new Promise<Uint8Array | undefined>((resolveRead, rejectRead) => {
            waiter = { resolve: resolveRead, reject: rejectRead };
            response.resume();
          });
        },
        close: () => {
          buffered.length = 0;
          failure ??= createAbortError();
          const pending = waiter;
          waiter = undefined;
          pending?.reject(failure);
          return release();
        },
      });
    });
    outgoing.on("error", (error: Error) => {
      if (incoming === undefined) {
        void release();
        reject(signal.aborted ? createAbortError() : connectionFailure(url, error));
      } else {
        fail(connectionFailure(url, error));
        deliver();
      }
    });
    signal.addEventListener("abort", onAbort, { once: true });
    outgoing.end(request.body);
  });
