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
