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
