import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export type Responder = (request: RecordedRequest, response: ServerResponse, raw: IncomingMessage) => void;

/**
 * Loopback HTTP server for adapter tests. Every request is recorded; requests
 * that arrive when no responder is queued are recorded as unexpected and
 * answered with 599, so tests can assert that nothing unplanned happened.
 */
export class Loopback {
  readonly requests: RecordedRequest[] = [];
  readonly unexpected: RecordedRequest[] = [];
  url = "";
  private readonly queue: Responder[] = [];
  private readonly server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      this.requests.push(recorded);
      const responder = this.queue.shift();
      if (responder === undefined) {
        this.unexpected.push(recorded);
        res.statusCode = 599;
        res.end("unexpected request");
        return;
      }
      responder(recorded, res, req);
    });
  });

  static async start(): Promise<Loopback> {
    const loopback = new Loopback();
    await new Promise<void>((resolve, reject) => {
      loopback.server.once("error", reject);
      loopback.server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = loopback.server.address() as AddressInfo;
    loopback.url = `http://127.0.0.1:${String(port)}/v1`;
    return loopback;
  }

  /** `http://127.0.0.1:PORT` without the OpenAI-style path prefix. */
  get origin(): string {
    return new URL(this.url).origin;
  }

  /** Queues responders, one per expected request, in order. */
  expect(...responders: Responder[]): void {
    this.queue.push(...responders);
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Stops accepting connections and destroys open ones. */
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

export function json(status: number, body: unknown): Responder {
  return (_request, response) => {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  };
}

/** A minimal valid completed Responses API body. */
export function completedBody(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "gpt-6-luna",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    ...extra,
  };
}

/** One streamed reply as the server sees it. */
export interface ServerStream {
  /** Writes raw text/bytes and resolves once the socket accepted them. */
  write(chunk: string | Uint8Array): Promise<void>;
  end(): void;
  /** Drops the connection abruptly. */
  destroy(): void;
  /** Resolves when the client side went away (or the reply finished). */
  readonly closed: Promise<void>;
  readonly request: RecordedRequest;
}

/**
 * A responder that starts a streamed 200 reply and hands the open stream to
 * the test, which then decides when each byte is sent. Use `opened()` to wait
 * for the request to arrive.
 */
export function liveStream(contentType: string): { readonly responder: Responder; opened(): Promise<ServerStream> } {
  const waiting: ((stream: ServerStream) => void)[] = [];
  const ready: ServerStream[] = [];
  const responder: Responder = (request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", contentType);
    response.setHeader("cache-control", "no-cache");
    response.flushHeaders();
    const closed = new Promise<void>((resolve) => {
      response.once("close", resolve);
    });
    const stream: ServerStream = {
      request,
      closed,
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          response.write(chunk, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
      end: () => {
        response.end();
      },
      destroy: () => {
        response.destroy();
      },
    };
    const waiter = waiting.shift();
    if (waiter === undefined) ready.push(stream);
    else waiter(stream);
  };
  return {
    responder,
    opened: () => {
      const stream = ready.shift();
      return stream === undefined ? new Promise<ServerStream>((resolve) => waiting.push(resolve)) : Promise.resolve(stream);
    },
  };
}

/** A complete reply written at once (SSE or NDJSON), then ended. */
export function textReply(contentType: string, ...chunks: readonly (string | Uint8Array)[]): Responder {
  return (_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", contentType);
    for (const chunk of chunks) response.write(chunk);
    response.end();
  };
}

/** One Responses API server-sent event. */
export function sseEvent(type: string, fields: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

export const SSE = "text/event-stream";
export const NDJSON = "application/x-ndjson";
